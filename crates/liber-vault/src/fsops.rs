use crate::error::{Result, VaultError, io_err};
use crate::hash::Hash;
use crate::path::VaultPath;
use crate::vault::Vault;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Suffix marker of in-flight atomic writes. Temp names start with `.` so scans
/// and watchers ignore them (VLT-05).
pub const TMP_MARKER: &str = ".liber-tmp-";

impl Vault {
    /// Absolute path for `path`, refusing anything whose deepest existing
    /// ancestor resolves (through symlinks) outside the vault.
    pub fn fs_path(&self, path: &VaultPath) -> Result<PathBuf> {
        let full = path.to_fs_path(&self.root);
        let mut probe = full.as_path();
        loop {
            if probe.symlink_metadata().is_ok() {
                let real = dunce::canonicalize(probe).map_err(|e| io_err(path.as_str(), e))?;
                if !real.starts_with(&self.root) {
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

    /// [`Vault::fs_path`] for a path the webview names, also refusing one
    /// whose real location is hidden: a visible name can resolve into a
    /// hidden folder through a symlink or, on Windows, an 8.3 short name
    /// (`SSH~1`). A missing file is left to the read that follows.
    pub fn visible_fs_path(&self, path: &VaultPath) -> Result<PathBuf> {
        let full = self.fs_path(path)?;
        if full.symlink_metadata().is_err() {
            return Ok(full);
        }
        let real = dunce::canonicalize(&full).map_err(|e| io_err(path.as_str(), e))?;
        let inside = real
            .strip_prefix(&self.root)
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

    pub fn read(&self, path: &VaultPath) -> Result<(Vec<u8>, Hash)> {
        let bytes = std::fs::read(self.fs_path(path)?).map_err(|e| io_err(path.as_str(), e))?;
        let hash = Hash::of(&bytes);
        Ok((bytes, hash))
    }

    pub fn read_to_string(&self, path: &VaultPath) -> Result<(String, Hash)> {
        let (bytes, hash) = self.read(path)?;
        let text = String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8(path.to_string()))?;
        Ok((text, hash))
    }

    /// Atomic compare-and-swap write (NFR-08).
    /// `expected = Some(h)`: the file must exist with hash `h`, else `Conflict`/`NotFound`.
    /// `expected = None`: create-only, `AlreadyExists` if the path exists.
    pub fn write_cas(
        &self,
        path: &VaultPath,
        content: &[u8],
        expected: Option<Hash>,
    ) -> Result<Hash> {
        self.write_cas_inner(path, content, expected, false)
    }

    pub(crate) fn write_cas_inner(
        &self,
        path: &VaultPath,
        content: &[u8],
        expected: Option<Hash>,
        fail_before_rename: bool,
    ) -> Result<Hash> {
        if path.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot write the vault root".into(),
            ));
        }
        let target = self.fs_path(path)?;
        let existing = match std::fs::read(&target) {
            Ok(bytes) => Some((Hash::of(&bytes), std::fs::metadata(&target).ok())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_err(path.as_str(), e)),
        };
        match (&expected, &existing) {
            (None, Some(_)) => return Err(VaultError::AlreadyExists(path.to_string())),
            (Some(_), None) => return Err(VaultError::NotFound(path.to_string())),
            (Some(want), Some((current, _))) if want != current => {
                return Err(VaultError::Conflict {
                    path: path.to_string(),
                    current: *current,
                });
            }
            _ => {}
        }
        let parent = target.parent().expect("non-root path has a parent");
        if !parent.is_dir() {
            return Err(VaultError::NotFound(
                path.parent().map(|p| p.to_string()).unwrap_or_default(),
            ));
        }
        let tmp = parent.join(format!(
            ".{}{}{}-{}",
            path.file_name(),
            TMP_MARKER,
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            file.write_all(content)?;
            file.sync_all()?;
            drop(file);
            if let Some((_, Some(meta))) = &existing {
                std::fs::set_permissions(&tmp, meta.permissions())?;
            }
            if fail_before_rename {
                return Err(std::io::Error::other("injected failure before rename"));
            }
            std::fs::rename(&tmp, &target)?;
            sync_dir(parent);
            Ok(())
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_file(&tmp);
            return Err(VaultError::Io {
                path: path.to_string(),
                source: e,
            });
        }
        Ok(Hash::of(content))
    }

    /// Creates `dir` and any missing parents; returns the folders it created,
    /// outermost first. An existing non-folder on the way is `AlreadyExists`.
    pub fn create_dir_all(&self, dir: &VaultPath) -> Result<Vec<VaultPath>> {
        let mut created = Vec::new();
        if dir.is_root() {
            return Ok(created);
        }
        let mut current = VaultPath::root();
        for part in dir.as_str().split('/') {
            current = current.join(part)?;
            let full = self.fs_path(&current)?;
            match full.metadata() {
                Ok(meta) if meta.is_dir() => continue,
                Ok(_) => return Err(VaultError::AlreadyExists(current.to_string())),
                Err(_) => {
                    std::fs::create_dir(&full).map_err(|e| io_err(current.as_str(), e))?;
                    created.push(current.clone());
                }
            }
        }
        Ok(created)
    }

    /// Copies the outside file `src` to `dest`, streamed through a hidden temp
    /// file and renamed into place (M2c §7.1). Create-only: `AlreadyExists` if
    /// `dest` exists, `NotFound` if its folder doesn't.
    pub fn import_file(&self, src: &Path, dest: &VaultPath) -> Result<Hash> {
        if dest.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot write the vault root".into(),
            ));
        }
        let target = self.fs_path(dest)?;
        if target.symlink_metadata().is_ok() {
            return Err(VaultError::AlreadyExists(dest.to_string()));
        }
        let parent = target.parent().expect("non-root path has a parent");
        if !parent.is_dir() {
            return Err(VaultError::NotFound(
                dest.parent().map(|p| p.to_string()).unwrap_or_default(),
            ));
        }
        let tmp = parent.join(format!(
            ".{}{}{}-{}",
            dest.file_name(),
            TMP_MARKER,
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| -> std::io::Result<Hash> {
            let mut input = std::fs::File::open(src)?;
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            let mut hasher = blake3::Hasher::new();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = input.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n])?;
            }
            out.sync_all()?;
            drop(out);
            if target.symlink_metadata().is_ok() {
                return Err(std::io::ErrorKind::AlreadyExists.into());
            }
            std::fs::rename(&tmp, &target)?;
            sync_dir(parent);
            Ok(Hash::from_bytes(*hasher.finalize().as_bytes()))
        })();
        result.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            io_err(dest.as_str(), e)
        })
    }

    /// Creates one folder; the parent must exist.
    pub fn create_dir(&self, path: &VaultPath) -> Result<()> {
        std::fs::create_dir(self.fs_path(path)?).map_err(|e| io_err(path.as_str(), e))
    }

    /// Renames/moves a file or folder. Fails with `AlreadyExists` if `to` exists,
    /// except case-only renames of the same entry on case-insensitive filesystems.
    pub fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        if from.is_root() || to.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot rename the vault root".into(),
            ));
        }
        let src = self.fs_path(from)?;
        let dst = self.fs_path(to)?;
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

    /// The child of `dir` named `name`, or failing that one whose name only
    /// differs in letter case or Unicode form (round 3 §9). Exact wins.
    pub fn child_named(&self, dir: &VaultPath, name: &str) -> Result<Option<VaultPath>> {
        let full = self.fs_path(dir)?;
        let entries = match std::fs::read_dir(&full) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_err(dir.as_str(), e)),
        };
        let names: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .collect();
        let found = names
            .iter()
            .find(|n| *n == name)
            .or_else(|| names.iter().find(|n| fold(n) == fold(name)));
        found.map(|n| dir.join(n)).transpose()
    }

    /// A folder's own page: `X/X.md`, or a file whose name differs from it
    /// only in case (round 3b §6.1, round 3 §9). Never for the vault root.
    pub fn folder_page_of(&self, folder: &VaultPath) -> Option<VaultPath> {
        if folder.is_root() {
            return None;
        }
        let page = self
            .child_named(folder, &format!("{}.md", folder.file_name()))
            .ok()??;
        self.fs_path(&page).ok()?.is_file().then_some(page)
    }

    /// Whether two vault paths name the same entry on disk, e.g. `Notes` and
    /// `notes` (or `á`/`Á`) on a case-insensitive file system.
    pub fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool {
        match (self.fs_path(a), self.fs_path(b)) {
            (Ok(x), Ok(y)) => same_entry(&x, &y),
            _ => false,
        }
    }

    /// Moves a file or folder to the OS trash (EXP-03).
    pub fn trash(&self, path: &VaultPath) -> Result<()> {
        if path.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot trash the vault root".into(),
            ));
        }
        let full = self.fs_path(path)?;
        if full.symlink_metadata().is_err() {
            return Err(VaultError::NotFound(path.to_string()));
        }
        trash::delete(&full).map_err(|e| VaultError::Io {
            path: path.to_string(),
            source: std::io::Error::other(e.to_string()),
        })
    }
}

fn same_entry(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

/// Names compared without letter case or Unicode form.
fn fold(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfc().collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfr_08_injected_failure_leaves_target_untouched_and_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let p = VaultPath::new("a.md").unwrap();
        let h = vault.write_cas(&p, b"original", None).unwrap();
        let err = vault
            .write_cas_inner(&p, b"new content", Some(h), true)
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
