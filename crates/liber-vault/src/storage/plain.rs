//! [`PlainStorage`]: the vault as plain files in a folder.

use super::{
    Child, Follow, Kind, Meta, OsUse, RawEvent, Reach, Reader, Replace, Storage, WatchGuard,
};
use crate::error::{Result, VaultError, io_err};
use crate::path::VaultPath;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug)]
pub struct PlainStorage {
    /// Canonical.
    root: PathBuf,
}

impl PlainStorage {
    pub fn open(root: &Path) -> Result<PlainStorage> {
        Ok(PlainStorage {
            root: canonical_root(root)?,
        })
    }

    fn resolve(&self, path: &VaultPath) -> Result<PathBuf> {
        resolve(&self.root, path)
    }

    fn resolve_visible(&self, path: &VaultPath) -> Result<PathBuf> {
        resolve_visible(&self.root, path)
    }
}

/// `root` canonicalized, which must be a folder.
pub(crate) fn canonical_root(root: &Path) -> Result<PathBuf> {
    let root = dunce::canonicalize(root).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::NotFound(root.display().to_string()),
        _ => VaultError::Io {
            path: root.display().to_string(),
            source: e,
        },
    })?;
    if !root.is_dir() {
        return Err(VaultError::NotFound(format!(
            "{} is not a folder",
            root.display()
        )));
    }
    Ok(root)
}

/// Absolute path for `path`, refusing anything whose deepest existing
/// ancestor resolves (through symlinks) outside the vault.
pub(crate) fn resolve(root: &Path, path: &VaultPath) -> Result<PathBuf> {
    let full = path.to_fs_path(root);
    let mut probe = full.as_path();
    loop {
        if probe.symlink_metadata().is_ok() {
            let real = dunce::canonicalize(probe).map_err(|e| io_err(path.as_str(), e))?;
            if !real.starts_with(root) {
                return Err(VaultError::OutsideVault(path.to_string()));
            }
            return Ok(full);
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Ok(full),
        }
    }
}

/// [`resolve`] for a path the webview names, also refusing one whose real
/// location is hidden: a visible name can resolve into a hidden folder
/// through a symlink or, on Windows, an 8.3 short name (`SSH~1`). A missing
/// file is left to the read that follows.
pub(crate) fn resolve_visible(root: &Path, path: &VaultPath) -> Result<PathBuf> {
    let full = resolve(root, path)?;
    if full.symlink_metadata().is_err() {
        return Ok(full);
    }
    let real = dunce::canonicalize(&full).map_err(|e| io_err(path.as_str(), e))?;
    let inside = real
        .strip_prefix(root)
        .map_err(|_| VaultError::OutsideVault(path.to_string()))?;
    let parts: Option<Vec<&str>> = inside
        .components()
        .map(|c| c.as_os_str().to_str())
        .collect();
    if parts.is_none_or(|parts| crate::is_hidden_path(&parts.join("/"))) {
        return Err(VaultError::OutsideVault(path.to_string()));
    }
    Ok(full)
}

pub(crate) fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0)
}

fn to_meta(meta: &std::fs::Metadata) -> Meta {
    let ft = meta.file_type();
    let kind = if ft.is_symlink() {
        Kind::Symlink
    } else if ft.is_dir() {
        Kind::Dir
    } else if ft.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Meta {
        kind,
        // Only a file has bytes a reader gets back; `scan` reports 0 for a folder.
        len: if kind == Kind::File { meta.len() } else { 0 },
        mtime_ns: mtime_ns(meta),
        created: meta.created().ok(),
    }
}

impl Storage for PlainStorage {
    fn name(&self) -> &'static str {
        "plain"
    }

    fn location(&self) -> &Path {
        &self.root
    }

    fn meta(&self, path: &VaultPath, follow: Follow) -> Result<Option<Meta>> {
        let full = path.to_fs_path(&self.root);
        let lmeta = match full.symlink_metadata() {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_err(path.as_str(), e)),
        };
        if follow == Follow::No || !lmeta.file_type().is_symlink() {
            return Ok(Some(to_meta(&lmeta)));
        }
        // As `scan` today: a target that is outside, dangling or unreadable
        // is "a symlink pointing outside the vault".
        let outside = || VaultError::OutsideVault(path.to_string());
        let target = dunce::canonicalize(&full).map_err(|_| outside())?;
        if !target.starts_with(&self.root) {
            return Err(outside());
        }
        let meta = std::fs::metadata(&target).map_err(|_| outside())?;
        Ok(Some(to_meta(&meta)))
    }

    fn children(&self, dir: &VaultPath) -> Result<Vec<Child>> {
        let read =
            std::fs::read_dir(dir.to_fs_path(&self.root)).map_err(|e| io_err(dir.as_str(), e))?;
        let mut out = Vec::new();
        for item in read {
            let item = match item {
                Ok(item) => item,
                Err(e) => {
                    out.push(Child::Unreadable(format!(
                        "{dir}: entry not readable ({e})"
                    )));
                    continue;
                }
            };
            let Some(name) = item.file_name().to_str().map(str::to_owned) else {
                out.push(Child::Unreadable(format!(
                    "{}: name is not UTF-8",
                    item.path().display()
                )));
                continue;
            };
            // Gone since the listing: skipped silently, as `scan` does today.
            if let Ok(meta) = item.path().symlink_metadata() {
                out.push(Child::Entry {
                    name,
                    meta: to_meta(&meta),
                });
            }
        }
        Ok(out)
    }

    fn read(&self, path: &VaultPath) -> Result<Vec<u8>> {
        std::fs::read(self.resolve(path)?).map_err(|e| io_err(path.as_str(), e))
    }

    fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader> {
        let full = match reach {
            Reach::Any => self.resolve(path)?,
            Reach::Visible => self.resolve_visible(path)?,
        };
        let file = std::fs::File::open(full).map_err(|e| io_err(path.as_str(), e))?;
        let len = file.metadata().map_err(|e| io_err(path.as_str(), e))?.len();
        Ok(Reader {
            len,
            inner: Box::new(file),
        })
    }

    fn replace_atomic(
        &self,
        _path: &VaultPath,
        _from: &mut dyn std::io::Read,
        _mode: Replace,
    ) -> Result<()> {
        unimplemented!("E2 Task 2")
    }

    fn create_new(&self, _path: &VaultPath) -> Result<Box<dyn std::io::Write + Send>> {
        unimplemented!("E2 Task 2")
    }

    fn create_dir(&self, _path: &VaultPath) -> Result<()> {
        unimplemented!("E2 Task 2")
    }

    fn remove_file(&self, _path: &VaultPath) -> Result<()> {
        unimplemented!("E2 Task 2")
    }

    fn remove_empty_dir(&self, _path: &VaultPath) -> Result<()> {
        unimplemented!("E2 Task 2")
    }

    fn rename(&self, _from: &VaultPath, _to: &VaultPath) -> Result<()> {
        unimplemented!("E2 Task 2")
    }

    fn trash_os(&self, _path: &VaultPath) -> Result<()> {
        unimplemented!("E2 Task 2")
    }

    fn os_path(&self, _path: &VaultPath, _use_: OsUse) -> Result<PathBuf> {
        unimplemented!("E2 Task 2")
    }

    fn vault_path_of(&self, _os: &Path) -> Option<VaultPath> {
        unimplemented!("E2 Task 2")
    }

    fn watch(&self, _recursive: bool, _sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard> {
        unimplemented!("E2 Task 3")
    }
}
