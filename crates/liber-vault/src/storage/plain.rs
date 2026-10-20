//! [`PlainStorage`]: the vault as plain files in a folder.

use super::{
    Child, Follow, Kind, Meta, NewFile, OsUse, RawEvent, Reach, Reader, Replace, Storage,
    WatchGuard,
};
use crate::error::{Result, VaultError, io_err};
use crate::path::VaultPath;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Suffix marker of in-flight atomic writes. Temp names start with `.` so scans
/// and watchers ignore them (VLT-05).
pub const TMP_MARKER: &str = ".liber-tmp-";

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

    /// [`Storage::replace_atomic`] that fails just before the rename (NFR-08 test).
    #[cfg(test)]
    pub(crate) fn replace_atomic_failing(
        &self,
        path: &VaultPath,
        from: &mut dyn Read,
        mode: Replace,
    ) -> Result<()> {
        replace_atomic(&self.root, path, from, mode, true)
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

/// Streams `from` into a hidden temp file next to `path`, then renames it into
/// place (NFR-08). An overwritten file keeps its permissions. `CreateOnly`:
/// `AlreadyExists` if `path` exists before or after the copy. `NotFound` if
/// its folder doesn't exist. The temp file is removed on any error.
pub(crate) fn replace_atomic(
    root: &Path,
    path: &VaultPath,
    from: &mut dyn Read,
    mode: Replace,
    fail_before_rename: bool,
) -> Result<()> {
    if path.is_root() {
        return Err(VaultError::OutsideVault(
            "cannot write the vault root".into(),
        ));
    }
    let target = resolve(root, path)?;
    let create_only = mode == Replace::CreateOnly;
    if create_only && target.symlink_metadata().is_ok() {
        return Err(VaultError::AlreadyExists(path.to_string()));
    }
    let parent = target.parent().expect("non-root path has a parent");
    if !parent.is_dir() {
        return Err(VaultError::NotFound(
            path.parent().map(|p| p.to_string()).unwrap_or_default(),
        ));
    }
    let existing = std::fs::metadata(&target).ok();
    let tmp = parent.join(format!(
        ".{}{}{}-{}",
        path.file_name(),
        TMP_MARKER,
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = from.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
        }
        out.sync_all()?;
        drop(out);
        if let Some(meta) = &existing {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        if fail_before_rename {
            return Err(std::io::Error::other("injected failure before rename"));
        }
        if create_only && target.symlink_metadata().is_ok() {
            return Err(std::io::ErrorKind::AlreadyExists.into());
        }
        std::fs::rename(&tmp, &target)?;
        sync_dir(parent);
        Ok(())
    })();
    result.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io_err(path.as_str(), e)
    })
}

/// Creates one folder; the parent must exist.
pub(crate) fn create_dir(root: &Path, path: &VaultPath) -> Result<()> {
    std::fs::create_dir(resolve(root, path)?).map_err(|e| io_err(path.as_str(), e))
}

/// Renames/moves a file or folder. Fails with `AlreadyExists` if `to` exists,
/// except case-only renames of the same entry on case-insensitive filesystems.
pub(crate) fn rename(root: &Path, from: &VaultPath, to: &VaultPath) -> Result<()> {
    if from.is_root() || to.is_root() {
        return Err(VaultError::OutsideVault(
            "cannot rename the vault root".into(),
        ));
    }
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    if src.symlink_metadata().is_err() {
        return Err(VaultError::NotFound(from.to_string()));
    }
    if !dst.parent().is_some_and(Path::is_dir) {
        return Err(VaultError::NotFound(
            to.parent().map(|p| p.to_string()).unwrap_or_default(),
        ));
    }
    if dst.symlink_metadata().is_ok() {
        if same_entry(&src, &dst) && from != to {
            // Case-only rename on a case-insensitive FS: go through a temp name.
            let tmp = src.with_file_name(format!(
                ".{}{}{}",
                from.file_name(),
                TMP_MARKER,
                TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::rename(&src, &tmp).map_err(|e| io_err(from.as_str(), e))?;
            return std::fs::rename(&tmp, &dst).map_err(|e| io_err(to.as_str(), e));
        }
        return Err(VaultError::AlreadyExists(to.to_string()));
    }
    std::fs::rename(&src, &dst).map_err(|e| io_err(from.as_str(), e))
}

/// Moves a file or folder to the OS trash (EXP-03).
pub(crate) fn trash(root: &Path, path: &VaultPath) -> Result<()> {
    if path.is_root() {
        return Err(VaultError::OutsideVault(
            "cannot trash the vault root".into(),
        ));
    }
    let full = resolve(root, path)?;
    if full.symlink_metadata().is_err() {
        return Err(VaultError::NotFound(path.to_string()));
    }
    trash::delete(&full).map_err(|e| VaultError::Io {
        path: path.to_string(),
        source: std::io::Error::other(e.to_string()),
    })
}

/// Written in place, with no fsync (import's speed, spec §10): `finish` only
/// flushes, and a dropped file keeps what was written (see [`NewFile`]).
impl NewFile for std::fs::File {
    fn finish(mut self: Box<Self>) -> Result<()> {
        self.flush().map_err(|e| io_err("new file", e))
    }
}

fn same_entry(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[cfg(unix)]
pub(crate) fn sync_dir(dir: &Path) {
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
pub(crate) fn sync_dir(_dir: &Path) {}

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
        // Windows can't open a folder (PermissionDenied); unix can, see below.
        let file = std::fs::File::open(&full).map_err(|e| {
            if full.is_dir() {
                VaultError::NotFound(format!("{path} is not a file"))
            } else {
                io_err(path.as_str(), e)
            }
        })?;
        let meta = file.metadata().map_err(|e| io_err(path.as_str(), e))?;
        if !meta.is_file() {
            return Err(VaultError::NotFound(format!("{path} is not a file")));
        }
        Ok(Reader {
            len: meta.len(),
            inner: Box::new(file),
        })
    }

    fn replace_atomic(&self, path: &VaultPath, from: &mut dyn Read, mode: Replace) -> Result<()> {
        replace_atomic(&self.root, path, from, mode, false)
    }

    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn NewFile>> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.resolve(path)?)
            .map_err(|e| io_err(path.as_str(), e))?;
        Ok(Box::new(file))
    }

    fn create_dir(&self, path: &VaultPath) -> Result<()> {
        create_dir(&self.root, path)
    }

    fn remove_file(&self, path: &VaultPath) -> Result<()> {
        std::fs::remove_file(self.resolve(path)?).map_err(|e| io_err(path.as_str(), e))
    }

    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()> {
        std::fs::remove_dir(self.resolve(path)?).map_err(|e| io_err(path.as_str(), e))
    }

    fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        rename(&self.root, from, to)
    }

    fn trash_os(&self, path: &VaultPath) -> Result<()> {
        trash(&self.root, path)
    }

    /// Plain files are their own OS path, whatever the use.
    fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf> {
        match use_ {
            OsUse::Reveal => self.resolve_visible(path),
            OsUse::Open | OsUse::FileUrl => self.resolve(path),
        }
    }

    fn vault_path_of(&self, os: &Path) -> Option<VaultPath> {
        VaultPath::from_fs_path(&self.root, os).ok()
    }

    fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool {
        match (self.resolve(a), self.resolve(b)) {
            (Ok(x), Ok(y)) => same_entry(&x, &y),
            _ => false,
        }
    }

    fn watch(&self, recursive: bool, sink: Box<dyn Fn(RawEvent) + Send>) -> Result<WatchGuard> {
        super::plain_watch::watch(&self.root, recursive, sink)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfr_08_injected_failure_leaves_target_untouched_and_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let storage = PlainStorage::open(dir.path()).unwrap();
        let p = VaultPath::new("a.md").unwrap();
        storage
            .replace_atomic(&p, &mut &b"original"[..], Replace::CreateOnly)
            .unwrap();
        let err = storage
            .replace_atomic_failing(&p, &mut &b"new content"[..], Replace::Overwrite)
            .unwrap_err();
        assert!(matches!(err, VaultError::Io { .. }));
        assert_eq!(std::fs::read(dir.path().join("a.md")).unwrap(), b"original");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["a.md".to_string()]);
    }
}
