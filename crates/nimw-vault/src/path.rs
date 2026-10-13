use crate::error::{Result, VaultError};
use std::fmt;
use std::path::{Component, Path, PathBuf};

/// A validated vault-relative path with `/` separators, stored exactly as named
/// on disk (no Unicode normalization). The empty path is the vault root.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VaultPath(String);

impl VaultPath {
    pub fn root() -> VaultPath {
        VaultPath(String::new())
    }

    /// Validates a `/`-separated relative path. Rejects empty, absolute, `.`/`..`
    /// components, empty components, backslashes, drive prefixes and NUL bytes.
    pub fn new(s: &str) -> Result<VaultPath> {
        let bad = |why: &str| Err(VaultError::OutsideVault(format!("{s:?}: {why}")));
        if s.is_empty() {
            return bad("empty path");
        }
        if s.contains('\0') {
            return bad("NUL byte");
        }
        if s.contains('\\') {
            return bad("backslash");
        }
        if s.starts_with('/') {
            return bad("absolute path");
        }
        if s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic() {
            return bad("drive prefix");
        }
        for part in s.split('/') {
            match part {
                "" => return bad("empty component"),
                "." | ".." => return bad("dot component"),
                _ => {}
            }
        }
        Ok(VaultPath(s.to_string()))
    }

    /// Builds a vault path from an absolute filesystem path under `root`.
    pub fn from_fs_path(root: &Path, path: &Path) -> Result<VaultPath> {
        let rel = path
            .strip_prefix(root)
            .map_err(|_| VaultError::OutsideVault(path.display().to_string()))?;
        let mut parts = Vec::new();
        for c in rel.components() {
            match c {
                Component::Normal(os) => {
                    let s = os
                        .to_str()
                        .ok_or_else(|| VaultError::NotUtf8(path.display().to_string()))?;
                    parts.push(s);
                }
                _ => return Err(VaultError::OutsideVault(path.display().to_string())),
            }
        }
        if parts.is_empty() {
            return Ok(VaultPath::root());
        }
        VaultPath::new(&parts.join("/"))
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `None` for the root; the root for top-level entries.
    pub fn parent(&self) -> Option<VaultPath> {
        if self.is_root() {
            return None;
        }
        Some(match self.0.rfind('/') {
            Some(i) => VaultPath(self.0[..i].to_string()),
            None => VaultPath::root(),
        })
    }

    /// Last component (empty for the root).
    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or("")
    }

    /// File name without its last extension (`notes.md` → `notes`, `.x` → `.x`).
    pub fn stem(&self) -> &str {
        let name = self.file_name();
        match name.rfind('.') {
            Some(i) if i > 0 => &name[..i],
            _ => name,
        }
    }

    pub fn extension(&self) -> Option<&str> {
        let name = self.file_name();
        match name.rfind('.') {
            Some(i) if i > 0 && i + 1 < name.len() => Some(&name[i + 1..]),
            _ => None,
        }
    }

    /// Appends a relative `/`-separated path.
    pub fn join(&self, rel: &str) -> Result<VaultPath> {
        if self.is_root() {
            VaultPath::new(rel)
        } else {
            VaultPath::new(&format!("{}/{}", self.0, rel))
        }
    }

    /// Component-wise prefix test; every path starts with the root.
    pub fn starts_with(&self, prefix: &VaultPath) -> bool {
        prefix.is_root()
            || self.0 == prefix.0
            || (self.0.starts_with(&prefix.0) && self.0.as_bytes()[prefix.0.len()] == b'/')
    }

    /// Re-roots `self` from `from` to `to` (used for folder moves).
    /// Returns `None` when `self` is not `from` or inside it.
    pub fn rebase(&self, from: &VaultPath, to: &VaultPath) -> Option<VaultPath> {
        if !self.starts_with(from) || from.is_root() {
            return None;
        }
        let rest = &self.0[from.0.len()..];
        Some(VaultPath(format!("{}{}", to.0, rest)))
    }

    pub fn to_fs_path(&self, root: &Path) -> PathBuf {
        let mut p = root.to_path_buf();
        if !self.is_root() {
            for part in self.0.split('/') {
                p.push(part);
            }
        }
        p
    }
}

impl fmt::Display for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VaultPath({:?})", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vlt_path_accepts_relative_paths() {
        for ok in ["a.md", "Projects/Ideas.md", "Café/ñandú 🎨.md", "a b/c d"] {
            assert_eq!(VaultPath::new(ok).unwrap().as_str(), ok);
        }
    }

    #[test]
    fn vlt_path_rejects_escapes_and_malformed_paths() {
        for bad in [
            "",
            "/abs",
            "../x",
            "a/../b",
            "./a",
            "a/./b",
            "a//b",
            "a/",
            "C:/x",
            "c:x",
            "a\\b",
            "nul\0byte",
        ] {
            assert!(
                matches!(VaultPath::new(bad), Err(VaultError::OutsideVault(_))),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn parent_name_stem_extension() {
        let p = VaultPath::new("Projects/Rex/draft.v2.md").unwrap();
        assert_eq!(p.parent().unwrap().as_str(), "Projects/Rex");
        assert_eq!(p.file_name(), "draft.v2.md");
        assert_eq!(p.stem(), "draft.v2");
        assert_eq!(p.extension(), Some("md"));
        let top = VaultPath::new("a.md").unwrap();
        assert!(top.parent().unwrap().is_root());
        assert_eq!(VaultPath::root().parent(), None);
        let dotfile = VaultPath::new(".hidden").unwrap();
        assert_eq!(dotfile.stem(), ".hidden");
        assert_eq!(dotfile.extension(), None);
        assert_eq!(VaultPath::new("noext").unwrap().extension(), None);
    }

    #[test]
    fn join_and_starts_with_are_component_wise() {
        let dir = VaultPath::new("Pro").unwrap();
        assert_eq!(dir.join("x.md").unwrap().as_str(), "Pro/x.md");
        assert_eq!(VaultPath::root().join("x.md").unwrap().as_str(), "x.md");
        assert!(dir.join("../x").is_err());
        let inside = VaultPath::new("Pro/x.md").unwrap();
        let sibling = VaultPath::new("Projects/x.md").unwrap();
        assert!(inside.starts_with(&dir));
        assert!(dir.starts_with(&dir));
        assert!(!sibling.starts_with(&dir));
        assert!(sibling.starts_with(&VaultPath::root()));
    }

    #[test]
    fn rebase_moves_subtree_paths() {
        let from = VaultPath::new("A").unwrap();
        let to = VaultPath::new("B/C").unwrap();
        let p = VaultPath::new("A/x/y.md").unwrap();
        assert_eq!(p.rebase(&from, &to).unwrap().as_str(), "B/C/x/y.md");
        assert_eq!(from.rebase(&from, &to).unwrap().as_str(), "B/C");
        assert_eq!(VaultPath::new("AB/x").unwrap().rebase(&from, &to), None);
    }

    #[test]
    fn fs_path_round_trip() {
        let root = Path::new("/vault");
        let p = VaultPath::new("a/b c.md").unwrap();
        let fs = p.to_fs_path(root);
        assert_eq!(VaultPath::from_fs_path(root, &fs).unwrap(), p);
        assert!(VaultPath::from_fs_path(root, root).unwrap().is_root());
        assert!(VaultPath::from_fs_path(root, Path::new("/elsewhere/x")).is_err());
    }
}
