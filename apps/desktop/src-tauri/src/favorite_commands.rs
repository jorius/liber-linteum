//! Favorites (M5b §19) and the sidebar's Open list (0.1.2): each whole
//! ordered list is read and written at once, so adding, removing and
//! reordering are one command.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use liber_vault::{TRASH_DIR, Vault, VaultPath, is_hidden_path};
use tauri::{AppHandle, Manager, Runtime};

/// More favorites than anyone keeps in a sidebar.
const MAX: usize = 1000;
/// More open pages than anyone keeps open.
const MAX_OPEN: usize = 200;

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

/// Replaces a list: hidden or escaping paths are refused, entries that no
/// longer exist and repeats are dropped. Returns what was stored.
fn set_list(
    state: &AppState,
    paths: Vec<String>,
    (max, what): (usize, &str),
    store: impl FnOnce(&Vault, &[String]) -> liber_vault::Result<()>,
) -> CmdResult<Vec<String>> {
    if paths.len() > max {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("at most {max} {what}"),
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
                format!("not an entry the vault's {what} can hold: {path}"),
            ));
        }
        let name = entry.as_str().to_string();
        if !kept.contains(&name) && vault.stat(&entry)?.is_some() {
            kept.push(name);
        }
    }
    store(vault, &kept)?;
    Ok(kept)
}

pub(crate) fn favorites_set_impl(state: &AppState, paths: Vec<String>) -> CmdResult<Vec<String>> {
    set_list(state, paths, (MAX, "favorites"), Vault::set_favorites)
}

pub(crate) fn open_get_impl(state: &AppState) -> CmdResult<Vec<String>> {
    Ok(state.session()?.vault().open_pages())
}

pub(crate) fn open_set_impl(state: &AppState, paths: Vec<String>) -> CmdResult<Vec<String>> {
    set_list(
        state,
        paths,
        (MAX_OPEN, "open pages"),
        Vault::set_open_pages,
    )
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

#[tauri::command]
pub async fn open_get<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<String>> {
    blocking(app, move |app| open_get_impl(&app.state::<AppState>())).await
}

#[tauri::command]
pub async fn open_set<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> CmdResult<Vec<String>> {
    blocking(app, move |app| {
        open_set_impl(&app.state::<AppState>(), paths)
    })
    .await
}
