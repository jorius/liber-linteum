use crate::error::{Result, VaultError};
use crate::path::VaultPath;
use crate::storage::{Child, Follow, Kind, Meta, OsUse};
use crate::vault::Vault;
use crate::{ARCHIVE_DIR, is_hidden_name, is_hidden_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
}

/// One visible vault entry with the stat used for incremental indexing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: VaultPath,
    pub kind: EntryKind,
    pub mtime_ns: i128,
    pub size: u64,
}

/// Result of a scan: visible entries (sorted by path) and skipped items with reasons.
#[derive(Debug, Default)]
pub struct Scan {
    pub entries: Vec<Entry>,
    pub skipped: Vec<String>,
}

impl Vault {
    /// Walks the whole vault. Skips hidden names at any depth, user-excluded
    /// paths, symlinked folders, symlinks resolving outside the vault, and names
    /// that are not valid UTF-8 (reported in `skipped`).
    pub fn scan(&self) -> Result<Scan> {
        self.walk(&VaultPath::root(), true)
    }

    /// Like [`Vault::scan`] but only below `dir` (the folder itself is not included).
    pub fn scan_from(&self, dir: &VaultPath) -> Result<Scan> {
        self.walk(dir, true)
    }

    /// Visible direct children of `dir`, with the same filters as `scan`.
    pub fn list_dir(&self, dir: &VaultPath) -> Result<Vec<Entry>> {
        Ok(self.walk(dir, false)?.entries)
    }

    /// Stat of one visible entry; `None` if it does not exist, is hidden,
    /// excluded, or a symlink that `scan` would skip.
    pub fn stat(&self, path: &VaultPath) -> Result<Option<Entry>> {
        if path.is_root() || is_hidden_path(path.as_str()) || self.is_excluded(path.as_str()) {
            return Ok(None);
        }
        let Ok(Some(meta)) = self.storage().meta(path, Follow::No) else {
            return Ok(None);
        };
        Ok(self.entry_for(path.clone(), meta, &mut Vec::new()))
    }

    fn walk(&self, start: &VaultPath, recursive: bool) -> Result<Scan> {
        let mut out = Scan::default();
        let mut stack = vec![start.clone()];
        while let Some(dir) = stack.pop() {
            let children = match self.storage().children(&dir) {
                Ok(children) => children,
                Err(VaultError::NotFound(_)) if dir != *start => continue,
                // One unreadable subfolder must not make the vault unopenable
                // (final review I3): report it and keep scanning.
                Err(e) if dir != *start => {
                    let reason = match &e {
                        VaultError::Io { source, .. } => source.to_string(),
                        e => e.to_string(),
                    };
                    out.skipped
                        .push(format!("{dir}: folder not readable ({reason})"));
                    continue;
                }
                Err(e) => return Err(e),
            };
            for child in children {
                let (name, meta) = match child {
                    Child::Entry { name, meta } => (name, meta),
                    Child::Unreadable(reason) => {
                        out.skipped.push(reason);
                        continue;
                    }
                };
                if is_hidden_name(&name) && !(dir.is_root() && name == ARCHIVE_DIR) {
                    continue;
                }
                let Ok(path) = dir.join(&name) else {
                    let shown = match self.storage().os_path(&dir, OsUse::Reveal) {
                        Ok(os) => os.join(&name).display().to_string(),
                        Err(_) => format!("{dir}/{name}"),
                    };
                    out.skipped.push(format!("{shown}: invalid name"));
                    continue;
                };
                if self.is_excluded(path.as_str()) {
                    continue;
                }
                if let Some(entry) = self.entry_for(path, meta, &mut out.skipped) {
                    if entry.kind == EntryKind::Dir && recursive {
                        stack.push(entry.path.clone());
                    }
                    out.entries.push(entry);
                }
            }
        }
        out.entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// The entry for `path`, whose unfollowed stat is `meta`: a symlink to a
    /// file inside the vault reads as that file; other symlinks are skipped.
    fn entry_for(&self, path: VaultPath, meta: Meta, skipped: &mut Vec<String>) -> Option<Entry> {
        let meta = if meta.kind == Kind::Symlink {
            match self.storage().meta(&path, Follow::InsideVault) {
                Ok(Some(m)) if m.kind == Kind::File => m,
                Ok(Some(_)) => {
                    skipped.push(format!("{path}: symlinked folder not followed"));
                    return None;
                }
                Err(VaultError::OutsideVault(_)) => {
                    skipped.push(format!("{path}: symlink points outside the vault"));
                    return None;
                }
                // Gone or unreadable since the listing: nothing there.
                _ => return None,
            }
        } else {
            meta
        };
        let kind = match meta.kind {
            Kind::Dir => EntryKind::Dir,
            Kind::File => EntryKind::File,
            Kind::Symlink | Kind::Other => return None,
        };
        Some(Entry {
            path,
            kind,
            mtime_ns: meta.mtime_ns,
            size: meta.len,
        })
    }
}
