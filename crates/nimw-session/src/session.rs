use crate::error::{Result, SessionError};
use crate::events::{IndexReport, SessionEvent};
use nimw_index::{FileKind, FileRow, Index, Stat, cache_dir_name};
use nimw_markdown::{PageMeta, link_key, parse_page};
use nimw_vault::{Entry, EntryKind, Hash, Vault, VaultPath, Watcher, is_hidden_name};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

const PROGRESS_EVERY: usize = 200;
const BATCH_ROWS: usize = 500;

pub(crate) type Sink = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// One open vault: the vault folder, its index cache and (optionally) a watcher.
pub struct VaultSession {
    pub(crate) vault: Vault,
    pub(crate) index: Mutex<Index>,
    pub(crate) sink: Sink,
    pub(crate) watcher: Mutex<Option<Watcher>>,
}

impl std::fmt::Debug for VaultSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultSession")
            .field("root", &self.vault.root())
            .finish()
    }
}

/// What reading one changed file produced.
pub(crate) enum Loaded {
    /// Same content hash as stored: only the stat changed.
    StatOnly(FileRow),
    Page(FileRow, Box<PageMeta>),
    Attachment(FileRow),
}

pub(crate) fn is_page_path(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("md"))
}

/// Index database path for a vault: `<cache_root>/nimw/<cache_dir_name>/index.sqlite`.
pub fn index_db_path(cache_root: &Path, vault_root: &Path) -> PathBuf {
    cache_root
        .join("nimw")
        .join(cache_dir_name(vault_root))
        .join("index.sqlite")
}

impl VaultSession {
    /// Opens `root` (writing nothing inside it), opens its index under
    /// `cache_root`, and brings the index up to date (spec §6.2).
    pub fn open(
        root: &Path,
        cache_root: &Path,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<(VaultSession, IndexReport)> {
        let vault = Vault::open(root)?;
        let index = Index::open(&index_db_path(cache_root, vault.root()))?;
        let session = VaultSession {
            vault,
            index: Mutex::new(index),
            sink: Arc::new(sink),
            watcher: Mutex::new(None),
        };
        let (report, _) = session.reindex_all()?;
        Ok((session, report))
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    pub(crate) fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn emit(&self, event: SessionEvent) {
        (self.sink)(event);
    }

    /// Full incremental pass (open and watcher overflow). Returns the report and
    /// the created/modified/removed paths.
    pub(crate) fn reindex_all(&self) -> Result<(IndexReport, Changes)> {
        let started = Instant::now();
        let scan = self.vault.scan()?;
        let mut report = IndexReport {
            warnings: self.vault.warnings().to_vec(),
            ..IndexReport::default()
        };
        report.warnings.extend(scan.skipped.iter().cloned());
        report.files = scan.entries.len();
        let stored = self.index().stats()?;
        let on_disk: HashSet<&str> = scan.entries.iter().map(|e| e.path.as_str()).collect();
        let removed: Vec<String> = stored
            .keys()
            .filter(|p| !on_disk.contains(p.as_str()))
            .cloned()
            .collect();

        let mut folders = Vec::new();
        let mut changed = Vec::new();
        for entry in &scan.entries {
            let old = stored.get(entry.path.as_str());
            match entry.kind {
                EntryKind::Dir => {
                    if old.is_none_or(|s| s.kind != FileKind::Folder) {
                        folders.push(folder_row(entry));
                    }
                }
                EntryKind::File => {
                    if old.is_some_and(|s| unchanged(s, entry)) {
                        report.skipped_unchanged += 1;
                    } else {
                        changed.push((entry.clone(), old.and_then(|s| s.hash.clone())));
                    }
                }
            }
        }

        let total = changed.len();
        let done = AtomicUsize::new(0);
        let warnings = Mutex::new(Vec::new());
        let loaded: Vec<Loaded> = changed
            .par_iter()
            .filter_map(|(entry, old_hash)| {
                let out = self.load(entry, old_hash.as_deref(), &mut warnings.lock().unwrap());
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n.is_multiple_of(PROGRESS_EVERY) || n == total {
                    self.emit(SessionEvent::Progress { done: n, total });
                }
                out
            })
            .collect();
        report.warnings.extend(warnings.into_inner().unwrap());

        let mut changes = Changes {
            removed: removed.clone(),
            ..Changes::default()
        };
        for l in &loaded {
            let (path, is_new) = match l {
                Loaded::StatOnly(r) => (&r.path, false),
                Loaded::Page(r, _) | Loaded::Attachment(r) => {
                    (&r.path, !stored.contains_key(&r.path))
                }
            };
            if !matches!(l, Loaded::StatOnly(_)) {
                report.parsed += 1;
                if is_new {
                    changes.created.push(path.clone())
                } else {
                    changes.modified.push(path.clone())
                }
            }
        }
        report.removed = removed.len();

        {
            let mut index = self.index();
            for chunk in removed.chunks(BATCH_ROWS) {
                index.transaction(|tx| chunk.iter().try_for_each(|p| tx.remove(p)))?;
            }
            for chunk in folders.chunks(BATCH_ROWS) {
                index.transaction(|tx| chunk.iter().try_for_each(|r| tx.upsert_file(r)))?;
            }
            for chunk in loaded.chunks(BATCH_ROWS) {
                index.transaction(|tx| chunk.iter().try_for_each(|l| write_loaded(tx, l)))?;
            }
            let files = index.file_set()?;
            index.resolve_all(&files)?;
            report.pages = index.counts()?.1;
        }
        report.duration = started.elapsed();
        self.emit(SessionEvent::Indexed(report.clone()));
        Ok((report, changes))
    }

    /// Reads, hashes and (for pages) parses one file. `None` if it vanished.
    pub(crate) fn load(
        &self,
        entry: &Entry,
        old_hash: Option<&str>,
        warnings: &mut Vec<String>,
    ) -> Option<Loaded> {
        let (bytes, hash) = match self.vault.read(&entry.path) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(format!("{}: {e}", entry.path));
                return None;
            }
        };
        let page = is_page_path(entry.path.as_str());
        let mut row = FileRow {
            path: entry.path.to_string(),
            kind: if page {
                FileKind::Page
            } else {
                FileKind::Attachment
            },
            mtime_ns: clamp_ns(entry.mtime_ns),
            size: entry.size,
            hash: Some(hash.to_hex()),
        };
        if old_hash == Some(hash.to_hex().as_str()) {
            if page && std::str::from_utf8(&bytes).is_err() {
                row.kind = FileKind::Attachment;
            }
            return Some(Loaded::StatOnly(row));
        }
        if !page {
            return Some(Loaded::Attachment(row));
        }
        match String::from_utf8(bytes) {
            Ok(text) => {
                let meta = parse_page(&text, entry.path.stem());
                if let Some(err) = &meta.frontmatter_error {
                    warnings.push(format!("{}: frontmatter: {err}", entry.path));
                }
                Some(Loaded::Page(row, Box::new(meta)))
            }
            Err(_) => {
                warnings.push(format!(
                    "{}: not valid UTF-8, indexed as attachment",
                    entry.path
                ));
                row.kind = FileKind::Attachment;
                Some(Loaded::Attachment(row))
            }
        }
    }

    /// Re-stats `path` after the session wrote it and stores its page data.
    pub(crate) fn reindex_written(&self, path: &VaultPath, text: &str, hash: Hash) -> Result<()> {
        let entry = self
            .vault
            .stat(path)?
            .ok_or_else(|| SessionError::NotIndexed(path.to_string()))?;
        let row = FileRow {
            path: path.to_string(),
            kind: FileKind::Page,
            mtime_ns: clamp_ns(entry.mtime_ns),
            size: entry.size,
            hash: Some(hash.to_hex()),
        };
        let meta = parse_page(text, path.stem());
        self.index().transaction(|tx| {
            tx.upsert_file(&row)?;
            tx.upsert_page(&row.path, &meta)
        })?;
        Ok(())
    }

    // ---- reads ----

    pub fn tree(&self) -> Result<Vec<nimw_index::TreeNode>> {
        Ok(self.index().tree()?)
    }

    pub fn page(&self, path: &VaultPath) -> Result<Option<nimw_index::PageRow>> {
        Ok(self.index().page(path.as_str())?)
    }

    pub fn backlinks(&self, path: &VaultPath) -> Result<Vec<nimw_index::LinkRow>> {
        Ok(self.index().backlinks(path.as_str())?)
    }

    // ---- operations ----

    /// Creates an empty page `name` (`.md` appended if missing) in `dir`.
    pub fn create_page(&self, dir: &VaultPath, name: &str) -> Result<VaultPath> {
        let name = validate_name(name)?;
        let file = if is_page_path(name) {
            name.to_string()
        } else {
            format!("{name}.md")
        };
        let path = dir.join(&file)?;
        let hash = self.vault.write_cas(&path, b"", None)?;
        self.reindex_written(&path, "", hash)?;
        let mut index = self.index();
        let files = index.file_set()?;
        index.resolve_affected(&files, &[link_key(path.as_str())])?;
        Ok(path)
    }

    pub fn create_folder(&self, parent: &VaultPath, name: &str) -> Result<VaultPath> {
        let path = parent.join(validate_name(name)?)?;
        self.vault.create_dir(&path)?;
        let entry = self
            .vault
            .stat(&path)?
            .ok_or_else(|| SessionError::NotIndexed(path.to_string()))?;
        self.index()
            .transaction(|tx| tx.upsert_file(&folder_row(&entry)))?;
        Ok(path)
    }

    /// Moves a file or folder to the OS trash (EXP-03). Links to it become unresolved.
    pub fn trash(&self, path: &VaultPath) -> Result<()> {
        let mut index = self.index();
        let keys: Vec<String> = index
            .file_set()?
            .iter()
            .filter(|p| VaultPath::new(p).is_ok_and(|vp| vp.starts_with(path)))
            .map(|p| link_key(p))
            .collect();
        self.vault.trash(path)?;
        index.transaction(|tx| tx.remove(path.as_str()))?;
        let files = index.file_set()?;
        index.resolve_affected(&files, &keys)?;
        Ok(())
    }
}

/// Created/modified/removed paths of one pass.
#[derive(Debug, Default)]
pub(crate) struct Changes {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

pub(crate) fn write_loaded(tx: &nimw_index::Tx<'_>, loaded: &Loaded) -> nimw_index::Result<()> {
    match loaded {
        Loaded::StatOnly(row) | Loaded::Attachment(row) => tx.upsert_file(row),
        Loaded::Page(row, meta) => {
            tx.upsert_file(row)?;
            tx.upsert_page(&row.path, meta)
        }
    }
}

pub(crate) fn folder_row(entry: &Entry) -> FileRow {
    FileRow {
        path: entry.path.to_string(),
        kind: FileKind::Folder,
        mtime_ns: clamp_ns(entry.mtime_ns),
        size: 0,
        hash: None,
    }
}

pub(crate) fn unchanged(stat: &Stat, entry: &Entry) -> bool {
    stat.kind != FileKind::Folder
        && stat.mtime_ns == clamp_ns(entry.mtime_ns)
        && stat.size == entry.size
}

pub(crate) fn clamp_ns(ns: i128) -> i64 {
    ns.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// Characters that cannot appear in a file or folder name created by the app:
/// path separators, characters that break `[[wikilinks]]` (`#`, `|`, `^`, `[`,
/// `]`) and characters Windows/macOS forbid or mangle (Obsidian's rule set).
const FORBIDDEN_NAME_CHARS: &[char] = &[
    '/', '\\', '#', '|', '^', '[', ']', ':', '*', '"', '<', '>', '?',
];

/// A single file or folder name: non-empty, not hidden, no forbidden or
/// control characters (final review I1: such names produce unlinkable files).
pub(crate) fn validate_name(name: &str) -> Result<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains(FORBIDDEN_NAME_CHARS)
        || trimmed.chars().any(char::is_control)
        || is_hidden_name(trimmed)
    {
        return Err(SessionError::InvalidName(name.to_string()));
    }
    Ok(trimmed)
}

/// Paths of every file at or below `path` in `stats` (for folder moves).
pub(crate) fn subtree_files(stats: &HashMap<String, Stat>, path: &VaultPath) -> Vec<String> {
    let mut out: Vec<String> = stats
        .iter()
        .filter(|(p, s)| {
            s.kind != FileKind::Folder && VaultPath::new(p).is_ok_and(|vp| vp.starts_with(path))
        })
        .map(|(p, _)| p.clone())
        .collect();
    out.sort();
    out
}
