use crate::error::{Result, io_err};
use crate::is_hidden_name;
use crate::path::VaultPath;
use crate::vault::Vault;
use std::path::Path;
use std::time::UNIX_EPOCH;

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

pub(crate) fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0)
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
        if path.is_root()
            || path.as_str().split('/').any(is_hidden_name)
            || self.is_excluded(path.as_str())
        {
            return Ok(None);
        }
        let full = path.to_fs_path(&self.root);
        Ok(self.entry_for(path.clone(), &full, &mut Vec::new()))
    }

    fn walk(&self, start: &VaultPath, recursive: bool) -> Result<Scan> {
        let mut out = Scan::default();
        let mut stack = vec![start.clone()];
        while let Some(dir) = stack.pop() {
            let fs_dir = dir.to_fs_path(&self.root);
            let read = match std::fs::read_dir(&fs_dir) {
                Ok(read) => read,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && dir != *start => continue,
                // One unreadable subfolder must not make the vault unopenable
                // (final review I3): report it and keep scanning.
                Err(e) if dir != *start => {
                    out.skipped
                        .push(format!("{dir}: folder not readable ({e})"));
                    continue;
                }
                Err(e) => return Err(io_err(dir.as_str(), e)),
            };
            for item in read {
                let item = match item {
                    Ok(item) => item,
                    Err(e) => {
                        out.skipped.push(format!("{dir}: entry not readable ({e})"));
                        continue;
                    }
                };
                let os_name = item.file_name();
                let Some(name) = os_name.to_str() else {
                    out.skipped
                        .push(format!("{}: name is not UTF-8", item.path().display()));
                    continue;
                };
                if is_hidden_name(name) {
                    continue;
                }
                let Ok(path) = dir.join(name) else {
                    out.skipped
                        .push(format!("{}: invalid name", item.path().display()));
                    continue;
                };
                if self.is_excluded(path.as_str()) {
                    continue;
                }
                if let Some(entry) = self.entry_for(path, &item.path(), &mut out.skipped) {
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

    fn entry_for(&self, path: VaultPath, full: &Path, skipped: &mut Vec<String>) -> Option<Entry> {
        let lmeta = full.symlink_metadata().ok()?;
        let meta = if lmeta.file_type().is_symlink() {
            match self.symlink_target_meta(full) {
                Some(m) if m.is_file() => m,
                Some(_) => {
                    skipped.push(format!("{path}: symlinked folder not followed"));
                    return None;
                }
                None => {
                    skipped.push(format!("{path}: symlink points outside the vault"));
                    return None;
                }
            }
        } else {
            lmeta
        };
        if meta.is_dir() {
            Some(Entry {
                path,
                kind: EntryKind::Dir,
                mtime_ns: mtime_ns(&meta),
                size: 0,
            })
        } else if meta.is_file() {
            Some(Entry {
                path,
                kind: EntryKind::File,
                mtime_ns: mtime_ns(&meta),
                size: meta.len(),
            })
        } else {
            None
        }
    }

    /// Metadata of a symlink's target if the target is inside the vault.
    fn symlink_target_meta(&self, link: &Path) -> Option<std::fs::Metadata> {
        let target = dunce::canonicalize(link).ok()?;
        if !target.starts_with(&self.root) {
            return None;
        }
        std::fs::metadata(&target).ok()
    }
}
