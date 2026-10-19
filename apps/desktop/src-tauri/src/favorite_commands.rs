//! Favorites (M5b §19): the whole ordered list is read and written at once,
//! so adding, removing and reordering are one command.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_vault::{TRASH_DIR, VaultPath, is_hidden_path};
use tauri::{AppHandle, Manager, Runtime};

/// More favorites than anyone keeps in a sidebar.
const MAX: usize = 1000;

/// A path the list may hold: a visible entry, an archived one, or one the
/// list followed into the Trash (so Restore brings it back).
fn allowed(path: &str) -> bool {
    match path
        .strip_prefix(TRASH_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        Some(rest) => !rest.is_empty() && !is_hidden_path(rest),
        None => !path.is_empty() && !is_hidden_path(path),
    }
}

pub(crate) fn favorites_get_impl(state: &AppState) -> CmdResult<Vec<String>> {
    Ok(state.session()?.vault().favorites())
}

/// Replaces the list: hidden or escaping paths are refused, entries that no
/// longer exist and repeats are dropped. Returns what was stored.
pub(crate) fn favorites_set_impl(state: &AppState, paths: Vec<String>) -> CmdResult<Vec<String>> {
    if paths.len() > MAX {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("at most {MAX} favorites"),
        ));
    }
    let session = state.session()?;
    let vault = session.vault();
    let mut kept: Vec<String> = Vec::new();
    for path in paths {
        let entry = VaultPath::new(&path)?;
        if !allowed(entry.as_str()) {
            return Err(CommandError::new(
                ErrorKind::NotPermitted,
                format!("not a favorite the vault can hold: {path}"),
            ));
        }
        let name = entry.as_str().to_string();
        if !kept.contains(&name) && vault.stat(&entry)?.is_some() {
            kept.push(name);
        }
    }
    vault.set_favorites(&kept)?;
    Ok(kept)
}

#[tauri::command]
pub async fn favorites_get<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<String>> {
    blocking(app, move |app| favorites_get_impl(&app.state::<AppState>())).await
}

#[tauri::command]
pub async fn favorites_set<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
) -> CmdResult<Vec<String>> {
    blocking(app, move |app| {
        favorites_set_impl(&app.state::<AppState>(), paths)
    })
    .await
}
