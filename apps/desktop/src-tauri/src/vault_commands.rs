//! Vault and explorer commands (M1b spec §2.4). Thin wrappers over
//! `nimw-session`; every path from the UI goes through `VaultPath::new`.

use crate::dto::{
    ChangedPayload, PageDto, ProgressPayload, RenameOutcomeDto, TreeNodeDto, VaultInfo,
    WarningPayload,
};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use nimw_session::{SessionEvent, VaultSession};
use nimw_vault::VaultPath;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

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

fn open_session<R: Runtime>(app: &AppHandle<R>, root: &Path) -> CmdResult<VaultInfo> {
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
    state.settings.push_recent(&root, &name)?;
    state.set_session(Some(session));
    Ok(VaultInfo {
        name,
        root: root.to_string_lossy().into_owned(),
        report: (&report).into(),
    })
}

async fn blocking<R: Runtime, T: Send + 'static>(
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
            let occupied = std::fs::read_dir(&path)?
                .filter_map(|e| e.ok())
                .any(|e| !OS_METADATA.contains(&e.file_name().to_string_lossy().as_ref()));
            if occupied {
                return Err(CommandError::new(
                    ErrorKind::NotEmpty,
                    format!("{} is not empty", path.display()),
                ));
            }
        } else {
            std::fs::create_dir_all(&path)?;
        }
        open_session(&app, &path)
    })
    .await
}

#[tauri::command]
pub fn vault_close(state: State<'_, AppState>) {
    state.set_session(None);
}

#[tauri::command]
pub fn vault_tree(state: State<'_, AppState>) -> CmdResult<Vec<TreeNodeDto>> {
    Ok(state
        .session()?
        .tree()?
        .into_iter()
        .map(|n| TreeNodeDto {
            path: n.path,
            kind: n.kind.as_str(),
        })
        .collect())
}

#[tauri::command]
pub fn page_get(state: State<'_, AppState>, path: String) -> CmdResult<PageDto> {
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

#[tauri::command]
pub fn backlink_count(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    Ok(state
        .session()?
        .backlinks_into(&VaultPath::new(&path)?)?
        .len())
}

#[tauri::command]
pub fn entry_create_page(
    state: State<'_, AppState>,
    dir: String,
    name: String,
) -> CmdResult<String> {
    Ok(state
        .session()?
        .create_page(&dir_path(&dir)?, &name)?
        .to_string())
}

#[tauri::command]
pub fn entry_create_folder(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<String> {
    Ok(state
        .session()?
        .create_folder(&dir_path(&parent)?, &name)?
        .to_string())
}

#[tauri::command]
pub fn entry_rename(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> CmdResult<RenameOutcomeDto> {
    let rewrite = state.settings.get().0.rewrite_links;
    Ok(state
        .session()?
        .rename(&VaultPath::new(&from)?, &VaultPath::new(&to)?, rewrite)?
        .into())
}

#[tauri::command]
pub fn entry_trash(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    Ok(state.session()?.trash(&VaultPath::new(&path)?)?)
}
