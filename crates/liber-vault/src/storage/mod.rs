//! The storage seam (E2): every vault file access goes through [`Storage`],
//! so encrypted storage (E3) can replace [`PlainStorage`] behind `Vault`.
//! Every path crossing the trait is a [`VaultPath`], except `location`,
//! `os_path` and `vault_path_of`, which exist to talk to the OS.

pub(crate) mod encrypted;
pub(crate) mod plain;
mod plain_watch;

use crate::error::Result;
use crate::path::VaultPath;
use std::path::{Path, PathBuf};

pub use encrypted::{
    EncryptedStorage, HEADER_FILE, UnlockReport, VaultKind, is_encrypted_vault, trash_header_copy,
    vault_kind,
};
pub use plain::PlainStorage;

pub trait ReadSeek: std::io::Read + std::io::Seek + Send {}
impl<T: std::io::Read + std::io::Seek + Send> ReadSeek for T {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Other,
}

/// Whether [`Storage::meta`] follows a symlink: `InsideVault` follows one
/// whose real target is inside the vault and refuses any other with
/// `OutsideVault` (a dangling link included).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Follow {
    No,
    InsideVault,
}

/// What [`Storage::open_read`] may reach: `Visible` also refuses a path whose
/// real location is hidden (M4c review I4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Any,
    Visible,
}

/// What the OS path from [`Storage::os_path`] is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsUse {
    Open,
    /// Showing in the file manager: also refuses a hidden real location,
    /// as [`Reach::Visible`] (round 3 §9.4 review #6).
    Reveal,
    FileUrl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replace {
    CreateOnly,
    Overwrite,
}

/// `len` is the LOGICAL size (bytes a reader gets back); `mtime_ns` and
/// `created` are the PHYSICAL file's (E3: the ciphertext's — still changes
/// exactly when content changes, which is what incremental indexing needs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Meta {
    pub kind: Kind,
    pub len: u64,
    pub mtime_ns: i128,
    pub created: Option<std::time::SystemTime>,
}

/// A direct child of a folder, hidden names included; `Unreadable` carries
/// the exact message `scan` reports today ("<dir>: entry not readable (…)",
/// "<os path>: name is not UTF-8").
#[derive(Debug)]
pub enum Child {
    Entry { name: String, meta: Meta },
    Unreadable(String),
}

/// An open file: `len` is its logical size, `inner` reads and seeks within it.
pub struct Reader {
    pub len: u64,
    pub inner: Box<dyn ReadSeek>,
}

/// What a [`Storage::watch`] reports. A storage must send `Overflow` when
/// events may have been lost and for any change on the vault root itself;
/// `Vault` also treats a `Changed`/`Removed` on the root as `Overflow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawEvent {
    Changed(VaultPath),
    Removed(VaultPath),
    Overflow,
}

/// A file being written by [`Storage::create_new`].
///
/// - `flush()` is durability only: a recorder may flush periodically, and a
///   flush never ends the stream.
/// - `finish()` commits: only after it returns `Ok` is the file complete.
/// - Dropping without `finish` must not leave a complete-looking entry. E3
///   deletes its temp file; `PlainStorage` writes in place, so the bytes
///   written so far stay at the path and the caller removes them (import
///   does, on any write or finish error).
pub trait NewFile: std::io::Write + Send {
    fn finish(self: Box<Self>) -> Result<()>;
}

/// Keeps a [`Storage::watch`] running until dropped. Dropping it must also
/// drop the sink: `Vault`'s debounce thread exits only when the sink goes.
pub struct WatchGuard(
    /// Held only for its Drop, which stops the watch.
    pub Box<dyn Send>,
);

pub trait Storage: Send + Sync + std::fmt::Debug {
    /// `"plain"`: the test switch and diagnostics.
    fn name(&self) -> &'static str;
    /// The vault folder, for identity only (recent list, index, scratchpad).
    fn location(&self) -> &Path;
    /// `Ok(None)` when nothing is there.
    fn meta(&self, path: &VaultPath, follow: Follow) -> Result<Option<Meta>>;
    fn children(&self, dir: &VaultPath) -> Result<Vec<Child>>;
    fn read(&self, path: &VaultPath) -> Result<Vec<u8>>;
    /// A file only: anything else is `NotFound`.
    fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader>;
    fn replace_atomic(
        &self,
        path: &VaultPath,
        from: &mut dyn std::io::Read,
        mode: Replace,
    ) -> Result<()>;
    /// A new file streamed in order; `AlreadyExists` if `path` exists. Call
    /// [`NewFile::finish`] to commit it.
    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn NewFile>>;
    fn create_dir(&self, path: &VaultPath) -> Result<()>;
    fn remove_file(&self, path: &VaultPath) -> Result<()>;
    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()>;
    fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()>;
    fn trash_os(&self, path: &VaultPath) -> Result<()>;
    fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf>;
    fn vault_path_of(&self, os: &Path) -> Option<VaultPath>;
    /// Whether `a` and `b` name the same entry, e.g. `Notes` and `notes` on a
    /// case-insensitive file system; `false` if either is missing.
    fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool;
    /// Calls `sink` for each change until the returned guard is dropped,
    /// which must drop `sink` too (see [`WatchGuard`]). Lost events and
    /// changes on the vault root must reach `sink` as [`RawEvent::Overflow`].
    fn watch(&self, recursive: bool, sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard>;
    /// The encrypted storage behind this one, for what only it has (lock,
    /// salvage, unreadable entries): `None` for every other storage.
    fn as_encrypted(&self) -> Option<&EncryptedStorage> {
        None
    }
}

/// The storage `Vault::open` uses: `PlainStorage`, unless built with
/// `test-storage` (or `cfg(test)`) and `LIBER_TEST_STORAGE` names another.
/// Unknown names panic, so a typo can't silently test plain storage.
pub(crate) fn open_storage(root: &Path) -> Result<Box<dyn Storage>> {
    #[cfg(any(test, feature = "test-storage"))]
    if let Ok(name) = std::env::var("LIBER_TEST_STORAGE") {
        return storage_named(&name, root);
    }
    open_plain(root).map(|s| Box::new(s) as Box<dyn Storage>)
}

/// `PlainStorage`; an encrypted vault opens only by unlocking it (E4's Unlock
/// screen), and a damaged one never opens as plain.
fn open_plain(root: &Path) -> Result<PlainStorage> {
    use crate::error::VaultError;
    match vault_kind(root) {
        VaultKind::Plain => PlainStorage::open(root),
        VaultKind::Encrypted => Err(VaultError::Locked),
        VaultKind::Damaged(why) => Err(VaultError::Damaged(format!("{}: {why}", root.display()))),
    }
}

#[cfg(any(test, feature = "test-storage"))]
fn storage_named(name: &str, root: &Path) -> Result<Box<dyn Storage>> {
    Ok(match name {
        "plain" => Box::new(open_plain(root)?),
        "pass-through" => Box::new(PassThrough(open_plain(root)?)),
        #[cfg(feature = "test-params")]
        "encrypted" => Box::new(seal_in_place(root)?),
        #[cfg(not(feature = "test-params"))]
        "encrypted" => panic!("LIBER_TEST_STORAGE=encrypted needs liber-vault/test-params"),
        other => panic!(
            "LIBER_TEST_STORAGE={other:?}: expected \"plain\", \"pass-through\" or \"encrypted\""
        ),
    })
}

/// The passphrase of every vault [`seal_in_place`] makes.
#[cfg(feature = "test-params")]
pub const TEST_PASSPHRASE: &str = "liber-test-passphrase";

/// The `encrypted` test switch (E3, tests only): unlocks `root` if it is sealed
/// already; else moves the plaintext tree under it into a fresh encrypted vault
/// there ([`TEST_PASSPHRASE`], tiny Argon2 parameters) and unlocks that.
/// Symlinks and non-UTF-8 names are left out: an encrypted vault has neither.
/// Only under the system temp folder, so a committed fixture is never sealed.
#[cfg(feature = "test-params")]
pub fn seal_in_place(root: &Path) -> Result<EncryptedStorage> {
    use crate::error::io_err;
    use liber_crypto::{Argon2Params, FolderId, Unlock};
    match vault_kind(root) {
        VaultKind::Encrypted => {
            return Ok(EncryptedStorage::unlock(root, Unlock::Passphrase(TEST_PASSPHRASE))?.0);
        }
        VaultKind::Damaged(why) => {
            return Err(crate::error::VaultError::Damaged(format!(
                "{}: {why}",
                root.display()
            )));
        }
        VaultKind::Plain => {}
    }
    let canon = plain::canonical_root(root)?;
    let temp = plain::canonical_root(&std::env::temp_dir())?;
    assert!(
        canon.starts_with(&temp),
        "seal_in_place: {} is outside the temp folder",
        canon.display()
    );
    let hex: String = FolderId::random()
        .0
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let staging = temp.join(format!(".liber-seal-{hex}"));
    let err = |p: &Path, e| io_err(p.display().to_string(), e);
    std::fs::create_dir(&staging).map_err(|e| err(&staging, e))?;
    for item in std::fs::read_dir(&canon).map_err(|e| err(&canon, e))? {
        let name = item.map_err(|e| err(&canon, e))?.file_name();
        std::fs::rename(canon.join(&name), staging.join(&name)).map_err(|e| err(&canon, e))?;
    }
    let tiny = Argon2Params {
        m_kib: 64,
        t: 1,
        p: 1,
    };
    let (storage, _) = EncryptedStorage::create_insecure(&canon, TEST_PASSPHRASE, tiny)?;
    copy_in(&storage, &staging, &VaultPath::root())?;
    std::fs::remove_dir_all(&staging).map_err(|e| err(&staging, e))?;
    Ok(storage)
}

/// Writes the plaintext tree `from` into `to` at `at`.
#[cfg(feature = "test-params")]
fn copy_in(to: &EncryptedStorage, from: &Path, at: &VaultPath) -> Result<()> {
    use crate::error::io_err;
    let err = |e| io_err(from.display().to_string(), e);
    for item in std::fs::read_dir(from).map_err(err)? {
        let item = item.map_err(err)?;
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        let path = at.join(&name)?;
        let kind = item.file_type().map_err(err)?;
        if kind.is_dir() {
            to.create_dir(&path)?;
            copy_in(to, &item.path(), &path)?;
        } else if kind.is_file() {
            let mut file = std::fs::File::open(item.path()).map_err(err)?;
            to.replace_atomic(&path, &mut file, Replace::CreateOnly)?;
        }
    }
    Ok(())
}

/// A second `Storage` for the test switch: every method delegates to
/// `PlainStorage`, so a suite that passes on it doesn't depend on the
/// concrete type behind `Vault`. A smoke switch only: the real proof is
/// `LIBER_TEST_STORAGE=encrypted` in E3.
#[cfg(any(test, feature = "test-storage"))]
#[derive(Debug)]
pub struct PassThrough(PlainStorage);

#[cfg(any(test, feature = "test-storage"))]
impl Storage for PassThrough {
    fn name(&self) -> &'static str {
        "pass-through"
    }
    fn location(&self) -> &Path {
        self.0.location()
    }
    fn meta(&self, path: &VaultPath, follow: Follow) -> Result<Option<Meta>> {
        self.0.meta(path, follow)
    }
    fn children(&self, dir: &VaultPath) -> Result<Vec<Child>> {
        self.0.children(dir)
    }
    fn read(&self, path: &VaultPath) -> Result<Vec<u8>> {
        self.0.read(path)
    }
    fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader> {
        self.0.open_read(path, reach)
    }
    fn replace_atomic(
        &self,
        path: &VaultPath,
        from: &mut dyn std::io::Read,
        mode: Replace,
    ) -> Result<()> {
        self.0.replace_atomic(path, from, mode)
    }
    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn NewFile>> {
        self.0.create_new(path)
    }
    fn create_dir(&self, path: &VaultPath) -> Result<()> {
        self.0.create_dir(path)
    }
    fn remove_file(&self, path: &VaultPath) -> Result<()> {
        self.0.remove_file(path)
    }
    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()> {
        self.0.remove_empty_dir(path)
    }
    fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        self.0.rename(from, to)
    }
    fn trash_os(&self, path: &VaultPath) -> Result<()> {
        self.0.trash_os(path)
    }
    fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf> {
        self.0.os_path(path, use_)
    }
    fn vault_path_of(&self, os: &Path) -> Option<VaultPath> {
        self.0.vault_path_of(os)
    }
    fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool {
        self.0.same_entry(a, b)
    }
    fn watch(&self, recursive: bool, sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard> {
        self.0.watch(recursive, sink)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vault;

    // `unsafe_code` is forbidden, so no test sets the variable in-process:
    // the named switch is tested directly, and `Vault::open` against
    // whatever this run's `LIBER_TEST_STORAGE` says (unset: plain).
    #[test]
    fn test_switch_selects_pass_through() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            storage_named("pass-through", dir.path()).unwrap().name(),
            "pass-through"
        );
        assert_eq!(storage_named("plain", dir.path()).unwrap().name(), "plain");
        let want = std::env::var("LIBER_TEST_STORAGE").unwrap_or_else(|_| "plain".into());
        assert_eq!(Vault::open(dir.path()).unwrap().storage_name(), want);
    }

    #[cfg(feature = "test-params")]
    #[test]
    fn test_switch_seals_in_place() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("F")).unwrap();
        std::fs::write(dir.path().join("F/n.md"), "hello").unwrap();
        let note = VaultPath::new("F/n.md").unwrap();
        let s = storage_named("encrypted", dir.path()).unwrap();
        assert_eq!(s.name(), "encrypted");
        assert_eq!(s.read(&note).unwrap(), b"hello");
        drop(s);
        assert!(!dir.path().join("F").exists(), "no plaintext left");
        let plain = storage_named("plain", dir.path()).unwrap_err();
        assert!(matches!(plain, crate::VaultError::Locked), "{plain:?}");
        let again = storage_named("encrypted", dir.path()).unwrap();
        assert_eq!(again.read(&note).unwrap(), b"hello");
    }

    #[test]
    #[should_panic(expected = "LIBER_TEST_STORAGE")]
    fn test_switch_refuses_unknown_names() {
        let dir = tempfile::tempdir().unwrap();
        let _ = storage_named("passthrough", dir.path());
    }
}
