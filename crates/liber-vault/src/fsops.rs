use crate::error::{Result, VaultError, io_err};
use crate::hash::Hash;
use crate::path::VaultPath;
use crate::storage::Replace;
use crate::storage::plain;
use crate::vault::Vault;
use std::io::Read;
use std::path::{Path, PathBuf};

impl Vault {
    /// Absolute path for `path`, refusing anything whose deepest existing
    /// ancestor resolves (through symlinks) outside the vault.
    pub fn fs_path(&self, path: &VaultPath) -> Result<PathBuf> {
        plain::resolve(&self.root, path)
    }

    /// [`Vault::fs_path`] for a path the webview names, also refusing one
    /// whose real location is hidden: a visible name can resolve into a
    /// hidden folder through a symlink or, on Windows, an 8.3 short name
    /// (`SSH~1`). A missing file is left to the read that follows.
    pub fn visible_fs_path(&self, path: &VaultPath) -> Result<PathBuf> {
        plain::resolve_visible(&self.root, path)
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
        if path.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot write the vault root".into(),
            ));
        }
        let current = match std::fs::read(self.fs_path(path)?) {
            Ok(bytes) => Some(Hash::of(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_err(path.as_str(), e)),
        };
        let mode = match (&expected, &current) {
            (None, Some(_)) => return Err(VaultError::AlreadyExists(path.to_string())),
            (Some(_), None) => return Err(VaultError::NotFound(path.to_string())),
            (Some(want), Some(current)) if want != current => {
                return Err(VaultError::Conflict {
                    path: path.to_string(),
                    current: *current,
                });
            }
            (None, None) => Replace::CreateOnly,
            (Some(_), Some(_)) => Replace::Overwrite,
        };
        plain::replace_atomic(&self.root, path, &mut &content[..], mode, false)?;
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
        let mut input = HashingReader {
            src,
            file: None,
            hasher: blake3::Hasher::new(),
        };
        plain::replace_atomic(&self.root, dest, &mut input, Replace::CreateOnly, false)?;
        Ok(Hash::from_bytes(*input.hasher.finalize().as_bytes()))
    }

    /// Creates one folder; the parent must exist.
    pub fn create_dir(&self, path: &VaultPath) -> Result<()> {
        plain::create_dir(&self.root, path)
    }

    /// Renames/moves a file or folder. Fails with `AlreadyExists` if `to` exists,
    /// except case-only renames of the same entry on case-insensitive filesystems.
    pub fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        plain::rename(&self.root, from, to)
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
        pick_child(&names, name).map(|n| dir.join(n)).transpose()
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
            (Ok(x), Ok(y)) => plain::same_entry(&x, &y),
            _ => false,
        }
    }

    /// Moves a file or folder to the OS trash (EXP-03).
    pub fn trash(&self, path: &VaultPath) -> Result<()> {
        plain::trash(&self.root, path)
    }
}

/// `src`, opened on the first read (so `dest`'s checks come first, as before)
/// and hashed as it streams.
struct HashingReader<'a> {
    src: &'a Path,
    file: Option<std::fs::File>,
    hasher: blake3::Hasher,
}

impl Read for HashingReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let file = match &mut self.file {
            Some(file) => file,
            None => self.file.insert(std::fs::File::open(self.src)?),
        };
        let n = file.read(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
}

/// `name` among `names`: the exact one if present, else any case variant.
fn pick_child<'a>(names: &'a [String], name: &str) -> Option<&'a String> {
    names
        .iter()
        .find(|n| *n == name)
        .or_else(|| names.iter().find(|n| fold(n) == fold(name)))
}

/// Names compared without letter case or Unicode form.
fn fold(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfc().collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review #8: the exact name wins over a case variant whatever the listing
    /// order (runs everywhere; the on-disk twin of this needs Linux).
    #[test]
    fn subpages_review_exact_name_wins_in_any_order() {
        let both = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
        assert_eq!(pick_child(&both("x.md", "X.md"), "X.md").unwrap(), "X.md");
        assert_eq!(pick_child(&both("X.md", "x.md"), "X.md").unwrap(), "X.md");
        assert_eq!(pick_child(&both("x.md", "y.md"), "X.md").unwrap(), "x.md");
        assert_eq!(pick_child(&both("a.md", "b.md"), "X.md"), None);
    }
}
