use crate::error::{Result, SessionError};
use crate::events::{IndexReport, SessionEvent};
use liber_index::{FileKind, FileRow, Index, Stat, cache_dir_name};
use liber_markdown::{PageMeta, link_key, parse_page};
use liber_vault::{
    EncryptedStorage, Entry, EntryKind, Follow, Hash, Vault, VaultError, VaultPath, Watcher,
    is_hidden_name,
};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

const PROGRESS_EVERY: usize = 200;
const BATCH_ROWS: usize = 500;

pub(crate) type Sink = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// One open vault: the vault folder, its index cache and (optionally) a watcher.
pub struct VaultSession {
    pub(crate) vault: Vault,
    /// `None` once an encrypted vault locks: see [`VaultSession::index`].
    pub(crate) index: Mutex<Option<Index>>,
    pub(crate) sink: Sink,
    pub(crate) watcher: Mutex<Option<Watcher>>,
    /// Network files the user chose to load this session (M4b part 3, final
    /// review C1): nothing else on another computer is ever touched.
    pub(crate) network_ok: Mutex<HashSet<String>>,
    /// A full re-index is running (M5 §10.15: search says so).
    pub(crate) indexing: AtomicBool,
}

impl std::fmt::Debug for VaultSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultSession")
            .field("root", &self.vault.root())
            .finish()
    }
}

/// The open index: [`VaultSession::index`] hands one out only while it is `Some`.
pub(crate) struct IndexGuard<'a>(MutexGuard<'a, Option<Index>>);

impl std::ops::Deref for IndexGuard<'_> {
    type Target = Index;
    fn deref(&self) -> &Index {
        self.0.as_ref().expect("index() checked it")
    }
}

impl std::ops::DerefMut for IndexGuard<'_> {
    fn deref_mut(&mut self) -> &mut Index {
        self.0.as_mut().expect("index() checked it")
    }
}

/// What reading one changed file produced.
pub(crate) enum Loaded {
    /// Same content hash as stored: only the stat changed.
    StatOnly(FileRow),
    Page(FileRow, Box<PageMeta>),
    Attachment(FileRow),
    /// A text or code file and its text, which search reads (batch 6).
    Text(FileRow, String),
}

/// `bytes` as text, if `path` names a text or code file and they read as one
/// (UTF-8, no NUL, within the size cap); search indexes it (batch 6).
pub(crate) fn text_of(path: &str, bytes: &[u8]) -> Option<String> {
    (crate::text_files::is_text_path(path) && crate::text_files::is_text_content(bytes))
        .then(|| String::from_utf8_lossy(bytes).into_owned())
}

impl VaultSession {
    /// After renames: a file whose new name makes it text (or no longer
    /// text) gets its searchable text loaded (or dropped), batch 6 review M1.
    pub(crate) fn retext_renamed(&self, renamed: &[(String, String)]) -> Result<()> {
        use crate::text_files::is_text_path;
        for (old, new) in renamed {
            if is_page_path(new) || is_text_path(old) == is_text_path(new) {
                continue;
            }
            let Ok(path) = VaultPath::new(new) else {
                continue;
            };
            let text = is_text_path(new)
                .then(|| self.vault.read(&path).ok())
                .flatten()
                .and_then(|(bytes, _)| text_of(new, &bytes));
            self.index()?.transaction(|tx| match &text {
                Some(t) => tx.upsert_text(new, t),
                None => tx.remove_text(new),
            })?;
        }
        Ok(())
    }
}

pub(crate) fn is_page_path(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("md"))
}

/// Index database path for a vault: `<cache_root>/liber/<cache_dir_name>/index.sqlite`.
pub fn index_db_path(cache_root: &Path, vault_root: &Path) -> PathBuf {
    cache_root
        .join("liber")
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
        Self::start(vault, index, sink)
    }

    /// An unlocked encrypted vault: the index lives in memory only (spec §5.1).
    pub fn open_encrypted(
        storage: EncryptedStorage,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<(VaultSession, IndexReport)> {
        let vault = Vault::open_with(Box::new(storage))?;
        Self::start(vault, Index::open_in_memory()?, sink)
    }

    /// Locks an encrypted vault (spec §6.2): stops the watcher, drops the keys
    /// and decrypted names, then the index's rows. Every later read fails with
    /// `Locked`, open readers included. Does nothing for a plain vault.
    pub fn lock(&self) {
        let Some(storage) = self.vault.encrypted() else {
            return;
        };
        self.stop_watching();
        // Both under the index mutex: every later `index()` sees the lock, so
        // a batch or save that read before it can't write rows after it.
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        storage.lock();
        *index = None;
    }

    fn start(
        vault: Vault,
        index: Index,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<(VaultSession, IndexReport)> {
        let session = VaultSession {
            vault,
            index: Mutex::new(Some(index)),
            sink: Arc::new(sink),
            watcher: Mutex::new(None),
            network_ok: Mutex::new(HashSet::new()),
            indexing: AtomicBool::new(false),
        };
        let (report, changes) = session.reindex_all()?;
        session.forget_page_sizes(&changes.removed);
        // A flag is only trusted for a note the index saw unchanged: one
        // edited, replaced or new since (Finder, Obsidian, sync, another
        // machine's empty index) is the user's now (M4c final review I2). The
        // first open after the rename has an empty index only because the
        // cache moved: then just the notes changed since count (rename M3).
        let created: &[String] = if session.vault.opened_legacy_settings() {
            &[]
        } else {
            &changes.created
        };
        let unseen: Vec<String> = created.iter().chain(&changes.modified).cloned().collect();
        if let Err(e) = session.vault.forget_auto_named(&unseen) {
            session.emit(SessionEvent::Warning(format!(
                "Quick notes changed elsewhere may still be renamed: {e}"
            )));
        }
        Ok((session, report))
    }

    /// The index's database file; empty when it lives in memory (spec §5.1).
    pub fn index_file(&self) -> Result<String> {
        Ok(self.index()?.db_file()?)
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    /// The index, or `Locked` once an encrypted vault locked (spec §6.2).
    pub(crate) fn index(&self) -> Result<IndexGuard<'_>> {
        let index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if index.is_none() || self.vault.encrypted().is_some_and(|s| s.is_locked()) {
            return Err(VaultError::Locked.into());
        }
        Ok(IndexGuard(index))
    }

    pub(crate) fn emit(&self, event: SessionEvent) {
        (self.sink)(event);
    }

    /// Full incremental pass (open and watcher overflow). Returns the report and
    /// the created/modified/removed paths.
    pub(crate) fn reindex_all(&self) -> Result<(IndexReport, Changes)> {
        self.indexing.store(true, Ordering::Relaxed);
        let out = self.reindex_all_inner();
        self.indexing.store(false, Ordering::Relaxed);
        out
    }

    fn reindex_all_inner(&self) -> Result<(IndexReport, Changes)> {
        let started = Instant::now();
        let scan = self.vault.scan()?;
        let mut report = IndexReport {
            warnings: self.vault.warnings().to_vec(),
            ..IndexReport::default()
        };
        report.warnings.extend(scan.skipped.iter().cloned());
        report.files = scan.entries.len();
        let stored = self.index()?.stats()?;
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
                Loaded::Page(r, _) | Loaded::Attachment(r) | Loaded::Text(r, _) => {
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
            let mut index = self.index()?;
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
            return Some(match text_of(&row.path, &bytes) {
                Some(text) => Loaded::Text(row, text),
                None => Loaded::Attachment(row),
            });
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
        self.index()?.transaction(|tx| {
            tx.upsert_file(&row)?;
            tx.upsert_page(&row.path, &meta)
        })?;
        Ok(())
    }

    // ---- reads ----

    /// Every indexed entry but the Archive's (M5b §5.3).
    pub fn tree(&self) -> Result<Vec<liber_index::TreeNode>> {
        let mut nodes = self.tree_with_archive()?;
        nodes.retain(|n| !liber_vault::is_archived(&n.path));
        Ok(nodes)
    }

    /// The tree with the Archive (`.archive` and what's in it), which the
    /// sidebar shows as its own read-only folder (M5b round 2).
    pub fn tree_with_archive(&self) -> Result<Vec<liber_index::TreeNode>> {
        let mut nodes = self.index()?.tree()?;
        self.order_folders(&mut nodes);
        Ok(nodes)
    }

    /// Lists each folder's entries in its own order (M5b round 2). The index
    /// gives them by parent, folders first, then by name; folders with an
    /// order of their own are re-sorted in place, folders still first.
    fn order_folders(&self, nodes: &mut [liber_index::TreeNode]) {
        use liber_vault::FolderSort::*;
        let sorts = self.vault.folder_sorts();
        if sorts.is_empty() {
            return;
        }
        let created = |path: &str| {
            let p = VaultPath::new(path).ok()?;
            self.vault.meta(&p, Follow::InsideVault).ok()??.created
        };
        for run in nodes.chunk_by_mut(|a, b| a.parent == b.parent) {
            let Some(&sort) = sorts.get(&run[0].parent) else {
                continue;
            };
            let born: HashMap<String, _> = if sort == CreatedDesc {
                run.iter()
                    .map(|n| (n.path.clone(), created(&n.path)))
                    .collect()
            } else {
                HashMap::new()
            };
            // Keys made once per entry, not per comparison (round-2 review M14).
            let keys: HashMap<String, String> = run
                .iter()
                .map(|n| (n.path.clone(), liber_markdown::name_key(&n.name)))
                .collect();
            run.sort_by(|a, b| {
                let folders = (a.kind != FileKind::Folder).cmp(&(b.kind != FileKind::Folder));
                let name = keys[&a.path].cmp(&keys[&b.path]);
                let order = match (sort, a.kind == FileKind::Folder) {
                    (NameDesc, _) => name.reverse(),
                    // Folders keep their names' order under a date order.
                    (_, true) | (NameAsc, _) => name,
                    (ModifiedDesc, _) => b.mtime_ns.cmp(&a.mtime_ns).then(name),
                    (ModifiedAsc, _) => a.mtime_ns.cmp(&b.mtime_ns).then(name),
                    (CreatedDesc, _) => born[&b.path].cmp(&born[&a.path]).then(name),
                };
                folders.then(order)
            });
        }
    }

    pub fn page(&self, path: &VaultPath) -> Result<Option<liber_index::PageRow>> {
        Ok(self.index()?.page(path.as_str())?)
    }

    pub fn backlinks(&self, path: &VaultPath) -> Result<Vec<liber_index::LinkRow>> {
        Ok(self.index()?.backlinks(path.as_str())?)
    }

    /// Links from outside `path` into it: the file itself, or anything inside
    /// the folder (delete confirmation, M1b).
    pub fn backlinks_into(&self, path: &VaultPath) -> Result<Vec<liber_index::LinkRow>> {
        let prefix = format!("{}/", path.as_str());
        Ok(self
            .index()?
            .links_into(path.as_str())?
            .into_iter()
            .filter(|l| l.src != path.as_str() && !l.src.starts_with(&prefix))
            .collect())
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
        let mut index = self.index()?;
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
        self.index()?
            .transaction(|tx| tx.upsert_file(&folder_row(&entry)))?;
        Ok(path)
    }

    /// Moves a file or folder to the OS trash (EXP-03; since M5b only items
    /// already in the vault's Trash), with a hook that runs just before the
    /// OS call. The index lock is released during that call: the OS may
    /// block on a permission prompt and reads/the watcher must not stall
    /// meanwhile.
    #[cfg(test)]
    pub(crate) fn trash_with_hook(
        &self,
        path: &VaultPath,
        before_os_call: &dyn Fn(),
    ) -> Result<()> {
        self.trash_via(path, before_os_call, &|p| self.vault.trash(p))
    }

    /// Removes `path` through `os_trash` (the OS trash; a plain removal in
    /// tests, which never use the real trash). Links to it become
    /// unresolved, and its sizes are forgotten.
    pub(crate) fn trash_via(
        &self,
        path: &VaultPath,
        before_os_call: &dyn Fn(),
        os_trash: &dyn Fn(&VaultPath) -> liber_vault::Result<()>,
    ) -> Result<()> {
        let keys: Vec<String> = self
            .index()?
            .file_set()?
            .iter()
            .filter(|p| VaultPath::new(p).is_ok_and(|vp| vp.starts_with(path)))
            .map(|p| link_key(p))
            .collect();
        before_os_call();
        os_trash(path)?;
        let mut index = self.index()?;
        index.transaction(|tx| tx.remove(path.as_str()))?;
        let files = index.file_set()?;
        index.resolve_affected(&files, &keys)?;
        drop(index);
        self.forget_page_sizes(&[path.to_string()]);
        Ok(())
    }

    /// Deleted pages and folders take their page widths (final review M10),
    /// cover heights, cover sides and strip widths (M4b part 3 §3) with them.
    /// A convenience: a failure is reported, never fails the deletion.
    pub(crate) fn forget_page_sizes(&self, removed: &[String]) {
        let widths = self.vault.forget_page_widths(removed);
        let heights = self.vault.forget_cover_heights(removed);
        let sides = self.vault.forget_cover_sides(removed);
        let strips = self.vault.forget_cover_widths(removed);
        // And folder icons (M5b §4).
        let icons = self.vault.forget_folder_icons(removed);
        let sorts = self.vault.forget_folder_sorts(removed);
        // And favorites (M5b §19).
        let favorites = self.vault.forget_favorites(removed);
        // And the vault's home page.
        let home = self.vault.forget_home(removed);
        // Deleted quick notes stop being named after their first line (M4c).
        let quick = self.vault.forget_auto_named(removed);
        // And Global View positions and index-note picks (M5b final review M6).
        let layout = self.vault.forget_layout(removed);
        if let Err(e) = widths
            .and(layout)
            .and(heights)
            .and(sides)
            .and(strips)
            .and(icons)
            .and(sorts)
            .and(favorites)
            .and(home)
            .and(quick)
        {
            self.emit(SessionEvent::Warning(format!(
                "Page widths or cover sizes not updated for {} removed entries: {e}",
                removed.len()
            )));
        }
    }
}

/// Created/modified/removed paths of one pass.
#[derive(Debug, Default)]
pub(crate) struct Changes {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

pub(crate) fn write_loaded(tx: &liber_index::Tx<'_>, loaded: &Loaded) -> liber_index::Result<()> {
    match loaded {
        Loaded::StatOnly(row) | Loaded::Attachment(row) => tx.upsert_file(row),
        Loaded::Page(row, meta) => {
            tx.upsert_file(row)?;
            tx.upsert_page(&row.path, meta)
        }
        Loaded::Text(row, text) => {
            tx.upsert_file(row)?;
            tx.upsert_text(&row.path, text)
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
pub(crate) const FORBIDDEN_NAME_CHARS: &[char] = &[
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
        // Windows drops a trailing dot, so disk and index would disagree.
        || trimmed.ends_with('.')
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// Review #7: Windows drops a trailing dot (`P.` is created as `P`), so
    /// the index and the disk would disagree; refused everywhere for one rule.
    #[test]
    fn subpages_review_a_trailing_dot_is_not_a_name() {
        assert!(validate_name("P.").is_err());
        assert!(validate_name("P..").is_err());
        assert_eq!(validate_name("P.md").unwrap(), "P.md");
        assert_eq!(validate_name(" Notes ").unwrap(), "Notes");
    }

    /// M1b (M1a hand-off §11 n): the OS trash call may block on a permission
    /// prompt, so the index must not be locked while it runs.
    /// Final review M10: an in-app delete forgets the page's width, and a
    /// folder's its pages' (the OS call is a plain removal here).
    #[test]
    fn m4b2_trashed_pages_forget_their_width() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().to_path_buf();
        std::fs::write(root.join("a.md"), "# a").unwrap();
        std::fs::create_dir(root.join("F")).unwrap();
        std::fs::write(root.join("F/b.md"), "# b").unwrap();
        std::fs::write(root.join("keep.md"), "# keep").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_| {}).unwrap();
        for page in ["a.md", "F/b.md", "keep.md"] {
            s.vault
                .set_page_width(page, Some(liber_vault::PageWidth::Full))
                .unwrap();
        }
        let remove = |p: &VaultPath| {
            let full = root.join(p.as_str());
            if full.is_dir() {
                std::fs::remove_dir_all(full)
            } else {
                std::fs::remove_file(full)
            }
            .map_err(|source| liber_vault::VaultError::Io {
                path: p.to_string(),
                source,
            })
        };
        s.trash_via(&VaultPath::new("a.md").unwrap(), &|| {}, &remove)
            .unwrap();
        s.trash_via(&VaultPath::new("F").unwrap(), &|| {}, &remove)
            .unwrap();
        let pages: Vec<String> = s.vault.page_widths().pages.into_keys().collect();
        assert_eq!(pages, ["keep.md"]);
    }

    /// Cover resize: an in-app delete forgets the page's cover height, and a
    /// folder's its pages' (the OS call is a plain removal here).
    #[test]
    fn trashed_pages_forget_their_cover_height() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().to_path_buf();
        std::fs::write(root.join("a.md"), "# a").unwrap();
        std::fs::create_dir(root.join("F")).unwrap();
        std::fs::write(root.join("F/b.md"), "# b").unwrap();
        std::fs::write(root.join("keep.md"), "# keep").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_| {}).unwrap();
        for page in ["a.md", "F/b.md", "keep.md"] {
            s.vault.set_cover_height(page, Some(280)).unwrap();
        }
        let remove = |p: &VaultPath| {
            let full = root.join(p.as_str());
            if full.is_dir() {
                std::fs::remove_dir_all(full)
            } else {
                std::fs::remove_file(full)
            }
            .map_err(|source| liber_vault::VaultError::Io {
                path: p.to_string(),
                source,
            })
        };
        s.trash_via(&VaultPath::new("a.md").unwrap(), &|| {}, &remove)
            .unwrap();
        s.trash_via(&VaultPath::new("F").unwrap(), &|| {}, &remove)
            .unwrap();
        let pages: Vec<String> = s.vault.cover_heights().into_keys().collect();
        assert_eq!(pages, ["keep.md"]);
    }

    #[test]
    fn exp_03_trash_does_not_hold_the_index_lock_during_the_os_call() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let vault = tempfile::tempdir().unwrap();
        std::fs::write(vault.path().join("a.md"), "# a").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_| {}).unwrap();
        // Removing the file first makes the OS call fail (NotFound) after the
        // hook ran, so this test never touches the real trash.
        std::fs::remove_file(vault.path().join("a.md")).unwrap();
        let hook_ran = AtomicBool::new(false);
        let result = s.trash_with_hook(&VaultPath::new("a.md").unwrap(), &|| {
            assert!(s.index.try_lock().is_ok(), "index locked during OS trash");
            hook_ran.store(true, Ordering::SeqCst);
        });
        assert!(hook_ran.load(Ordering::SeqCst));
        assert!(result.is_err());
    }
}
