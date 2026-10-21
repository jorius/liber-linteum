//! [`EncryptedStorage`] (E3): the vault as format v1 ciphertext (spec §4.1):
//! `liber-vault.json`, `README.txt`, and every logical entry under `d/` with an
//! encrypted name.

mod header;
mod names;
mod watch;
mod write;

pub use header::trash_header_copy;

use super::plain::{canonical_root, mtime_ns, replace_atomic};
use super::{
    Child, Follow, Kind, Meta, NewFile, OsUse, RawEvent, Reach, Reader, Replace, Storage,
    WatchGuard,
};
use crate::error::{Result, VaultError, io_err};
use crate::path::VaultPath;
use liber_crypto::{
    Argon2Params, CryptoError, FolderId, MergeOutcome, RecoveryCode, StreamReader, Unlock,
    Unlocked, VaultHeader,
};
use names::{Cache, Entry, Listing};
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub const HEADER_FILE: &str = "liber-vault.json";
const DATA_DIR: &str = "d";
const README_FILE: &str = "README.txt";
const README_TEXT: &str = "Encrypted Liber Linteum vault. Open it with Liber Linteum.";
/// Files the OS drops into any folder: `create` still counts the folder as empty.
const OS_FILES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// What a folder holds, judged from its top level (format §3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultKind {
    Plain,
    /// A header that parses, and its `d/` folder.
    Encrypted,
    /// Signs of an encrypted vault that can't be one: never opened as plain.
    Damaged(String),
}

/// A user's own `liber-vault.json`, or a folder named `d`, alone leave a vault plain.
pub fn vault_kind(root: &Path) -> VaultKind {
    let data = root.join(DATA_DIR);
    let has_data = data.symlink_metadata().is_ok_and(|m| m.is_dir());
    let header = root.join(HEADER_FILE);
    let parsed = header
        .symlink_metadata()
        .is_ok_and(|m| m.is_file())
        .then(|| {
            read_header(&header)
                .map_err(|e| e.to_string())
                .and_then(|b| VaultHeader::parse(&b).map_err(|e| e.to_string()))
        });
    match (parsed, has_data) {
        (Some(Ok(_)), true) => VaultKind::Encrypted,
        (Some(Ok(_)), false) => VaultKind::Damaged(format!("{DATA_DIR}/ folder missing")),
        (Some(Err(why)), true) => VaultKind::Damaged(format!("{HEADER_FILE} unreadable: {why}")),
        (None, true) if holds_ciphertext(&data) => {
            VaultKind::Damaged(format!("{HEADER_FILE} missing"))
        }
        _ => VaultKind::Plain,
    }
}

/// A header file's bytes, at most `liber_crypto::MAX_HEADER_BYTES` (the
/// format's limit): a longer one is never read whole, and is unparseable.
fn read_header(path: &Path) -> std::io::Result<Vec<u8>> {
    let max = liber_crypto::MAX_HEADER_BYTES;
    let mut bytes = Vec::new();
    File::open(path)?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("header over {max} bytes"),
        ));
    }
    Ok(bytes)
}

/// Whether `d/` holds encrypted files or long names at its top level (an
/// encrypted folder's name has no suffix, so a vault of only folders reads as plain).
fn holds_ciphertext(data: &Path) -> bool {
    std::fs::read_dir(data).is_ok_and(|items| {
        items.flatten().any(|i| {
            let name = i.file_name();
            let name = name.to_string_lossy();
            [".libere", ".liberl", ".libern"]
                .iter()
                .any(|ext| name.ends_with(ext))
        })
    })
}

/// Whether `root` holds an encrypted vault ([`vault_kind`]).
pub fn is_encrypted_vault(root: &Path) -> bool {
    vault_kind(root) == VaultKind::Encrypted
}

#[derive(Debug)]
pub struct UnlockReport {
    pub vault_id: [u8; 16],
    pub epoch: u32,
    /// Always `None` from `unlock`: the app merges header copies with
    /// [`EncryptedStorage::merge_header_copies`] after its rollback check.
    pub merged: Option<MergeOutcome>,
}

struct Keys {
    /// Its `Secret`s zeroize on drop.
    unlocked: Unlocked,
}

/// `None` once locked. Each call clones the `Arc` and lets go at once, so no
/// lock is held across I/O; a call in flight at `lock` finishes with its clone.
type KeyHolder = RwLock<Option<Arc<Keys>>>;

pub struct EncryptedStorage {
    /// Canonical.
    root: PathBuf,
    /// Shared with the watcher and with every open [`Reader`].
    keys: Arc<KeyHolder>,
    header: Mutex<VaultHeader>,
    /// Decrypted names: dropped on lock with the keys. Shared with the watcher
    /// and each file being written ([`write::Pending`]), which invalidates its
    /// folder on commit.
    cache: Arc<RwLock<Cache>>,
    /// Serializes writes, from a name's free-check to its placement; reads never take it.
    writing: Mutex<()>,
}

/// A watcher can outlive the storage holding the shared keys: clear them now.
impl Drop for EncryptedStorage {
    fn drop(&mut self) {
        self.lock();
    }
}

impl std::fmt::Debug for EncryptedStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `try_read`: formatting while `lock` holds the keys must not deadlock.
        let locked = match self.keys.try_read() {
            Ok(k) => format!("{}", k.is_none()),
            Err(std::sync::TryLockError::Poisoned(k)) => format!("{}", k.into_inner().is_none()),
            Err(std::sync::TryLockError::WouldBlock) => "busy".to_string(),
        };
        f.debug_struct("EncryptedStorage")
            .field("root", &self.root)
            .field("locked", &format_args!("{locked}"))
            .finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn read<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| e.into_inner())
}

fn write<T>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|e| e.into_inner())
}

fn crypto(e: CryptoError) -> VaultError {
    VaultError::Crypto(e.to_string())
}

/// A file's content failed: a torn file reads as `Authentication` too, so this
/// says "damaged or modified", never "tampered" (format §13.6).
fn content_err(path: &VaultPath, e: CryptoError) -> VaultError {
    match e {
        CryptoError::Io(e) => io_err(path.as_str(), e),
        CryptoError::Authentication | CryptoError::Truncated => {
            VaultError::Crypto(format!("{path}: damaged or modified ({e})"))
        }
        e => VaultError::Crypto(format!("{path}: {e}")),
    }
}

impl EncryptedStorage {
    /// A new vault in the empty folder `root`: OS files, and what a create
    /// that failed before its header left, are allowed. `params` must meet
    /// the Argon2 floor.
    pub fn create(
        root: &Path,
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(EncryptedStorage, RecoveryCode)> {
        Self::create_with(root, || VaultHeader::create(passphrase, params))
    }

    /// `create` below the Argon2 floor, for test fixtures only (plan ruling 2).
    #[cfg(feature = "test-params")]
    pub fn create_insecure(
        root: &Path,
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(EncryptedStorage, RecoveryCode)> {
        Self::create_with(root, || VaultHeader::create_insecure(passphrase, params))
    }

    fn create_with(
        root: &Path,
        make: impl FnOnce() -> liber_crypto::Result<(VaultHeader, Unlocked, RecoveryCode)>,
    ) -> Result<(EncryptedStorage, RecoveryCode)> {
        let root = canonical_root(root)?;
        refuse_non_empty(&root)?;
        let (header, unlocked, code) = make().map_err(crypto)?;
        let bytes = header.to_bytes(&unlocked).map_err(crypto)?;
        match std::fs::create_dir(root.join(DATA_DIR)) {
            // An empty `d/` from a create that failed earlier (`refuse_non_empty`).
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            other => other.map_err(|e| io_err(DATA_DIR, e))?,
        }
        std::fs::write(root.join(README_FILE), README_TEXT).map_err(|e| io_err(README_FILE, e))?;
        // Last: the header is what makes the folder a vault (`is_encrypted_vault`).
        replace_atomic(
            &root,
            &VaultPath::new(HEADER_FILE)?,
            &mut &bytes[..],
            Replace::CreateOnly,
            false,
        )?;
        Ok((Self::new(root, header, unlocked), code))
    }

    pub fn unlock(root: &Path, with: Unlock<'_>) -> Result<(EncryptedStorage, UnlockReport)> {
        let root = canonical_root(root)?;
        let bytes = read_header(&root.join(HEADER_FILE)).map_err(|e| io_err(HEADER_FILE, e))?;
        // Never follow a link out of the vault for its whole content tree.
        match root.join(DATA_DIR).symlink_metadata() {
            Ok(m) if m.is_dir() => {}
            Ok(m) if m.file_type().is_symlink() => {
                return Err(VaultError::OutsideVault(format!("{DATA_DIR}/ is a link")));
            }
            _ => return Err(VaultError::NotFound(format!("{DATA_DIR}/ folder"))),
        }
        let unlock_err = |e| match e {
            CryptoError::Authentication => VaultError::WrongSecret,
            e => crypto(e),
        };
        let header = VaultHeader::parse(&bytes).map_err(unlock_err)?;
        let unlocked = header.unlock(with).map_err(unlock_err)?;
        let report = UnlockReport {
            vault_id: header.vault_id().0,
            epoch: header.epoch(),
            merged: None,
        };
        Ok((Self::new(root, header, unlocked), report))
    }

    fn new(root: PathBuf, header: VaultHeader, unlocked: Unlocked) -> Self {
        EncryptedStorage {
            root,
            keys: Arc::new(RwLock::new(Some(Arc::new(Keys { unlocked })))),
            header: Mutex::new(header),
            cache: Arc::new(RwLock::new(Cache::default())),
            writing: Mutex::new(()),
        }
    }

    /// Drops the keys and every decrypted name; later calls fail with `Locked`.
    pub fn lock(&self) {
        *write(&self.keys) = None;
        write(&self.cache).close();
    }

    pub fn is_locked(&self) -> bool {
        read(&self.keys).is_none()
    }

    /// Physical paths whose names couldn't be read on the last listing, with
    /// the reason. Never deleted by any operation.
    pub fn unreadable(&self) -> Vec<(PathBuf, String)> {
        let all: Vec<_> = read(&self.cache)
            .unreadable
            .values()
            .flatten()
            .cloned()
            .collect();
        // A folder moved or removed since its listing leaves stale paths: skipped.
        all.into_iter()
            .filter(|(p, _)| p.symlink_metadata().is_ok())
            .collect()
    }

    pub fn vault_id(&self) -> [u8; 16] {
        lock(&self.header).vault_id().0
    }

    pub fn epoch(&self) -> u32 {
        lock(&self.header).epoch()
    }

    /// The complete chunks of the file at `path`, and whether it ended cleanly
    /// (format §13.7): for a recording a crash cut short. A file never
    /// committed exists only as a hidden temp file in its folder; the largest
    /// one is salvaged (a recording's folder streams one file).
    pub fn salvage(&self, path: &VaultPath) -> Result<(Vec<u8>, bool)> {
        let not_found = || VaultError::NotFound(path.to_string());
        self.with_keys(|u| {
            let physical = match self.lookup(u, path)? {
                Some(e) if e.folder.is_none() => e.physical,
                Some(_) => return Err(not_found()),
                None => {
                    let dir = path.parent().unwrap_or_else(VaultPath::root);
                    let folder = self.lookup(u, &dir)?.filter(|e| e.folder.is_some());
                    let temps = folder.map(|f| write::temp_files(&f.physical));
                    let largest = temps.into_iter().flatten().max_by_key(|(_, len)| *len);
                    largest.ok_or_else(not_found)?.0
                }
            };
            // As `open_read`: never a link, nor one swapped in before the open.
            let before = physical
                .symlink_metadata()
                .ok()
                .filter(Metadata::is_file)
                .ok_or_else(not_found)?;
            let file = File::open(&physical).map_err(|e| io_err(path.as_str(), e))?;
            let opened = file.metadata().map_err(|e| io_err(path.as_str(), e))?;
            if !same_file(&before, &opened) {
                return Err(not_found());
            }
            let mut s = liber_crypto::salvage(file, |e| u.content_key(e))
                .map_err(|e| content_err(path, e))?;
            Ok((std::mem::take(&mut *s.plaintext), s.complete))
        })
    }

    /// Deletes the hidden temp files writes a crash interrupted left in `dir`,
    /// so it can be removed once [`Self::salvage`] is done. Only for a folder
    /// no write is streaming into (a recording's, between takes).
    pub fn remove_temp_files(&self, dir: &VaultPath) -> Result<()> {
        self.with_write_keys(|u| {
            let entry = self.lookup(u, dir)?.filter(|e| e.folder.is_some());
            let entry = entry.ok_or_else(|| VaultError::NotFound(dir.to_string()))?;
            for (tmp, _) in write::temp_files(&entry.physical) {
                std::fs::remove_file(&tmp).map_err(|e| io_err(dir.as_str(), e))?;
            }
            Ok(())
        })
    }

    /// The keys, or `Locked`; the key lock itself is released at once.
    fn keys(&self) -> Result<Arc<Keys>> {
        read(&self.keys).clone().ok_or(VaultError::Locked)
    }

    /// Runs `f` with the keys, or fails with `Locked`.
    fn with_keys<T>(&self, f: impl FnOnce(&Unlocked) -> Result<T>) -> Result<T> {
        f(&self.keys()?.unlocked)
    }

    /// [`Self::with_keys`] for a write: one at a time.
    fn with_write_keys<T>(&self, f: impl FnOnce(&Unlocked) -> Result<T>) -> Result<T> {
        let _one = lock(&self.writing);
        self.with_keys(f)
    }

    /// The entry at `path`, decrypting (and caching) each folder on the way.
    fn lookup(&self, u: &Unlocked, path: &VaultPath) -> Result<Option<Entry>> {
        Ok(self.resolve(u, path)?.map(|(_, e)| e))
    }

    /// [`Self::lookup`], with the entry's canonical logical path: each name as
    /// stored, whatever its case in `path` (the cache's keys).
    fn resolve(&self, u: &Unlocked, path: &VaultPath) -> Result<Option<(String, Entry)>> {
        let mut cur = Entry {
            physical: self.root.join(DATA_DIR),
            folder: Some(FolderId::ROOT),
        };
        let mut dir = String::new();
        for name in path.as_str().split('/').filter(|s| !s.is_empty()) {
            let Some(id) = cur.folder else {
                return Ok(None);
            };
            let Some(listing) = load(u, &self.cache, &dir, &cur.physical, id)? else {
                return Ok(None);
            };
            let Some((real, next)) = listing.find(name) else {
                return Ok(None);
            };
            let next = next.clone();
            if !dir.is_empty() {
                dir.push('/');
            }
            dir.push_str(real);
            cur = next;
        }
        Ok(Some((dir, cur)))
    }

    /// `None` if the physical entry is gone.
    fn meta_of(&self, u: &Unlocked, entry: &Entry) -> Result<Option<Meta>> {
        let m = match entry.physical.symlink_metadata() {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_err(entry.physical.display().to_string(), e)),
        };
        // Never follow a link swapped in since the listing: it reads as gone.
        if !(m.is_dir() && entry.folder.is_some() || m.is_file() && entry.folder.is_none()) {
            return Ok(None);
        }
        let mtime = mtime_ns(&m);
        let (kind, len) = match entry.folder {
            Some(_) => (Kind::Dir, 0),
            None => (
                Kind::File,
                plain_len(u, &self.cache, &entry.physical, mtime, m.len()),
            ),
        };
        Ok(Some(Meta {
            kind,
            len,
            mtime_ns: mtime,
            created: m.created().ok(),
        }))
    }
}

/// The cached listing of the folder `dir` (canonical), read (with no lock held)
/// if absent; `None` if its physical folder is gone.
fn load(
    u: &Unlocked,
    cache: &RwLock<Cache>,
    dir: &str,
    physical: &Path,
    id: FolderId,
) -> Result<Option<Arc<Listing>>> {
    let since = {
        let c = read(cache);
        if let Some(l) = c.listings.get(dir) {
            return Ok(Some(Arc::clone(l)));
        }
        c.generation
    };
    let listing = match names::list(u, physical, id) {
        Ok(l) => Arc::new(l),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(dir, e)),
    };
    write(cache).insert(since, dir.to_string(), physical, Arc::clone(&listing));
    Ok(Some(listing))
}

/// Undoes a `create` in `root` whose vault never opened (E3 Task 5 review
/// I2): the folder was empty before, so its header, `README.txt` and `d/`
/// are all the create's own. The header goes first: the folder then stops
/// being a vault even if the rest can't be removed.
pub fn remove_new_vault(root: &Path) -> Result<()> {
    let err = |name: &str, e| io_err(name.to_string(), e);
    match std::fs::remove_file(root.join(HEADER_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(err(HEADER_FILE, e)),
        _ => {}
    }
    match std::fs::remove_file(root.join(README_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(err(README_FILE, e)),
        _ => {}
    }
    match std::fs::remove_dir_all(root.join(DATA_DIR)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(err(DATA_DIR, e)),
        _ => Ok(()),
    }
}

/// `create` accepts only an empty folder: OS files aside, it allows what a
/// create that failed before writing the header leaves (our own `README.txt`
/// and an empty `d/`), so that create can be retried.
fn refuse_non_empty(root: &Path) -> Result<()> {
    let leftover = |name: &std::ffi::OsStr| {
        let p = root.join(name);
        if name == README_FILE {
            p.symlink_metadata().is_ok_and(|m| m.is_file())
                && std::fs::read(&p).is_ok_and(|b| b == README_TEXT.as_bytes())
        } else if name == DATA_DIR {
            p.symlink_metadata().is_ok_and(|m| m.is_dir())
                && std::fs::read_dir(&p).is_ok_and(|mut d| d.next().is_none())
        } else {
            OS_FILES.iter().any(|f| name == *f)
        }
    };
    let err = |e| io_err(root.display().to_string(), e);
    for item in std::fs::read_dir(root).map_err(err)? {
        if !leftover(&item.map_err(err)?.file_name()) {
            return Err(VaultError::NotEmpty(root.display().to_string()));
        }
    }
    Ok(())
}

/// A file's plaintext length, cached by its physical mtime and size. A file
/// whose content won't open lists as 0 bytes: reading it reports the damage.
fn plain_len(u: &Unlocked, cache: &RwLock<Cache>, physical: &Path, mtime: i128, size: u64) -> u64 {
    let since = {
        let c = read(cache);
        if let Some(&(t, s, len)) = c.lens.get(physical)
            && (t, s) == (mtime, size)
        {
            return len;
        }
        c.generation
    };
    let Some(len) = File::open(physical)
        .ok()
        .and_then(|f| StreamReader::open(f, |e| u.content_key(e)).ok())
        .map(|r| r.len())
    else {
        return 0;
    };
    write(cache).insert_len(since, physical, (mtime, size, len));
    len
}

/// Whether the file opened is the one stat-ed before opening it (no swap in between).
#[cfg(unix)]
fn same_file(before: &Metadata, opened: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    (before.dev(), before.ino()) == (opened.dev(), opened.ino())
}

/// shortcut: no stable file index in std on Windows, so size and mtime stand in;
/// upgrade when `windows_by_handle` is stable.
#[cfg(not(unix))]
fn same_file(before: &Metadata, opened: &Metadata) -> bool {
    opened.is_file()
        && before.len() == opened.len()
        && before.modified().ok() == opened.modified().ok()
}

/// An open file's plaintext that ends with the keys: once the vault locks, the
/// next read or seek fails with `Locked` and the file's key is dropped.
struct KeyedReader {
    keys: Arc<KeyHolder>,
    inner: Option<StreamReader<File>>,
}

impl KeyedReader {
    fn live(&mut self) -> std::io::Result<&mut StreamReader<File>> {
        if read(&self.keys).is_none() {
            self.inner = None;
        }
        self.inner
            .as_mut()
            .ok_or_else(|| std::io::Error::other(VaultError::Locked))
    }
}

impl Read for KeyedReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.live()?.read(buf)
    }
}

impl Seek for KeyedReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.live()?.seek(pos)
    }
}

/// `Locked` if a read failed because the vault locked under it ([`KeyedReader`]).
fn locked_read(e: &std::io::Error) -> bool {
    e.get_ref()
        .and_then(|e| e.downcast_ref::<VaultError>())
        .is_some_and(|e| matches!(e, VaultError::Locked))
}

impl Storage for EncryptedStorage {
    fn name(&self) -> &'static str {
        "encrypted"
    }

    fn location(&self) -> &Path {
        &self.root
    }

    fn as_encrypted(&self) -> Option<&EncryptedStorage> {
        Some(self)
    }

    /// No symlinks in an encrypted vault: `follow` changes nothing.
    fn meta(&self, path: &VaultPath, _follow: Follow) -> Result<Option<Meta>> {
        self.with_keys(|u| match self.lookup(u, path)? {
            Some(entry) => self.meta_of(u, &entry),
            None => Ok(None),
        })
    }

    fn children(&self, dir: &VaultPath) -> Result<Vec<Child>> {
        self.with_keys(|u| {
            let not_found = || VaultError::NotFound(dir.to_string());
            let (canon, entry) = self.resolve(u, dir)?.ok_or_else(not_found)?;
            let id = entry.folder.ok_or_else(not_found)?;
            let since = read(&self.cache).generation;
            // Always re-read: a listing is how changes from elsewhere (sync) come in.
            let listing =
                names::list(u, &entry.physical, id).map_err(|e| io_err(dir.as_str(), e))?;
            let mut out = Vec::new();
            for (name, e) in &listing.entries {
                // Gone or unstattable since the listing: skipped silently, as `PlainStorage` does.
                if let Ok(Some(meta)) = self.meta_of(u, e) {
                    out.push(Child::Entry {
                        name: name.clone(),
                        meta,
                    });
                }
            }
            out.extend(listing.unreadable.iter().map(|(p, reason)| {
                Child::Unreadable(format!(
                    "{}: couldn't read the name ({reason})",
                    p.display()
                ))
            }));
            write(&self.cache).insert(since, canon, &entry.physical, Arc::new(listing));
            Ok(out)
        })
    }

    fn read(&self, path: &VaultPath) -> Result<Vec<u8>> {
        let mut r = self.open_read(path, Reach::Any)?;
        let mut out = Vec::with_capacity(usize::try_from(r.len).unwrap_or(0));
        r.inner.read_to_end(&mut out).map_err(|e| {
            if locked_read(&e) {
                VaultError::Locked
            } else {
                content_err(path, e.into())
            }
        })?;
        Ok(out)
    }

    fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader> {
        // A logical path is its own real location here: no links, no short names.
        if reach == Reach::Visible && crate::is_hidden_path(path.as_str()) {
            return Err(VaultError::OutsideVault(path.to_string()));
        }
        self.with_keys(|u| {
            let entry = self
                .lookup(u, path)?
                .ok_or_else(|| VaultError::NotFound(path.to_string()))?;
            let not_file = || VaultError::NotFound(format!("{path} is not a file"));
            if entry.folder.is_some() {
                return Err(not_file());
            }
            // Never follow a link swapped in since the listing, nor one swapped
            // in between this check and the open.
            let before = entry
                .physical
                .symlink_metadata()
                .ok()
                .filter(Metadata::is_file)
                .ok_or_else(not_file)?;
            let file = File::open(&entry.physical).map_err(|e| io_err(path.as_str(), e))?;
            let opened = file.metadata().map_err(|e| io_err(path.as_str(), e))?;
            if !same_file(&before, &opened) {
                return Err(not_file());
            }
            let r =
                StreamReader::open(file, |e| u.content_key(e)).map_err(|e| content_err(path, e))?;
            Ok(Reader {
                len: r.len(),
                inner: Box::new(KeyedReader {
                    keys: Arc::clone(&self.keys),
                    inner: Some(r),
                }),
            })
        })
    }

    fn replace_atomic(&self, path: &VaultPath, from: &mut dyn Read, mode: Replace) -> Result<()> {
        self.replace_with(path, from, mode, u64::MAX)
    }

    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn NewFile>> {
        Ok(Box::new(self.new_file(path)?))
    }

    fn create_dir(&self, path: &VaultPath) -> Result<()> {
        self.make_dir(path)
    }

    fn remove_file(&self, path: &VaultPath) -> Result<()> {
        self.remove(path, false)
    }

    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()> {
        self.remove(path, true)
    }

    fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        self.move_entry(from, to)
    }

    /// The OS trash gets the ciphertext entry (and its side file), never plaintext.
    fn trash_os(&self, path: &VaultPath) -> Result<()> {
        self.trash(path)
    }

    /// No OS path holds plaintext: the app layer offers a decrypted copy for `Open`.
    fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf> {
        Err(VaultError::NotPermitted(match use_ {
            OsUse::Open => "decrypted copy needed".into(),
            OsUse::Reveal | OsUse::FileUrl => format!("{path}: no OS path in an encrypted vault"),
        }))
    }

    /// No OS path names a logical entry: the physical names are ciphertext.
    fn vault_path_of(&self, _os: &Path) -> Option<VaultPath> {
        None
    }

    /// Same physical entry after name resolution, which folds case.
    fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool {
        self.with_keys(|u| {
            Ok(match (self.lookup(u, a)?, self.lookup(u, b)?) {
                (Some(x), Some(y)) => x.physical == y.physical,
                _ => false,
            })
        })
        .unwrap_or(false)
    }

    fn watch(&self, recursive: bool, sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard> {
        watch::watch(self, recursive, sink)
    }
}

#[cfg(all(test, feature = "test-params"))]
mod tests {
    use super::*;

    #[test]
    fn debug_never_blocks_on_the_keys() {
        let dir = tempfile::tempdir().unwrap();
        let tiny = Argon2Params {
            m_kib: 64,
            t: 1,
            p: 1,
        };
        let (s, _) = EncryptedStorage::create_insecure(dir.path(), "pw", tiny).unwrap();
        assert!(format!("{s:?}").contains("locked: false"));
        let held = write(&s.keys);
        assert!(format!("{s:?}").contains("locked: busy"));
        drop(held);
        s.lock();
        assert!(format!("{s:?}").contains("locked: true"));
    }
}
