//! Single-file windows (M4c §3, §4): a Markdown, text or code file opened on
//! its own, outside any vault, in a window of its own.
//!
//! Opening a file records a **grant** for the window's label before the
//! window exists: the file's folder as a [`Vault`] (its path checks: no `..`,
//! no absolute paths, no symlink escapes) and the file's name in it. The
//! window's commands (`file_commands`) and its `liber-asset:` requests act on
//! that grant only; nothing the page sends names another path to write. The
//! grant goes with its window.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::FilePicker;
use liber_markdown::FileSet;
use liber_session::is_text_path;
use liber_vault::{Vault, VaultPath, WatchEvent, Watcher};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Labels of single-file windows: `file-1`, `file-2`… (their capability
/// file matches `file-*`).
pub const FILE_WINDOW_PREFIX: &str = "file-";

/// Sent to a file window when its file changed on disk: `{ removed }`.
pub const FILE_CHANGED_EVENT: &str = "file:changed";

/// Folders below the file's own that `[[wikilinks]]` reach (spec §3).
pub const LINK_DEPTH: usize = 3;
/// Most files listed for link resolution (a file in a huge folder).
pub const MAX_LISTED: usize = 10_000;
/// How long a folder listing is reused for link resolution.
const LISTING_TTL: Duration = Duration::from_secs(2);
/// Largest note a file window opens (a text file's cap is `TEXT_MAX_BYTES`):
/// beyond it, reading the file whole could take the app, and every window's
/// unsaved text, down.
pub const PAGE_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// `tooLarge` when a file of `kind` is too big to edit (M4c review m2).
pub fn check_size(kind: FileKind, len: u64, name: &str) -> CmdResult<()> {
    let max = match kind {
        FileKind::Page => PAGE_MAX_BYTES,
        FileKind::Text => liber_session::TEXT_MAX_BYTES as u64,
    };
    if len > max {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("{name} is too large to open ({len} bytes)"),
        ));
    }
    Ok(())
}

/// Whether a window label is a single-file window's.
pub fn is_file_window(label: &str) -> bool {
    label.starts_with(FILE_WINDOW_PREFIX)
}

/// How the window edits the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    /// Markdown (`.md`, `.markdown`): the page editor.
    Page,
    /// A text or code file (M4b part 2 §6): the text view.
    Text,
}

/// The kind a file opens as, from its name; `None` for files the app
/// doesn't open on their own (images, documents, programs).
pub fn file_kind(name: &str) -> Option<FileKind> {
    if let Some((stem, ext)) = name.rsplit_once('.')
        && !stem.is_empty()
        && (ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
    {
        return Some(FileKind::Page);
    }
    is_text_path(name).then_some(FileKind::Text)
}

/// One window's file.
pub struct FileGrant {
    vault: Vault,
    name: Arc<Mutex<VaultPath>>,
    kind: FileKind,
    watcher: Mutex<Option<Watcher>>,
    listing: Mutex<Option<(Instant, Arc<FileSet>)>>,
    /// Until its window is built: a second open of the file waits for that
    /// window instead of building another (M4c review I1).
    building: AtomicBool,
}

impl std::fmt::Debug for FileGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileGrant")
            .field("path", &self.real_path())
            .field("kind", &self.kind)
            .finish()
    }
}

impl FileGrant {
    /// The file's name in its folder.
    pub fn name(&self) -> VaultPath {
        lock(&self.name).clone()
    }

    pub fn kind(&self) -> FileKind {
        self.kind
    }

    /// The folder, as a vault: every read and write goes through it.
    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    /// The file's folder (canonical).
    pub fn folder(&self) -> &Path {
        self.vault.root()
    }

    /// The file's absolute path.
    pub fn real_path(&self) -> PathBuf {
        self.name().to_fs_path(self.vault.root()) // seam: outside (single-file window: one plain file outside any vault, M4c §3)
    }

    /// Its window is built.
    pub fn opened(&self) {
        self.building.store(false, Ordering::Relaxed);
    }

    /// After a rename in the app.
    pub fn set_name(&self, name: VaultPath) {
        *lock(&self.name) = name;
    }

    /// Files in the folder and its subfolders down to [`LINK_DEPTH`] (hidden
    /// and excluded ones left out), reused for [`LISTING_TTL`].
    pub fn files(&self) -> Arc<FileSet> {
        let mut cached = lock(&self.listing);
        if let Some((at, files)) = cached.as_ref()
            && at.elapsed() < LISTING_TTL
        {
            return files.clone();
        }
        let files = Arc::new(folder_files(&self.vault));
        *cached = Some((Instant::now(), files.clone()));
        files
    }
}

/// Breadth-first, so a capped listing keeps the files nearest the note.
fn folder_files(vault: &Vault) -> FileSet {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([(VaultPath::root(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = vault.list_dir(&dir) else {
            continue;
        };
        for entry in entries {
            match entry.kind {
                liber_vault::EntryKind::File => {
                    if out.len() >= MAX_LISTED {
                        return FileSet::new(out);
                    }
                    out.push(entry.path.to_string());
                }
                liber_vault::EntryKind::Dir if depth < LINK_DEPTH => {
                    queue.push_back((entry.path, depth + 1));
                }
                liber_vault::EntryKind::Dir => {}
            }
        }
    }
    FileSet::new(out)
}

/// What a watcher batch means for the file named `name`: `Some(removed)`
/// when it changed or went, `None` when it wasn't touched. Lost events
/// (`Overflow`) read as a change: the window re-reads the file.
pub fn change_for(name: &VaultPath, batch: &[WatchEvent]) -> Option<bool> {
    let mut seen = None;
    for event in batch {
        match event {
            WatchEvent::Changed(p) if p == name => return Some(false),
            WatchEvent::Removed(p) if p == name => seen = Some(true),
            WatchEvent::Overflow => seen = seen.or(Some(false)),
            _ => {}
        }
    }
    seen
}

#[derive(Debug, Clone, Serialize)]
pub struct FileChanged {
    pub removed: bool,
}

/// Every single-file window's grant, by window label (managed state).
#[derive(Default)]
pub struct FileWindows {
    next: AtomicU64,
    grants: Mutex<HashMap<String, Arc<FileGrant>>>,
    picker: Mutex<Option<FilePicker>>,
}

impl FileWindows {
    /// The grant for `path` (an existing, eligible file): a new label, or the
    /// label of the window that already has it (`true`), whatever the
    /// spelling of the path (relative parts, symlinks). `live` says whether a
    /// label's window exists: a grant whose window was built and is gone
    /// (closing) is replaced under a new label, so the closing window's
    /// `Destroyed` can't take the new window's grant (M4c review I1).
    pub fn grant(
        &self,
        path: &Path,
        live: impl Fn(&str) -> bool,
    ) -> CmdResult<(String, Arc<FileGrant>, bool)> {
        let real = dunce::canonicalize(path); // seam: outside (single-file window: one plain file outside any vault, M4c §3)
        let real = real.map_err(|e| {
            CommandError::new(ErrorKind::NotFound, format!("{}: {e}", path.display()))
        })?;
        let meta = std::fs::metadata(&real)?; // seam: outside (single-file window: one plain file outside any vault, M4c §3)
        if !meta.is_file() {
            return Err(CommandError::new(
                ErrorKind::NotAFile,
                format!("not a file: {}", real.display()),
            ));
        }
        let name = real
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| CommandError::new(ErrorKind::InvalidName, real.display().to_string()))?;
        let kind = file_kind(name).ok_or_else(|| {
            CommandError::new(
                ErrorKind::NotAText,
                format!("not a note or text file: {name}"),
            )
        })?;
        check_size(kind, meta.len(), name)?;
        let folder = real
            .parent()
            .ok_or_else(|| CommandError::new(ErrorKind::NotAFile, real.display().to_string()))?;
        let mut grants = lock(&self.grants);
        if let Some((label, grant)) = grants
            .iter()
            .find(|(_, g)| g.real_path() == real)
            .map(|(l, g)| (l.clone(), g.clone()))
        {
            if grant.building.load(Ordering::Relaxed) || live(&label) {
                return Ok((label, grant, true));
            }
            grants.remove(&label);
        }
        let grant = Arc::new(FileGrant {
            // Moves a legacy settings folder like a vault open does; its
            // warnings aren't shown here (one file, no toast of its own) but
            // repeat when the folder next opens as a vault (rename M6).
            vault: Vault::open(folder)?,
            name: Arc::new(Mutex::new(VaultPath::new(name)?)),
            kind,
            watcher: Mutex::new(None),
            listing: Mutex::new(None),
            building: AtomicBool::new(true),
        });
        let label = format!(
            "{FILE_WINDOW_PREFIX}{}",
            self.next.fetch_add(1, Ordering::Relaxed) + 1
        );
        grants.insert(label.clone(), grant.clone());
        Ok((label, grant, false))
    }

    pub fn get(&self, label: &str) -> Option<Arc<FileGrant>> {
        lock(&self.grants).get(label).cloned()
    }

    /// The window is gone: so is its grant (and its watcher).
    pub fn revoke(&self, label: &str) {
        lock(&self.grants).remove(label);
    }

    /// Replaces the Open File… dialog (tests); `None` restores it.
    pub fn set_picker(&self, picker: Option<FilePicker>) {
        *lock(&self.picker) = picker;
    }

    pub fn picker(&self) -> Option<FilePicker> {
        lock(&self.picker).clone()
    }
}

/// The calling window's grant; `notPermitted` for a window without one.
pub fn grant_for<R: Runtime>(app: &AppHandle<R>, label: &str) -> CmdResult<Arc<FileGrant>> {
    app.try_state::<FileWindows>()
        .and_then(|w| w.get(label))
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::NotPermitted,
                format!("{label} has no file of its own"),
            )
        })
}

/// Opens `path` in a window of its own, or brings forward the window that
/// already shows it. Returns the window's label.
pub fn open_file_window<R: Runtime>(app: &AppHandle<R>, path: &Path) -> CmdResult<String> {
    let windows = app.state::<FileWindows>();
    let (label, grant, existed) = windows.grant(path, |l| app.get_webview_window(l).is_some())?;
    if existed {
        // Its window is up (brought forward) or still being built by the
        // open that granted it, which shows it.
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return Ok(label);
    }
    watch(app, &label, &grant);
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(grant.name().file_name())
        .inner_size(900.0, 700.0)
        .min_inner_size(480.0, 360.0)
        .build();
    match built {
        Ok(window) => {
            grant.opened();
            let app = app.clone();
            let gone = label.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    app.state::<FileWindows>().revoke(&gone);
                }
            });
            Ok(label)
        }
        Err(e) => {
            windows.revoke(&label);
            Err(CommandError::new(ErrorKind::Io, e.to_string()))
        }
    }
}

/// Tells the window when its file changes on disk (its folder only, never
/// the folders below).
fn watch<R: Runtime>(app: &AppHandle<R>, label: &str, grant: &FileGrant) {
    let name = grant.name.clone();
    let app = app.clone();
    let target = label.to_string();
    let watcher = grant.vault.watch_folder(move |batch| {
        let current = lock(&name).clone();
        if let Some(removed) = change_for(&current, &batch) {
            let _ = app.emit_to(target.as_str(), FILE_CHANGED_EVENT, FileChanged { removed });
        }
    });
    // Without a watcher the window still saves; it only misses outside edits.
    *lock(&grant.watcher) = watcher.ok();
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vp(s: &str) -> VaultPath {
        VaultPath::new(s).unwrap()
    }

    #[test]
    fn notes_text_and_code_files_open_on_their_own() {
        for name in [
            "a.md",
            "B.MD",
            "c.markdown",
            "d.txt",
            "e.json",
            "Makefile",
            "f.rs",
        ] {
            assert!(file_kind(name).is_some(), "{name}");
        }
        assert_eq!(file_kind("a.md"), Some(FileKind::Page));
        assert_eq!(file_kind("c.markdown"), Some(FileKind::Page));
        assert_eq!(file_kind("d.txt"), Some(FileKind::Text));
        for name in ["a.png", "b.pdf", "c.exe", "noext", ".md", "d.app"] {
            assert_eq!(file_kind(name), None, "{name}");
        }
    }

    #[test]
    fn a_batch_matters_only_when_it_names_the_file() {
        let name = vp("note.md");
        assert_eq!(
            change_for(&name, &[WatchEvent::Changed(vp("other.md"))]),
            None
        );
        assert_eq!(
            change_for(&name, &[WatchEvent::Changed(vp("note.md"))]),
            Some(false)
        );
        assert_eq!(
            change_for(&name, &[WatchEvent::Removed(vp("note.md"))]),
            Some(true)
        );
        // Deleted and written again in one batch (an editor's atomic save).
        assert_eq!(
            change_for(
                &name,
                &[
                    WatchEvent::Removed(vp("note.md")),
                    WatchEvent::Changed(vp("note.md"))
                ]
            ),
            Some(false)
        );
        assert_eq!(change_for(&name, &[WatchEvent::Overflow]), Some(false));
        assert_eq!(change_for(&name, &[]), None);
    }

    #[test]
    fn grants_follow_the_real_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("x")).unwrap();
        std::fs::write(dir.path().join("note.md"), "# n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "o").unwrap();
        let windows = FileWindows::default();
        let (a, grant, existed) = windows
            .grant(&dir.path().join("note.md"), |_| false)
            .unwrap();
        assert_eq!((a.as_str(), existed), ("file-1", false));
        assert_eq!(grant.name(), vp("note.md"));
        assert_eq!(grant.kind(), FileKind::Page);
        let (again, _, existed) = windows
            .grant(&dir.path().join("x/../note.md"), |_| false)
            .unwrap();
        assert_eq!((again.as_str(), existed), ("file-1", true));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("note.md"), dir.path().join("link.md"))
                .unwrap();
            let (linked, _, existed) = windows
                .grant(&dir.path().join("link.md"), |_| false)
                .unwrap();
            assert_eq!((linked.as_str(), existed), ("file-1", true));
        }
        let (b, grant, _) = windows
            .grant(&dir.path().join("other.txt"), |_| false)
            .unwrap();
        assert_eq!(b, "file-2");
        assert_eq!(grant.kind(), FileKind::Text);
        windows.revoke("file-1");
        assert!(windows.get("file-1").is_none());
        let (c, _, existed) = windows
            .grant(&dir.path().join("note.md"), |_| false)
            .unwrap();
        assert_eq!((c.as_str(), existed), ("file-3", false));
    }

    #[test]
    fn m4c_review_i1_a_window_being_built_is_shared_and_a_closing_one_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.md"), "# n").unwrap();
        let path = dir.path().join("note.md");
        let windows = FileWindows::default();
        let none = |_: &str| false;
        let (a, first, existed) = windows.grant(&path, none).unwrap();
        assert_eq!((a.as_str(), existed), ("file-1", false));
        // A second open while the first window is still being built: the
        // same grant, and the caller builds nothing.
        let (again, _, existed) = windows.grant(&path, none).unwrap();
        assert_eq!((again.as_str(), existed), ("file-1", true));
        first.opened();
        // Its window is up: the same label.
        let (live, _, existed) = windows.grant(&path, |l| l == "file-1").unwrap();
        assert_eq!((live.as_str(), existed), ("file-1", true));
        // Built once and gone from the window list (closing): a new grant,
        // which the old window's `Destroyed` can't revoke.
        let (fresh, _, existed) = windows.grant(&path, none).unwrap();
        assert_eq!((fresh.as_str(), existed), ("file-2", false));
        windows.revoke("file-1");
        assert!(windows.get("file-2").is_some());
    }

    #[test]
    fn m4c_review_m2_files_too_large_to_edit_get_no_grant() {
        let dir = tempfile::tempdir().unwrap();
        let big = std::fs::File::create(dir.path().join("huge.log.txt")).unwrap();
        big.set_len(liber_session::TEXT_MAX_BYTES as u64 + 1)
            .unwrap();
        let page = std::fs::File::create(dir.path().join("huge.md")).unwrap();
        page.set_len(PAGE_MAX_BYTES + 1).unwrap();
        let windows = FileWindows::default();
        for name in ["huge.log.txt", "huge.md"] {
            assert_eq!(
                windows
                    .grant(&dir.path().join(name), |_| false)
                    .unwrap_err()
                    .kind,
                ErrorKind::TooLarge,
                "{name}"
            );
        }
    }

    #[test]
    fn folders_missing_and_other_files_get_no_grant() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("photo.png"), [0u8; 4]).unwrap();
        let windows = FileWindows::default();
        let kind = |p: PathBuf| windows.grant(&p, |_| false).unwrap_err().kind;
        assert_eq!(kind(dir.path().to_path_buf()), ErrorKind::NotAFile);
        assert_eq!(kind(dir.path().join("gone.md")), ErrorKind::NotFound);
        assert_eq!(kind(dir.path().join("photo.png")), ErrorKind::NotAText);
        assert!(windows.get("file-1").is_none());
    }

    #[test]
    fn links_reach_three_folders_down_and_skip_hidden_ones() {
        let dir = tempfile::tempdir().unwrap();
        for p in ["a/b/c", "a/b/c/d", ".hidden"] {
            std::fs::create_dir_all(dir.path().join(p)).unwrap();
        }
        for f in [
            "note.md",
            "a/b/c/deep.md",
            "a/b/c/d/deeper.md",
            ".hidden/h.md",
        ] {
            std::fs::write(dir.path().join(f), "").unwrap();
        }
        let windows = FileWindows::default();
        let (_, grant, _) = windows
            .grant(&dir.path().join("note.md"), |_| false)
            .unwrap();
        let files = grant.files();
        assert!(files.contains("a/b/c/deep.md"));
        assert!(!files.contains("a/b/c/d/deeper.md"));
        assert!(!files.contains(".hidden/h.md"));
    }
}
