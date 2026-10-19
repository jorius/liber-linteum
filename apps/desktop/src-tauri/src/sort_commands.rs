//! Folder orders (M5b round 2): how a folder (or the vault root, `""`) lists
//! its entries, kept in `.nimw/vault.json`; the session applies them to the
//! tree.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_vault::{EntryKind, FolderSort, VaultPath, is_archived, is_hidden_name};
use tauri::{AppHandle, Manager, Runtime};

/// `""` (the root), or a folder in the vault: visible, or in the Archive.
fn folder(state: &AppState, path: &str) -> CmdResult<String> {
    if path.is_empty() {
        return Ok(String::new());
    }
    let session = state.session()?;
    let vp = VaultPath::new(path)?;
    let shown = is_archived(vp.as_str()) || !vp.as_str().split('/').any(is_hidden_name);
    let is_dir = session
        .vault()
        .stat(&vp)?
        .is_some_and(|e| e.kind == EntryKind::Dir);
    if !shown || !is_dir {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("not a folder in the vault: {path}"),
        ));
    }
    Ok(vp.as_str().to_string())
}

pub(crate) fn folder_sort_get_impl(state: &AppState, path: String) -> CmdResult<FolderSort> {
    let path = folder(state, &path)?;
    let session = state.session()?;
    Ok(session
        .vault()
        .folder_sorts()
        .remove(&path)
        .unwrap_or_default())
}

pub(crate) fn folder_sort_set_impl(
    state: &AppState,
    path: String,
    sort: FolderSort,
) -> CmdResult<()> {
    let path = folder(state, &path)?;
    state.session()?.vault().set_folder_sort(&path, sort)?;
    Ok(())
}

#[tauri::command]
pub async fn folder_sort_get<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<FolderSort> {
    blocking(app, move |app| {
        folder_sort_get_impl(&app.state::<AppState>(), path)
    })
    .await
}

#[tauri::command]
pub async fn folder_sort_set<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    sort: FolderSort,
) -> CmdResult<()> {
    blocking(app, move |app| {
        folder_sort_set_impl(&app.state::<AppState>(), path, sort)
    })
    .await
}
