//! Vault and explorer commands (M1b spec §2.4). Thin wrappers over
//! `liber-session`; every path from the UI goes through `VaultPath::new`.

use crate::dto::{
    ChangedPayload, PageDto, ProgressPayload, RenameOutcomeDto, TreeNodeDto, VaultInfo,
    WarningPayload,
};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use liber_session::{SessionEvent, VaultSession};
use liber_vault::VaultPath;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Largest page text sent to the read-only view.
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;

/// Files that may sit in a folder chosen for a new vault (OS metadata).
const OS_METADATA: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// `""` is the vault root; anything else must be a valid vault path.
fn dir_path(s: &str) -> CmdResult<VaultPath> {
    if s.is_empty() {
        Ok(VaultPath::root())
    } else {
        Ok(VaultPath::new(s)?)
    }
}

#[doc(hidden)] // public for the menu test (round 3 review #8)
pub fn open_session<R: Runtime>(app: &AppHandle<R>, root: &Path) -> CmdResult<VaultInfo> {
    let state = app.state::<AppState>();
    // An encryption in place this device left unfinished: undone or finished first.
    crate::convert_commands::recover_on_open(app, root)?;
    // An encrypted folder is `locked` here (`Vault::open`): it opens by unlocking.
    let (session, report) = VaultSession::open(root, &state.cache_dir, session_events(app))?;
    install_session(app, session, &report, false)
}

/// Forwards a session's events to the main window.
pub(crate) fn session_events<R: Runtime>(
    app: &AppHandle<R>,
) -> impl Fn(SessionEvent) + Send + Sync + 'static {
    let emitter = app.clone();
    move |event| match event {
        SessionEvent::Progress { done, total } => {
            let _ = emitter.emit_to("main", "vault:progress", ProgressPayload { done, total });
        }
        SessionEvent::Changed {
            created,
            modified,
            removed,
            renamed,
        } => {
            let _ = emitter.emit_to(
                "main",
                "vault:changed",
                ChangedPayload {
                    created,
                    modified,
                    removed,
                    renamed,
                },
            );
        }
        SessionEvent::Warning(message) => {
            let _ = emitter.emit_to("main", "vault:warning", WarningPayload { message });
        }
        SessionEvent::Indexed(_) => {}
    }
}

/// Makes `session` the open vault: starts watching, records it as recent,
/// names it in the menu.
pub(crate) fn install_session<R: Runtime>(
    app: &AppHandle<R>,
    session: VaultSession,
    report: &liber_session::IndexReport,
    recovery_void: bool,
) -> CmdResult<VaultInfo> {
    let state = app.state::<AppState>();
    let session = Arc::new(session);
    session.start_watching()?;
    let root = session.vault().root().to_path_buf();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let mut report: crate::dto::IndexReportDto = report.into();
    // A read-only config dir must not stop the vault from opening (M1b §10 j).
    if let Err(e) = state.settings.push_recent(&root, &name) {
        report
            .warnings
            .push(format!("recent vaults could not be saved: {e}"));
    }
    let icon = session
        .vault()
        .vault_icon()
        .filter(|i| liber_markdown::is_icon(i));
    let encrypted = session.vault().encrypted().is_some();
    leave_encrypted(app);
    state.set_session(Some(session));
    let scratchpad = state.settings.is_scratchpad(&root);
    state.set_scratchpad_root(scratchpad.then(|| root.clone()));
    // File → Create New Scratchpad names the vault (round 3 §9.4).
    crate::menu::show_vault_in_menu(app, Some(if scratchpad { "Quick notes" } else { &name }));
    Ok(VaultInfo {
        name,
        scratchpad,
        icon,
        root: root.to_string_lossy().into_owned(),
        report,
        encrypted,
        recovery_void,
        recovered: Vec::new(),
        originals_pending: false,
    })
}

pub(crate) async fn blocking<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    f: impl FnOnce(AppHandle<R>) -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(app))
        .await
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?
}

#[tauri::command]
pub async fn vault_open<R: Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<VaultInfo> {
    blocking(app, move |app| open_session(&app, &path)).await
}

#[tauri::command]
pub async fn vault_create<R: Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<VaultInfo> {
    blocking(app, move |app| {
        if path.exists() {
            let occupied = std::fs::read_dir(&path)? // seam: outside (the folder about to become a vault)
                .filter_map(|e| e.ok())
                .any(|e| !OS_METADATA.contains(&e.file_name().to_string_lossy().as_ref()));
            if occupied {
                return Err(CommandError::new(
                    ErrorKind::NotEmpty,
                    format!("{} is not empty", path.display()),
                ));
            }
        } else {
            std::fs::create_dir_all(&path)?; // seam: outside (the folder about to become a vault)
        }
        open_session(&app, &path)
    })
    .await
}

/// What the folder chosen in the New vault dialog holds (encryption UX round
/// §2): `missing`, `empty` (as an encrypted create counts it), `plain` (files,
/// a plain vault or not), `encrypted`, `damaged`, or `refused` (never
/// encrypted in place, §8.10). Reads only, after this device's interrupted
/// conversion of it is finished or undone: mid-commit it reads as damaged.
#[tauri::command]
pub async fn folder_kind<R: Runtime>(app: AppHandle<R>, path: PathBuf) -> CmdResult<&'static str> {
    blocking(app, move |app| {
        if !path.exists() {
            return Ok("missing");
        }
        crate::convert_commands::recover_on_open(&app, &path)?;
        Ok(folder_kind_of(&app, &path))
    })
    .await
}

fn folder_kind_of<R: Runtime>(app: &AppHandle<R>, path: &Path) -> &'static str {
    match liber_vault::vault_kind(path) {
        liber_vault::VaultKind::Encrypted => "encrypted",
        liber_vault::VaultKind::Damaged(_) => "damaged",
        _ if is_refused(app, path) => "refused",
        liber_vault::VaultKind::Plain if liber_vault::is_empty_for_create(path) => "empty",
        liber_vault::VaultKind::Plain => "plain",
    }
}

/// Never encrypted in place (§8.10): the Scratchpad, home, Desktop,
/// Documents, Downloads, a volume root. The UI's early answer; the convert
/// commands refuse them again.
fn is_refused<R: Runtime>(app: &AppHandle<R>, path: &Path) -> bool {
    let canon = |p: &Path| dunce::canonicalize(p).ok(); // seam: outside (only compared)
    let Some(root) = canon(path) else {
        return false;
    };
    let state = app.state::<AppState>();
    let dirs = app.path();
    let listed = [
        dirs.home_dir(),
        dirs.desktop_dir(),
        dirs.document_dir(),
        dirs.download_dir(),
    ];
    let volume_root = match root.parent() {
        None => true,
        #[cfg(unix)]
        Some(parent) => {
            use std::os::unix::fs::MetadataExt; // seam: outside (a volume root: st_dev, compared)
            let dev = |p: &Path| p.metadata().map(|m| m.dev());
            matches!((dev(&root), dev(parent)), (Ok(a), Ok(b)) if a != b)
        }
        #[cfg(not(unix))]
        Some(_) => false,
    };
    volume_root
        || state.settings.is_scratchpad(&root)
        || state.opened_as_scratchpad(&root)
        || listed
            .into_iter()
            .flatten()
            .any(|d| canon(&d).as_deref() == Some(root.as_path()))
}

pub(crate) fn vault_close_impl(state: &AppState) {
    state.set_session(None);
}

/// Before an encrypted vault stops being the open one, its take in progress
/// is stopped and kept, as Lock does (spec §6.2); `set_session` then locks it.
/// The take held the session, so dropping it alone kept the keys (review M4).
fn leave_encrypted<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if state
        .session()
        .is_ok_and(|s| s.vault().encrypted().is_some())
    {
        crate::audio_commands::stop_for_lock(app);
    }
}

/// Closes the vault and puts the generic File-menu label back.
#[doc(hidden)] // public for the menu test (round 3 review #8)
pub fn close_session<R: Runtime>(app: &AppHandle<R>) {
    leave_encrypted(app);
    vault_close_impl(&app.state::<AppState>());
    crate::menu::show_vault_in_menu(app, None);
}

/// Archived pages are read-only (M5b round 2): anything that would change
/// one, or put something in the Archive, is refused. Unarchive and Move to
/// Trash have their own commands.
pub(crate) fn not_archived(path: &str) -> CmdResult<()> {
    // Any letter case: on a case-insensitive disk `.ARCHIVE/x` is the Archive (round-2 review M3).
    let first = path.split('/').next().unwrap_or_default();
    if first.eq_ignore_ascii_case(liber_vault::ARCHIVE_DIR) {
        return Err(CommandError::new(
            ErrorKind::NotPermitted,
            format!("{path} is archived; unarchive it to change it"),
        ));
    }
    Ok(())
}

pub(crate) fn vault_tree_impl(state: &AppState) -> CmdResult<Vec<TreeNodeDto>> {
    let session = state.session()?;
    let mut folders = session.vault().folder_icons();
    Ok(session
        .tree_with_archive()?
        .into_iter()
        .map(|n| {
            // Pages: the indexed frontmatter emoji; folders: vault.json (M5b §4).
            let kind = n.kind.as_str();
            let icon = if kind == "folder" {
                folders
                    .remove(&n.path)
                    .filter(|i| liber_markdown::is_icon(i))
            } else {
                n.icon
            };
            TreeNodeDto {
                path: n.path,
                kind,
                icon,
            }
        })
        .collect())
}

pub(crate) fn page_get_impl(state: &AppState, path: String) -> CmdResult<PageDto> {
    let session = state.session()?;
    let vp = VaultPath::new(&path)?;
    let (bytes, _) = session.vault().read(&vp)?;
    let truncated = bytes.len() > MAX_PAGE_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_PAGE_BYTES)];
    let text = match std::str::from_utf8(slice) {
        Ok(t) => Some(t),
        // Cut in the middle of a character at the 1 MiB mark: keep the valid prefix.
        Err(e) if truncated && e.error_len().is_none() => {
            Some(std::str::from_utf8(&slice[..e.valid_up_to()]).expect("valid prefix"))
        }
        Err(_) => None,
    };
    let backlinks = session.backlinks(&vp)?.len();
    match (session.page(&vp)?, text) {
        (Some(page), Some(text)) => Ok(PageDto {
            path: page.path,
            title: page.title,
            subtitle: page.subtitle,
            cover: page.cover,
            cover_y: page.cover_y,
            cover_x: page.cover_x,
            tags: page.tags.into_iter().map(|t| t.text).collect(),
            links: page.links.len(),
            backlinks,
            text: text.to_string(),
            truncated,
            binary: false,
        }),
        // Not valid UTF-8: indexed as an attachment; show it as unreadable.
        (_, None) => Ok(PageDto {
            path: vp.to_string(),
            title: vp.stem().to_string(),
            subtitle: None,
            cover: None,
            cover_y: None,
            cover_x: None,
            tags: Vec::new(),
            links: 0,
            backlinks,
            text: String::new(),
            truncated: false,
            binary: true,
        }),
        (None, Some(_)) => Err(CommandError::new(
            ErrorKind::NotFound,
            format!("not a page: {path}"),
        )),
    }
}

pub(crate) fn backlink_count_impl(state: &AppState, path: String) -> CmdResult<usize> {
    Ok(state
        .session()?
        .backlinks_into(&VaultPath::new(&path)?)?
        .len())
}

pub(crate) fn entry_create_page_impl(
    state: &AppState,
    dir: String,
    name: String,
) -> CmdResult<String> {
    crate::vault_commands::not_archived(&dir)?;
    Ok(state
        .session()?
        .create_page(&dir_path(&dir)?, &name)?
        .to_string())
}

/// An empty text file `name` in `dir` (final review I6: "Save as new" for a
/// text file deleted outside the app keeps its type).
pub(crate) fn entry_create_text_impl(
    state: &AppState,
    dir: String,
    name: String,
) -> CmdResult<String> {
    crate::vault_commands::not_archived(&dir)?;
    Ok(state
        .session()?
        .create_text_file(&dir_path(&dir)?, &name)?
        .to_string())
}

pub(crate) fn entry_create_folder_impl(
    state: &AppState,
    parent: String,
    name: String,
) -> CmdResult<String> {
    crate::vault_commands::not_archived(&parent)?;
    Ok(state
        .session()?
        .create_folder(&dir_path(&parent)?, &name)?
        .to_string())
}

pub(crate) fn entry_rename_impl(
    state: &AppState,
    from: String,
    to: String,
) -> CmdResult<RenameOutcomeDto> {
    crate::vault_commands::not_archived(&from)?;
    crate::vault_commands::not_archived(&to)?;
    let rewrite = state.settings.get().0.rewrite_links;
    Ok(state
        .session()?
        .rename(&VaultPath::new(&from)?, &VaultPath::new(&to)?, rewrite)?
        .into())
}

/// Add sub-page (round 3 §9): `P.md` becomes `P/P.md`, links rewritten.
pub(crate) fn entry_make_folder_page_impl(
    state: &AppState,
    page: String,
) -> CmdResult<crate::dto::FolderPageDto> {
    crate::vault_commands::not_archived(&page)?;
    let rewrite = state.settings.get().0.rewrite_links;
    let (folder, page, outcome) = state
        .session()?
        .make_folder_page(&VaultPath::new(&page)?, rewrite)?;
    Ok(crate::dto::FolderPageDto {
        folder: folder.to_string(),
        page: page.to_string(),
        outcome: outcome.into(),
    })
}

/// Moving under a page (round 3 §9.3): one operation, refused before
/// anything moves; the page's own conversion is undone if the move fails.
pub(crate) fn entry_move_under_page_impl(
    state: &AppState,
    item: String,
    page: String,
) -> CmdResult<crate::dto::MoveUnderDto> {
    crate::vault_commands::not_archived(&item)?;
    crate::vault_commands::not_archived(&page)?;
    let rewrite = state.settings.get().0.rewrite_links;
    let out = state.session()?.move_under_page(
        &VaultPath::new(&item)?,
        &VaultPath::new(&page)?,
        rewrite,
    )?;
    Ok(crate::dto::MoveUnderDto {
        folder: out.folder.to_string(),
        page: out.page.to_string(),
        converted: out.converted.map(Into::into),
        moved: out.moved.into(),
    })
}

/// Moves an item into the vault's Trash (M5b §5.1); its path there.
pub(crate) fn entry_trash_impl(state: &AppState, path: String) -> CmdResult<String> {
    Ok(state.session()?.trash(&VaultPath::new(&path)?)?.to_string())
}

// ---- command wrappers: run off the UI thread (final review I2) ----

#[tauri::command]
pub async fn vault_close<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| {
        close_session(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn vault_tree<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<TreeNodeDto>> {
    blocking(app, move |app| vault_tree_impl(&app.state::<AppState>())).await
}

#[tauri::command]
pub async fn page_get<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<PageDto> {
    blocking(app, move |app| {
        page_get_impl(&app.state::<AppState>(), path)
    })
    .await
}

#[tauri::command]
pub async fn backlink_count<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<usize> {
    blocking(app, move |app| {
        backlink_count_impl(&app.state::<AppState>(), path)
    })
    .await
}

#[tauri::command]
pub async fn entry_create_page<R: Runtime>(
    app: AppHandle<R>,
    dir: String,
    name: String,
) -> CmdResult<String> {
    blocking(app, move |app| {
        entry_create_page_impl(&app.state::<AppState>(), dir, name)
    })
    .await
}

#[tauri::command]
pub async fn entry_create_text<R: Runtime>(
    app: AppHandle<R>,
    dir: String,
    name: String,
) -> CmdResult<String> {
    blocking(app, move |app| {
        entry_create_text_impl(&app.state::<AppState>(), dir, name)
    })
    .await
}

#[tauri::command]
pub async fn entry_create_folder<R: Runtime>(
    app: AppHandle<R>,
    parent: String,
    name: String,
) -> CmdResult<String> {
    blocking(app, move |app| {
        entry_create_folder_impl(&app.state::<AppState>(), parent, name)
    })
    .await
}

#[tauri::command]
pub async fn entry_rename<R: Runtime>(
    app: AppHandle<R>,
    from: String,
    to: String,
) -> CmdResult<RenameOutcomeDto> {
    blocking(app, move |app| {
        entry_rename_impl(&app.state::<AppState>(), from, to)
    })
    .await
}

#[tauri::command]
pub async fn entry_move_under_page<R: Runtime>(
    app: AppHandle<R>,
    item: String,
    page: String,
) -> CmdResult<crate::dto::MoveUnderDto> {
    blocking(app, move |app| {
        entry_move_under_page_impl(&app.state::<AppState>(), item, page)
    })
    .await
}

#[tauri::command]
pub async fn entry_make_folder_page<R: Runtime>(
    app: AppHandle<R>,
    page: String,
) -> CmdResult<crate::dto::FolderPageDto> {
    blocking(app, move |app| {
        entry_make_folder_page_impl(&app.state::<AppState>(), page)
    })
    .await
}

#[tauri::command]
pub async fn entry_trash<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<String> {
    blocking(app, move |app| {
        entry_trash_impl(&app.state::<AppState>(), path)
    })
    .await
}
