//! Folder and vault icons (M5b §4). Page icons are frontmatter, written by
//! the page's own edit path.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_vault::{EntryKind, VaultPath, is_hidden_name};
use tauri::{AppHandle, Manager, Runtime};

/// `None` clears; anything that isn't one emoji is refused.
fn checked(icon: Option<String>) -> CmdResult<Option<String>> {
    match icon {
        Some(icon) if !nimw_markdown::is_icon(&icon) => Err(CommandError::new(
            ErrorKind::InvalidName,
            format!("not an emoji icon: {icon:?}"),
        )),
        icon => Ok(icon),
    }
}

pub(crate) fn folder_icon_set_impl(
    state: &AppState,
    path: String,
    icon: Option<String>,
) -> CmdResult<()> {
    let session = state.session()?;
    let icon = checked(icon)?;
    let folder = VaultPath::new(&path)?;
    let visible = !folder.as_str().split('/').any(is_hidden_name);
    let is_dir = session
        .vault()
        .stat(&folder)?
        .is_some_and(|e| e.kind == EntryKind::Dir);
    if !visible || !is_dir {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("not a folder in the vault: {path}"),
        ));
    }
    session
        .vault()
        .set_folder_icon(folder.as_str(), icon.as_deref())?;
    Ok(())
}

pub(crate) fn vault_icon_set_impl(state: &AppState, icon: Option<String>) -> CmdResult<()> {
    let session = state.session()?;
    let icon = checked(icon)?;
    session.vault().set_vault_icon(icon.as_deref())?;
    Ok(())
}

#[tauri::command]
pub async fn folder_icon_set<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    icon: Option<String>,
) -> CmdResult<()> {
    blocking(app, move |app| {
        folder_icon_set_impl(&app.state::<AppState>(), path, icon)
    })
    .await
}

#[tauri::command]
pub async fn vault_icon_set<R: Runtime>(app: AppHandle<R>, icon: Option<String>) -> CmdResult<()> {
    blocking(app, move |app| {
        vault_icon_set_impl(&app.state::<AppState>(), icon)
    })
    .await
}
