use crate::error::{Result, VaultError};
use crate::hash::Hash;
use crate::path::VaultPath;
use crate::storage::{Child, Follow, Kind, Meta, OsUse, Reach, Reader, Replace, plain};
use crate::vault::Vault;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Thin wrappers over the vault's [`Storage`](crate::Storage).
impl Vault {
    /// `"plain"` unless the vault was opened on another storage.
    pub fn storage_name(&self) -> &'static str {
        self.storage().name()
    }

    /// `Ok(None)` when nothing is at `path`.
    pub fn meta(&self, path: &VaultPath, follow: Follow) -> Result<Option<Meta>> {
        self.storage().meta(path, follow)
    }

    /// Direct children of `dir`, hidden names included.
    pub fn children(&self, dir: &VaultPath) -> Result<Vec<Child>> {
        self.storage().children(dir)
    }

    /// Opens `path` for reading and seeking; `Reach::Visible` also refuses
    /// one whose real location is hidden (M4c review I4).
    pub fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader> {
        self.storage().open_read(path, reach)
    }

    /// A new file streamed in order; `AlreadyExists` if `path` exists.
    pub fn create_new(&self, path: &VaultPath) -> Result<Box<dyn std::io::Write + Send>> {
        self.storage().create_new(path)
    }

    pub fn remove_file(&self, path: &VaultPath) -> Result<()> {
        self.storage().remove_file(path)
    }

    pub fn remove_empty_dir(&self, path: &VaultPath) -> Result<()> {
        self.storage().remove_empty_dir(path)
    }

    /// An OS path for `use_`: opening with the default app, revealing in the
    /// file manager (never a hidden item), or a `file://` link.
    pub fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf> {
        self.storage().os_path(path, use_)
    }

    /// The vault path of an OS path inside the vault.
    pub fn vault_path_of(&self, os: &Path) -> Option<VaultPath> {
        self.storage().vault_path_of(os)
    }

    pub fn read(&self, path: &VaultPath) -> Result<(Vec<u8>, Hash)> {
        let bytes = self.storage().read(path)?;
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
        let current = match self.storage().read(path) {
            Ok(bytes) => Some(Hash::of(&bytes)),
            Err(VaultError::NotFound(_)) => None,
            Err(e) => return Err(e),
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
        self.storage()
            .replace_atomic(path, &mut &content[..], mode)?;
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
            match self.storage().meta(&current, Follow::InsideVault) {
                Ok(Some(meta)) if meta.kind == Kind::Dir => continue,
                Ok(Some(_)) => return Err(VaultError::AlreadyExists(current.to_string())),
                // Nothing there, or a link out of the vault: `create_dir`
                // refuses the latter, as before E2.
                _ => {
                    self.storage().create_dir(&current)?;
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
        self.storage()
            .replace_atomic(dest, &mut input, Replace::CreateOnly)?;
        Ok(Hash::from_bytes(*input.hasher.finalize().as_bytes()))
    }

    /// Creates one folder; the parent must exist.
    pub fn create_dir(&self, path: &VaultPath) -> Result<()> {
        self.storage().create_dir(path)
    }

    /// Renames/moves a file or folder. Fails with `AlreadyExists` if `to` exists,
    /// except case-only renames of the same entry on case-insensitive filesystems.
    pub fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        self.storage().rename(from, to)
    }

    /// The child of `dir` named `name`, or failing that one whose name only
    /// differs in letter case or Unicode form (round 3 §9). Exact wins.
    pub fn child_named(&self, dir: &VaultPath, name: &str) -> Result<Option<VaultPath>> {
        let names: Vec<String> = match self.children(dir) {
            Ok(children) => children
                .into_iter()
                .filter_map(|c| match c {
                    Child::Entry { name, .. } => Some(name),
                    Child::Unreadable(_) => None,
                })
                .collect(),
            Err(VaultError::NotFound(_)) => return Ok(None),
            Err(e) => return Err(e),
        };
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
        let meta = self.meta(&page, Follow::InsideVault).ok()??;
        (meta.kind == Kind::File).then_some(page)
    }

    /// Whether two vault paths name the same entry on disk, e.g. `Notes` and
    /// `notes` (or `á`/`Á`) on a case-insensitive file system.
    pub fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool {
        match (self.os_path(a, OsUse::Open), self.os_path(b, OsUse::Open)) {
            (Ok(x), Ok(y)) => plain::same_entry(&x, &y),
            _ => false,
        }
    }

    /// Moves a file or folder to the OS trash (EXP-03).
    pub fn trash(&self, path: &VaultPath) -> Result<()> {
        self.storage().trash_os(path)
    }
}

/// `src`, opened on the first read (so `dest`'s checks come first, as before)
/// and hashed as it streams.
struct HashingReader<'a> {
    src: &'a Path,
    file: Option<std::fs::File>, // seam: outside (the import source, a file outside the vault)
    hasher: blake3::Hasher,
}

impl Read for HashingReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let file = match &mut self.file {
            Some(file) => file,
            None => self.file.insert(std::fs::File::open(self.src)?), // seam: outside (the import source, a file outside the vault)
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
