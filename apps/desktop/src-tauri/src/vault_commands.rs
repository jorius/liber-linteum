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
    let emitter = app.clone();
    let (session, report) = VaultSession::open(root, &state.cache_dir, move |event| match event {
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
    })?;
    let session = Arc::new(session);
    session.start_watching()?;
    let root = session.vault().root().to_path_buf();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let mut report: crate::dto::IndexReportDto = (&report).into();
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

pub(crate) fn vault_close_impl(state: &AppState) {
    state.set_session(None);
}

/// Closes the vault and puts the generic File-menu label back.
#[doc(hidden)] // public for the menu test (round 3 review #8)
pub fn close_session<R: Runtime>(app: &AppHandle<R>) {
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
