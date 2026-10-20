//! Writes (format §13.8): every save is a new ciphertext with a fresh salt,
//! streamed to a hidden temp file in the target's physical folder and renamed
//! into place. Nothing seeks into ciphertext. Renames and moves re-encrypt names
//! only: a file's content is moved, never rewritten, and a folder keeps its id,
//! so its children are untouched.

use super::names::{Cache, Entry, side_file};
use super::{EncryptedStorage, load, lock};
use crate::error::{Result, VaultError, io_err};
use crate::path::VaultPath;
use crate::storage::plain::sync_dir;
use crate::storage::{NewFile, Replace};
use liber_crypto::{FolderId, LONG_NAME_LIMIT, NameCodec, StreamWriter, Unlocked};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Where a new entry `name` goes: its parent folder (canonical logical path,
/// physical folder, id), and what is already there under that name, case folded.
struct Target {
    dir: String,
    parent: PathBuf,
    id: FolderId,
    name: String,
    existing: Option<(String, Entry)>,
}

/// A file being encrypted into a temp name. [`Pending::commit`] renames it into
/// place; dropping it uncommitted deletes the temp file, so an incomplete stream
/// never appears as an entry.
pub(super) struct Pending {
    /// `None` once committed (or failed to).
    w: Option<StreamWriter<Sink>>,
    tmp: PathBuf,
    target: PathBuf,
    create_only: bool,
    /// The logical path, for errors.
    path: String,
    /// The parent folder's canonical path, whose cached listing goes on commit.
    dir: String,
    cache: Arc<Mutex<Cache>>,
}

/// The temp file. `budget` is how many more bytes it accepts: `u64::MAX`,
/// except in the injected save failure test (`replace_atomic_failing`).
struct Sink {
    file: File,
    budget: u64,
}

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() as u64 > self.budget {
            return Err(std::io::Error::other("injected write failure"));
        }
        let n = self.file.write(buf)?;
        self.budget -= n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

impl Write for Pending {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.writer()?.write(buf)
    }

    /// Never ends the stream (a recorder flushes periodically).
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer()?.flush()
    }
}

impl NewFile for Pending {
    fn finish(mut self: Box<Self>) -> Result<()> {
        self.commit()
    }
}

impl Pending {
    fn writer(&mut self) -> std::io::Result<&mut StreamWriter<Sink>> {
        self.w
            .as_mut()
            .ok_or_else(|| std::io::Error::other("file already committed"))
    }

    /// Ends the stream, syncs it, and renames it onto the target.
    fn commit(&mut self) -> Result<()> {
        let w = self
            .w
            .take()
            .ok_or_else(|| io_err(&*self.path, std::io::Error::other("file already committed")))?;
        (|| -> std::io::Result<()> {
            let sink = w.finish()?;
            sink.file.sync_all()?;
            drop(sink);
            if self.create_only && self.target.symlink_metadata().is_ok() {
                return Err(std::io::ErrorKind::AlreadyExists.into());
            }
            std::fs::rename(&self.tmp, &self.target)?;
            if let Some(parent) = self.target.parent() {
                sync_dir(parent);
            }
            Ok(())
        })()
        .map_err(|e| io_err(&*self.path, e))?;
        lock(&self.cache).listings.remove(&self.dir);
        Ok(())
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        // Close it first: Windows can't delete an open file. After a commit the
        // temp name is gone and this does nothing.
        self.w = None;
        let _ = std::fs::remove_file(&self.tmp);
    }
}

fn invalid(path: &VaultPath, why: impl std::fmt::Display) -> VaultError {
    io_err(
        path.as_str(),
        std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("bad name: {why}")),
    )
}

/// The on-disk name for `name` in the folder `parent`: a folder's (`folder` is
/// its id) or a file's, under the current epoch's K_name.
fn encode(
    u: &Unlocked,
    parent: &FolderId,
    name: &str,
    folder: Option<FolderId>,
    path: &VaultPath,
) -> Result<String> {
    let codec = NameCodec::new(&u.subkeys().name, u.vault_id(), u.epoch());
    let encoded = match folder {
        Some(id) => codec.encrypt_folder(parent, &id, name),
        None => codec.encrypt_file(parent, name),
    }
    .map_err(|e| invalid(path, e))?;
    // shortcut: long names (format §14.5) are refused until E3 Task 3 writes `.liberl`.
    if encoded.len() > LONG_NAME_LIMIT {
        return Err(invalid(path, "too long"));
    }
    Ok(encoded)
}

/// `.<32 random hex>.liber-tmp`: a leading `.`, so listings skip it.
fn temp_name() -> String {
    // FolderId::random is the crate's CSPRNG: 16 random bytes.
    let hex: String = FolderId::random()
        .0
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!(".{hex}.liber-tmp")
}

/// The canonical parent folder of a canonical path (`""` is the root).
fn parent_of(canon: &str) -> &str {
    canon.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// Drops what the cache knows of the entry `canon` after it moved or went: its
/// parent's listing and, for a folder, every listing under it.
fn forget(cache: &mut Cache, canon: &str) {
    cache.listings.remove(parent_of(canon));
    let below = format!("{canon}/");
    cache
        .listings
        .retain(|k, _| k != canon && !k.starts_with(&below));
}

fn refuse_root(path: &VaultPath, what: &str) -> Result<()> {
    if path.is_root() {
        return Err(VaultError::OutsideVault(format!(
            "cannot {what} the vault root"
        )));
    }
    Ok(())
}

impl EncryptedStorage {
    fn target(&self, u: &Unlocked, cache: &mut Cache, path: &VaultPath) -> Result<Target> {
        refuse_root(path, "write")?;
        let parent = path.parent().unwrap_or_else(VaultPath::root);
        let not_found = || VaultError::NotFound(parent.to_string());
        let (dir, entry) = self.resolve(u, cache, &parent)?.ok_or_else(not_found)?;
        let id = entry.folder.ok_or_else(not_found)?;
        let listing = load(u, cache, &dir, &entry.physical, id)?.ok_or_else(not_found)?;
        let name = path.file_name().to_string();
        let existing = listing.find(&name).map(|(n, e)| (n.to_string(), e.clone()));
        Ok(Target {
            dir,
            parent: entry.physical,
            id,
            name,
            existing,
        })
    }

    /// A temp file in `t`'s folder, its header already written, bound for `target`.
    fn pending(
        &self,
        u: &Unlocked,
        path: &VaultPath,
        t: Target,
        target: PathBuf,
        create_only: bool,
        budget: u64,
    ) -> Result<Pending> {
        let tmp = t.parent.join(temp_name());
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| io_err(path.as_str(), e))?;
        let mut p = Pending {
            w: None,
            tmp,
            target,
            create_only,
            path: path.to_string(),
            dir: t.dir,
            cache: Arc::clone(&self.cache),
        };
        // A fresh random salt (format §13.8); on error, dropping `p` removes the temp file.
        p.w = Some(
            StreamWriter::new(Sink { file, budget }, &u.subkeys().content, u.epoch())
                .map_err(|e| io_err(path.as_str(), e))?,
        );
        Ok(p)
    }

    /// `replace_atomic`, with the temp file failing after `budget` bytes.
    pub(super) fn replace_with(
        &self,
        path: &VaultPath,
        from: &mut dyn Read,
        mode: Replace,
        budget: u64,
    ) -> Result<()> {
        let mut p = self.with_keys(|u, cache| {
            let t = self.target(u, cache, path)?;
            let target = match &t.existing {
                Some(_) if mode == Replace::CreateOnly => {
                    return Err(VaultError::AlreadyExists(path.to_string()));
                }
                Some((_, e)) if e.folder.is_some() => {
                    return Err(VaultError::AlreadyExists(format!("{path} is a folder")));
                }
                // Onto the existing name, even a case-folded match: one atomic rename.
                Some((_, e)) => e.physical.clone(),
                None => t.parent.join(encode(u, &t.id, &t.name, None, path)?),
            };
            // No resolved entry: never replace a file at that name (an unreadable
            // duplicate can share it), so commit as `CreateOnly`.
            let create_only = mode == Replace::CreateOnly || t.existing.is_none();
            self.pending(u, path, t, target, create_only, budget)
        })?;
        // The keys aren't held while `from` streams: `p` has its own file key.
        std::io::copy(from, &mut p).map_err(|e| io_err(path.as_str(), e))?;
        p.commit()
    }

    /// [`Storage::replace_atomic`](crate::Storage::replace_atomic) whose temp
    /// file fails once the header and first chunk are written (review focus 1).
    #[cfg(feature = "test-params")]
    pub fn replace_atomic_failing(
        &self,
        path: &VaultPath,
        from: &mut dyn Read,
        mode: Replace,
    ) -> Result<()> {
        use liber_crypto::{CHUNK_LEN, HEADER_LEN, TAG_LEN};
        self.replace_with(path, from, mode, (HEADER_LEN + CHUNK_LEN + TAG_LEN) as u64)
    }

    pub(super) fn new_file(&self, path: &VaultPath) -> Result<Pending> {
        self.with_keys(|u, cache| {
            let t = self.target(u, cache, path)?;
            if t.existing.is_some() {
                return Err(VaultError::AlreadyExists(path.to_string()));
            }
            let target = t.parent.join(encode(u, &t.id, &t.name, None, path)?);
            self.pending(u, path, t, target, true, u64::MAX)
        })
    }

    pub(super) fn make_dir(&self, path: &VaultPath) -> Result<()> {
        self.with_keys(|u, cache| {
            let t = self.target(u, cache, path)?;
            if t.existing.is_some() {
                return Err(VaultError::AlreadyExists(path.to_string()));
            }
            let name = encode(u, &t.id, &t.name, Some(FolderId::random()), path)?;
            std::fs::create_dir(t.parent.join(name)).map_err(|e| io_err(path.as_str(), e))?;
            cache.listings.remove(&t.dir);
            Ok(())
        })
    }

    /// `remove_file`, or `remove_empty_dir` when `dir`.
    pub(super) fn remove(&self, path: &VaultPath, dir: bool) -> Result<()> {
        refuse_root(path, "remove")?;
        self.with_keys(|u, cache| {
            let (canon, e) = self
                .resolve(u, cache, path)?
                .ok_or_else(|| VaultError::NotFound(path.to_string()))?;
            if e.folder.is_some() != dir {
                let kind = if dir { "folder" } else { "file" };
                return Err(VaultError::NotFound(format!("{path} is not a {kind}")));
            }
            if dir {
                std::fs::remove_dir(&e.physical)
            } else {
                std::fs::remove_file(&e.physical)
            }
            .map_err(|err| io_err(path.as_str(), err))?;
            remove_side(&e.physical);
            forget(cache, &canon);
            Ok(())
        })
    }

    /// Re-encrypts `from`'s name for `to` and moves the physical entry: content
    /// isn't rewritten, and a folder keeps its id (format §14.3).
    pub(super) fn move_entry(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        refuse_root(from, "rename")?;
        refuse_root(to, "rename")?;
        self.with_keys(|u, cache| {
            let (canon, e) = self
                .resolve(u, cache, from)?
                .ok_or_else(|| VaultError::NotFound(from.to_string()))?;
            let t = self.target(u, cache, to)?;
            if let Some((name, there)) = &t.existing {
                // The one clash allowed: a case-only rename of the entry itself.
                if there.physical != e.physical || *name == t.name {
                    return Err(VaultError::AlreadyExists(to.to_string()));
                }
            }
            let dst = t.parent.join(encode(u, &t.id, &t.name, e.folder, to)?);
            // `rename` would silently replace a file there (a duplicate name).
            if dst.symlink_metadata().is_ok() {
                return Err(VaultError::AlreadyExists(to.to_string()));
            }
            std::fs::rename(&e.physical, &dst).map_err(|err| io_err(from.as_str(), err))?;
            remove_side(&e.physical);
            if let Some(parent) = dst.parent() {
                sync_dir(parent);
            }
            forget(cache, &canon);
            cache.listings.remove(&t.dir);
            Ok(())
        })
    }

    pub(super) fn trash(&self, path: &VaultPath) -> Result<()> {
        refuse_root(path, "trash")?;
        self.with_keys(|u, cache| {
            let (canon, e) = self
                .resolve(u, cache, path)?
                .ok_or_else(|| VaultError::NotFound(path.to_string()))?;
            let os_err = |err: trash::Error| VaultError::Io {
                path: path.to_string(),
                source: std::io::Error::other(err.to_string()),
            };
            trash::delete(&e.physical).map_err(os_err)?;
            // The entry is gone: forget it whatever happens to the side file, which
            // is harmless if left (as in `remove_side`).
            forget(cache, &canon);
            if let Some(side) = side_file(&e.physical).filter(|s| s.exists()) {
                let _ = trash::delete(side);
            }
            Ok(())
        })
    }
}

/// A removed or moved long-named entry's side file goes with it; a leftover one
/// is harmless, so failure is ignored.
fn remove_side(physical: &Path) {
    if let Some(side) = side_file(physical) {
        let _ = std::fs::remove_file(side);
    }
}
