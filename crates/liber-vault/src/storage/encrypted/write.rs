//! Writes (format §13.8): every save is a new ciphertext with a fresh salt,
//! streamed to a hidden temp file in the target's physical folder and renamed
//! into place. Nothing seeks into ciphertext. Renames and moves re-encrypt names
//! only: a file's content is moved, never rewritten, and a folder keeps its id,
//! so its children are untouched.

use super::names::{Cache, Entry, one_component, serves, side_file, side_owner};
use super::{EncryptedStorage, load, write};
use crate::error::{Result, VaultError, io_err};
use crate::path::VaultPath;
use crate::storage::plain::sync_dir;
use crate::storage::{NewFile, Replace};
use liber_crypto::{
    FolderId, NameCodec, ShortName, StreamWriter, Unlocked, shorten, strip_conflict,
};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

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
    /// A new long name's side file, written just before the rename.
    side: Option<ShortName>,
    create_only: bool,
    /// The logical path, for errors.
    path: String,
    /// The parent folder's canonical path, whose cached listing goes on commit.
    dir: String,
    cache: Arc<RwLock<Cache>>,
    /// Set by a failed `finish_or_keep`: the temp file stays for salvage.
    keep: bool,
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

    /// Durable, not only written: a recorder flushes every 2 s so a crash,
    /// even a power cut, keeps its complete chunks for salvage.
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()?;
        self.file.sync_data()
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

    /// The writer (and its file key) goes either way, inside `commit`.
    fn finish_or_keep(mut self: Box<Self>) -> Result<()> {
        let done = self.commit();
        self.keep = done.is_err();
        done
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
            let parent = self.target.parent().unwrap_or(Path::new("."));
            if let Some(side) = &self.side {
                write_side(parent, side)?;
            }
            std::fs::rename(&self.tmp, &self.target).inspect_err(|_| {
                if self.side.is_some() {
                    remove_side(&self.target);
                }
            })?;
            sync_dir(parent);
            Ok(())
        })()
        .map_err(|e| io_err(&*self.path, e))?;
        write(&self.cache).drop_listing(&self.dir);
        Ok(())
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        // Close it first: Windows can't delete an open file. After a commit the
        // temp name is gone and this does nothing.
        self.w = None;
        if !self.keep {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

fn invalid(path: &VaultPath, why: impl std::fmt::Display) -> VaultError {
    io_err(
        path.as_str(),
        std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("bad name: {why}")),
    )
}

/// The on-disk name for `name` in the folder `parent`: a folder's (`folder` is
/// its id) or a file's, under the current epoch's K_name. A long one comes with
/// the side file to write before the entry (format §14.5).
fn encode(
    u: &Unlocked,
    parent: &FolderId,
    name: &str,
    folder: Option<FolderId>,
    path: &VaultPath,
) -> Result<(String, Option<ShortName>)> {
    // A name a listing would refuse (`names::decode`) is refused here too.
    if !one_component(name) {
        return Err(invalid(path, "not a single name, or has a ':' or '\\'"));
    }
    let codec = NameCodec::new(&u.subkeys().name, u.vault_id(), u.epoch());
    let encoded = match folder {
        Some(id) => codec.encrypt_folder(parent, &id, name),
        None => codec.encrypt_file(parent, name),
    }
    .map_err(|e| invalid(path, e))?;
    Ok(match shorten(&encoded) {
        Some(short) => (short.on_disk.clone(), Some(short)),
        None => (encoded, None),
    })
}

/// Writes a long name's side file into the physical folder `parent`, via a temp
/// name. Called only once the entry's own name is known to be free, so what it
/// replaces is an orphan (a failed write's), never a listed entry's side file.
fn write_side(parent: &Path, short: &ShortName) -> std::io::Result<()> {
    let tmp = parent.join(temp_name());
    let r = (|| {
        let mut f = File::options().write(true).create_new(true).open(&tmp)?;
        f.write_all(short.side_contents.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, parent.join(&short.side_file))
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

/// The temp files ([`temp_name`]) in the physical folder `dir`, with their
/// sizes: what writes a crash interrupted left. Links are skipped.
pub(super) fn temp_files(dir: &Path) -> Vec<(PathBuf, u64)> {
    let Ok(items) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    items
        .flatten()
        .filter(|i| {
            let name = i.file_name();
            let name = name.to_string_lossy();
            name.starts_with('.') && name.ends_with(".liber-tmp")
        })
        .filter_map(|i| {
            let m = i.path().symlink_metadata().ok().filter(|m| m.is_file())?;
            Some((i.path(), m.len()))
        })
        .collect()
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

fn refuse_root(path: &VaultPath, what: &str) -> Result<()> {
    if path.is_root() {
        return Err(VaultError::OutsideVault(format!(
            "cannot {what} the vault root"
        )));
    }
    Ok(())
}

impl EncryptedStorage {
    fn target(&self, u: &Unlocked, path: &VaultPath) -> Result<Target> {
        refuse_root(path, "write")?;
        let parent = path.parent().unwrap_or_else(VaultPath::root);
        let not_found = || VaultError::NotFound(parent.to_string());
        let (dir, entry) = self.resolve(u, &parent)?.ok_or_else(not_found)?;
        let id = entry.folder.ok_or_else(not_found)?;
        let listing = load(u, &self.cache, &dir, &entry.physical, id)?.ok_or_else(not_found)?;
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
    /// It commits as `CreateOnly` unless `target` is `t`'s resolved entry: never
    /// replacing a file at a new name (an unreadable duplicate can share it).
    fn pending(
        &self,
        u: &Unlocked,
        path: &VaultPath,
        t: Target,
        target: PathBuf,
        side: Option<ShortName>,
        budget: u64,
    ) -> Result<Pending> {
        let create_only = t.existing.is_none();
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
            side,
            create_only,
            path: path.to_string(),
            dir: t.dir,
            cache: Arc::clone(&self.cache),
            keep: false,
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
        let mut p = self.with_write_keys(|u| {
            let t = self.target(u, path)?;
            let (target, side) = match &t.existing {
                Some(_) if mode == Replace::CreateOnly => {
                    return Err(VaultError::AlreadyExists(path.to_string()));
                }
                Some((_, e)) if e.folder.is_some() => {
                    return Err(VaultError::AlreadyExists(format!("{path} is a folder")));
                }
                // Onto the existing name, even a case-folded match or a conflict
                // copy: one atomic rename, and a long name's side file stays valid.
                Some((_, e)) => (e.physical.clone(), None),
                None => {
                    let (name, side) = encode(u, &t.id, &t.name, None, path)?;
                    (t.parent.join(name), side)
                }
            };
            self.pending(u, path, t, target, side, budget)
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

    /// [`Storage::create_new`](crate::Storage::create_new) whose temp file
    /// fails after `budget` bytes (a full disk, review I1).
    #[cfg(feature = "test-params")]
    pub fn create_new_failing(&self, path: &VaultPath, budget: u64) -> Result<Box<dyn NewFile>> {
        Ok(Box::new(self.new_file(path, budget)?))
    }

    pub(super) fn new_file(&self, path: &VaultPath, budget: u64) -> Result<Pending> {
        self.with_write_keys(|u| {
            let t = self.target(u, path)?;
            if t.existing.is_some() {
                return Err(VaultError::AlreadyExists(path.to_string()));
            }
            let (name, side) = encode(u, &t.id, &t.name, None, path)?;
            let target = t.parent.join(name);
            self.pending(u, path, t, target, side, budget)
        })
    }

    pub(super) fn make_dir(&self, path: &VaultPath) -> Result<()> {
        self.with_write_keys(|u| {
            let t = self.target(u, path)?;
            if t.existing.is_some() {
                return Err(VaultError::AlreadyExists(path.to_string()));
            }
            let (name, side) = encode(u, &t.id, &t.name, Some(FolderId::random()), path)?;
            let dst = t.parent.join(name);
            place(&t.parent, &dst, side.as_ref(), || std::fs::create_dir(&dst))
                .map_err(|e| io_err(path.as_str(), e))?;
            write(&self.cache).drop_listing(&t.dir);
            Ok(())
        })
    }

    /// `remove_file`, or `remove_empty_dir` when `dir`.
    pub(super) fn remove(&self, path: &VaultPath, dir: bool) -> Result<()> {
        refuse_root(path, "remove")?;
        self.with_write_keys(|u| {
            let (canon, e) = self
                .resolve(u, path)?
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
            .map_err(|err| match err.kind() {
                // Unreadable entries count: they are never deleted.
                std::io::ErrorKind::DirectoryNotEmpty => VaultError::NotEmpty(path.to_string()),
                _ => io_err(path.as_str(), err),
            })?;
            remove_side(&e.physical);
            write(&self.cache).forget(&canon);
            Ok(())
        })
    }

    /// Re-encrypts `from`'s name for `to` and moves the physical entry: content
    /// isn't rewritten, and a folder keeps its id (format §14.3).
    pub(super) fn move_entry(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        refuse_root(from, "rename")?;
        refuse_root(to, "rename")?;
        self.with_write_keys(|u| {
            let (canon, e) = self
                .resolve(u, from)?
                .ok_or_else(|| VaultError::NotFound(from.to_string()))?;
            let t = self.target(u, to)?;
            if let Some((name, there)) = &t.existing {
                // The one clash allowed: a case-only rename of the entry itself.
                if there.physical != e.physical || *name == t.name {
                    return Err(VaultError::AlreadyExists(to.to_string()));
                }
            }
            let (name, side) = encode(u, &t.id, &t.name, e.folder, to)?;
            let dst = t.parent.join(name);
            // `place` refuses a taken name: `rename` would silently replace a
            // file there (a duplicate name).
            place(&t.parent, &dst, side.as_ref(), || {
                std::fs::rename(&e.physical, &dst)
            })
            .map_err(|err| match err.kind() {
                std::io::ErrorKind::AlreadyExists => VaultError::AlreadyExists(to.to_string()),
                _ => io_err(from.as_str(), err),
            })?;
            remove_side(&e.physical);
            sync_dir(&t.parent);
            let mut cache = write(&self.cache);
            cache.forget(&canon);
            cache.drop_listing(&t.dir);
            Ok(())
        })
    }

    pub(super) fn trash(&self, path: &VaultPath) -> Result<()> {
        refuse_root(path, "trash")?;
        self.with_write_keys(|u| {
            let (canon, e) = self
                .resolve(u, path)?
                .ok_or_else(|| VaultError::NotFound(path.to_string()))?;
            let os_err = |err: trash::Error| VaultError::Io {
                path: path.to_string(),
                source: std::io::Error::other(err.to_string()),
            };
            // Neither the keys nor the cache is held here, only the write turn: it covers
            // the delete so `forget` lands before another write resolves this name through
            // a listing that still shows the entry.
            trash::delete(&e.physical).map_err(os_err)?;
            // The entry is gone: forget it whatever happens to the side file, which
            // is harmless if left (as in `remove_side`).
            write(&self.cache).forget(&canon);
            for side in unused_sides(&e.physical) {
                let _ = trash::delete(side);
            }
            Ok(())
        })
    }
}

/// Creates the new entry `dst` in the physical folder `parent` with `make`,
/// writing its long name's side file first so a listed entry always has one.
fn place(
    parent: &Path,
    dst: &Path,
    side: Option<&ShortName>,
    make: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<()> {
    // The side file only for a free name: never over a listed entry's.
    if dst.symlink_metadata().is_ok() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    if let Some(side) = side {
        write_side(parent, side)?;
    }
    make().inspect_err(|_| {
        if side.is_some() {
            remove_side(dst);
        }
    })
}

/// The side files the gone long-named entry `physical` read (its own, or for a
/// sync copy its original's too) that nothing left in its folder still reads.
fn unused_sides(physical: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(name)) = (
        physical.parent(),
        physical.file_name().and_then(|n| n.to_str()),
    ) else {
        return Vec::new();
    };
    // Unlistable: keep everything.
    let Ok(names) = std::fs::read_dir(dir).and_then(|d| {
        d.map(|e| Ok(e?.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<Vec<String>>>()
    }) else {
        return Vec::new();
    };
    let original = strip_conflict(name).map(|c| c.original);
    [Some(name), original.as_deref()]
        .into_iter()
        .flatten()
        .filter_map(|n| side_file(&dir.join(n)))
        .filter(|side| {
            let owner = side.file_name().and_then(|n| side_owner(n.to_str()?));
            side.symlink_metadata().is_ok()
                && owner.is_some_and(|o| !names.iter().any(|x| serves(x, &o)))
        })
        .collect()
}

/// A removed or moved long-named entry's side files go with it ([`unused_sides`]);
/// a leftover one is harmless, so failure is ignored.
fn remove_side(physical: &Path) {
    for side in unused_sides(physical) {
        let _ = std::fs::remove_file(side);
    }
}
