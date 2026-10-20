//! [`EncryptedStorage`] (E3): the vault as format v1 ciphertext (spec §4.1):
//! `liber-vault.json`, `README.txt`, and every logical entry under `d/` with an
//! encrypted name.

mod names;

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
use names::{Cache, Entry};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const HEADER_FILE: &str = "liber-vault.json";
const DATA_DIR: &str = "d";
const README_FILE: &str = "README.txt";
const README_TEXT: &str =
    "This folder is an encrypted Liber Linteum vault. Open it with Liber Linteum.";
/// Files the OS drops into any folder: `create` still counts the folder as empty.
const OS_FILES: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// Whether `root` holds an encrypted vault (its header file).
pub fn is_encrypted_vault(root: &Path) -> bool {
    root.join(HEADER_FILE).is_file()
}

#[derive(Debug)]
pub struct UnlockReport {
    pub vault_id: [u8; 16],
    pub epoch: u32,
    /// A header sync-conflict copy merged on unlock (E3 Task 5).
    pub merged: Option<MergeOutcome>,
}

struct Keys {
    /// Its `Secret`s zeroize on drop.
    unlocked: Unlocked,
}

pub struct EncryptedStorage {
    /// Canonical.
    root: PathBuf,
    /// `None` once locked.
    keys: Mutex<Option<Keys>>,
    header: Mutex<VaultHeader>,
    /// Decrypted names: dropped on lock with the keys.
    cache: Mutex<Cache>,
}

impl std::fmt::Debug for EncryptedStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedStorage")
            .field("root", &self.root)
            .field("locked", &self.is_locked())
            .finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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
    /// A new vault in the empty folder `root` (OS files like `.DS_Store` allowed).
    pub fn create(
        root: &Path,
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(EncryptedStorage, RecoveryCode)> {
        let root = canonical_root(root)?;
        for item in std::fs::read_dir(&root).map_err(|e| io_err(root.display().to_string(), e))? {
            let name = item
                .map_err(|e| io_err(root.display().to_string(), e))?
                .file_name();
            if !OS_FILES.iter().any(|f| name == *f) {
                return Err(VaultError::NotEmpty(root.display().to_string()));
            }
        }
        // Test builds may go below the Argon2 floor; real builds never do (plan ruling 2).
        #[cfg(feature = "test-params")]
        let made = VaultHeader::create_insecure(passphrase, params);
        #[cfg(not(feature = "test-params"))]
        let made = VaultHeader::create(passphrase, params);
        let (header, unlocked, code) = made.map_err(crypto)?;
        let bytes = header.to_bytes(&unlocked).map_err(crypto)?;
        std::fs::create_dir(root.join(DATA_DIR)).map_err(|e| io_err(DATA_DIR, e))?;
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
        let bytes = std::fs::read(root.join(HEADER_FILE)).map_err(|e| io_err(HEADER_FILE, e))?;
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
            keys: Mutex::new(Some(Keys { unlocked })),
            header: Mutex::new(header),
            cache: Mutex::new(Cache::default()),
        }
    }

    /// Drops the keys and every decrypted name; later calls fail with `Locked`.
    pub fn lock(&self) {
        *lock(&self.keys) = None;
        *lock(&self.cache) = Cache::default();
    }

    pub fn is_locked(&self) -> bool {
        lock(&self.keys).is_none()
    }

    pub fn vault_id(&self) -> [u8; 16] {
        lock(&self.header).vault_id().0
    }

    pub fn epoch(&self) -> u32 {
        lock(&self.header).epoch()
    }

    /// Runs `f` with the keys and the name cache, or fails with `Locked`.
    fn with_keys<T>(&self, f: impl FnOnce(&Unlocked, &mut Cache) -> Result<T>) -> Result<T> {
        let keys = lock(&self.keys);
        let keys = keys.as_ref().ok_or(VaultError::Locked)?;
        f(&keys.unlocked, &mut lock(&self.cache))
    }

    /// The entry at `path`, decrypting (and caching) each folder on the way.
    fn lookup(&self, u: &Unlocked, cache: &mut Cache, path: &VaultPath) -> Result<Option<Entry>> {
        let mut cur = Entry {
            physical: self.root.join(DATA_DIR),
            folder: Some(FolderId::ROOT),
        };
        let mut dir = String::new();
        for name in path.as_str().split('/').filter(|s| !s.is_empty()) {
            let Some(id) = cur.folder else {
                return Ok(None);
            };
            if !cache.listings.contains_key(&dir) {
                let listing = match names::list(u, &cur.physical, id) {
                    Ok(l) => l,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(e) => return Err(io_err(dir, e)),
                };
                cache.listings.insert(dir.clone(), listing);
            }
            let Some(next) = cache.listings[&dir].entries.get(name) else {
                return Ok(None);
            };
            cur = next.clone();
            if !dir.is_empty() {
                dir.push('/');
            }
            dir.push_str(name);
        }
        Ok(Some(cur))
    }

    /// `None` if the physical entry is gone.
    fn meta_of(&self, u: &Unlocked, cache: &mut Cache, entry: &Entry) -> Result<Option<Meta>> {
        let m = match entry.physical.symlink_metadata() {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_err(entry.physical.display().to_string(), e)),
        };
        let mtime = mtime_ns(&m);
        let (kind, len) = match entry.folder {
            Some(_) => (Kind::Dir, 0),
            None => (
                Kind::File,
                plain_len(u, cache, &entry.physical, mtime, m.len()),
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

/// A file's plaintext length, cached by its physical mtime and size. A file
/// whose content won't open lists as 0 bytes: reading it reports the damage.
fn plain_len(u: &Unlocked, cache: &mut Cache, physical: &Path, mtime: i128, size: u64) -> u64 {
    if let Some(&(t, s, len)) = cache.lens.get(physical)
        && (t, s) == (mtime, size)
    {
        return len;
    }
    let Some(len) = std::fs::File::open(physical)
        .ok()
        .and_then(|f| StreamReader::open(f, |e| u.content_key(e)).ok())
        .map(|r| r.len())
    else {
        return 0;
    };
    cache
        .lens
        .insert(physical.to_path_buf(), (mtime, size, len));
    len
}

/// Write methods arrive in E3 Task 2; until then they refuse.
fn not_yet(path: &VaultPath) -> VaultError {
    VaultError::Io {
        path: path.to_string(),
        source: std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "not yet supported in encrypted vaults",
        ),
    }
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
        self.with_keys(|u, cache| match self.lookup(u, cache, path)? {
            Some(entry) => self.meta_of(u, cache, &entry),
            None => Ok(None),
        })
    }

    fn children(&self, dir: &VaultPath) -> Result<Vec<Child>> {
        self.with_keys(|u, cache| {
            let not_found = || VaultError::NotFound(dir.to_string());
            let entry = self.lookup(u, cache, dir)?.ok_or_else(not_found)?;
            let id = entry.folder.ok_or_else(not_found)?;
            // Always re-read: a listing is how changes from elsewhere (sync) come in.
            let listing =
                names::list(u, &entry.physical, id).map_err(|e| io_err(dir.as_str(), e))?;
            let mut out = Vec::new();
            for (name, e) in &listing.entries {
                // Gone or unstattable since the listing: skipped silently, as `PlainStorage` does.
                if let Ok(Some(meta)) = self.meta_of(u, cache, e) {
                    out.push(Child::Entry {
                        name: name.clone(),
                        meta,
                    });
                }
            }
            out.extend(listing.unreadable.iter().cloned().map(Child::Unreadable));
            cache.listings.insert(dir.as_str().to_string(), listing);
            Ok(out)
        })
    }

    fn read(&self, path: &VaultPath) -> Result<Vec<u8>> {
        let mut r = self.open_read(path, Reach::Any)?;
        let mut out = Vec::with_capacity(usize::try_from(r.len).unwrap_or(0));
        r.inner
            .read_to_end(&mut out)
            .map_err(|e| content_err(path, e.into()))?;
        Ok(out)
    }

    fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader> {
        // A logical path is its own real location here: no links, no short names.
        if reach == Reach::Visible && crate::is_hidden_path(path.as_str()) {
            return Err(VaultError::OutsideVault(path.to_string()));
        }
        self.with_keys(|u, cache| {
            let entry = self
                .lookup(u, cache, path)?
                .ok_or_else(|| VaultError::NotFound(path.to_string()))?;
            if entry.folder.is_some() {
                return Err(VaultError::NotFound(format!("{path} is not a file")));
            }
            let file =
                std::fs::File::open(&entry.physical).map_err(|e| io_err(path.as_str(), e))?;
            let r =
                StreamReader::open(file, |e| u.content_key(e)).map_err(|e| content_err(path, e))?;
            Ok(Reader {
                len: r.len(),
                inner: Box::new(r),
            })
        })
    }

    fn replace_atomic(&self, path: &VaultPath, _from: &mut dyn Read, _mode: Replace) -> Result<()> {
        Err(not_yet(path))
    }

    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn NewFile>> {
        Err(not_yet(path))
    }

    fn create_dir(&self, path: &VaultPath) -> Result<()> {
        Err(not_yet(path))
    }

    fn remove_file(&self, path: &VaultPath) -> Result<()> {
        Err(not_yet(path))
    }

    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()> {
        Err(not_yet(path))
    }

    fn rename(&self, from: &VaultPath, _to: &VaultPath) -> Result<()> {
        Err(not_yet(from))
    }

    fn trash_os(&self, path: &VaultPath) -> Result<()> {
        Err(not_yet(path))
    }

    fn os_path(&self, path: &VaultPath, _use: OsUse) -> Result<PathBuf> {
        Err(not_yet(path))
    }

    /// No OS path names a logical entry: the physical names are ciphertext.
    fn vault_path_of(&self, _os: &Path) -> Option<VaultPath> {
        None
    }

    /// Same physical entry after name resolution (case folding: Task 2).
    fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool {
        self.with_keys(|u, cache| {
            Ok(
                match (self.lookup(u, cache, a)?, self.lookup(u, cache, b)?) {
                    (Some(x), Some(y)) => x.physical == y.physical,
                    _ => false,
                },
            )
        })
        .unwrap_or(false)
    }

    fn watch(&self, _recursive: bool, _sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard> {
        Err(VaultError::Watch(
            "not yet supported in encrypted vaults".into(),
        ))
    }
}
