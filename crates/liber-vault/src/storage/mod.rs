//! The storage seam (E2): every vault file access goes through [`Storage`],
//! so encrypted storage (E3) can replace [`PlainStorage`] behind `Vault`.
//! Every path crossing the trait is a [`VaultPath`], except `location`,
//! `os_path` and `vault_path_of`, which exist to talk to the OS.

pub(crate) mod plain;
mod plain_watch;

use crate::error::Result;
use crate::path::VaultPath;
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawEvent {
    Changed(VaultPath),
    Removed(VaultPath),
    Overflow,
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
    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn std::io::Write + Send>>;
    fn create_dir(&self, path: &VaultPath) -> Result<()>;
    fn remove_file(&self, path: &VaultPath) -> Result<()>;
    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()>;
    fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()>;
    fn trash_os(&self, path: &VaultPath) -> Result<()>;
    fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf>;
    fn vault_path_of(&self, os: &Path) -> Option<VaultPath>;
    /// Calls `sink` for each change until the returned guard is dropped,
    /// which must drop `sink` too (see [`WatchGuard`]).
    fn watch(&self, recursive: bool, sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard>;
}
