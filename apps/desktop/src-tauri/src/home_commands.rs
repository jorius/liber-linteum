//! A vault's home: what shows when it opens, a page (or text file) or the
//! Global View, kept in `.liber/vault.json` (plain and encrypted vaults alike:
//! it goes through the storage seam). `vault_open` sends it in `VaultInfo`;
//! these read it again after renames and change it.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use liber_session::is_text_path;
use liber_vault::{EntryKind, Home, VaultPath, is_archived};
use tauri::{AppHandle, Manager, Runtime};

pub(crate) fn home_get_impl(state: &AppState) -> CmdResult<Option<Home>> {
    Ok(state.session()?.vault().home())
}

/// Sets the home (`None` clears it) and returns what is stored. A page must
/// be a page or text file in the vault, outside the Trash and the Archive.
pub(crate) fn home_set_impl(state: &AppState, home: Option<Home>) -> CmdResult<Option<Home>> {
    let session = state.session()?;
    let vault = session.vault();
    let home = match home {
        Some(Home::Page { path }) => {
            let entry = VaultPath::new(&path)?;
            let name = entry.as_str();
            if is_archived(name)
                || !(name.to_ascii_lowercase().ends_with(".md") || is_text_path(name))
            {
                return Err(CommandError::new(
                    ErrorKind::NotPermitted,
                    format!("not a page the vault can open to: {path}"),
                ));
            }
            // `stat` leaves hidden paths (the Trash, `.liber`) out.
            match vault.stat(&entry)? {
                Some(e) if e.kind == EntryKind::File => {}
                _ => {
                    return Err(CommandError::new(
                        ErrorKind::NotFound,
                        format!("not in the vault: {path}"),
                    ));
                }
            }
            Some(Home::Page {
                path: name.to_string(),
            })
        }
        other => other,
    };
    vault.set_home(home.as_ref())?;
    Ok(vault.home())
}

#[tauri::command]
pub async fn home_get<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<Home>> {
    blocking(app, move |app| home_get_impl(&app.state::<AppState>())).await
}

#[tauri::command]
pub async fn home_set<R: Runtime>(
    app: AppHandle<R>,
    home: Option<Home>,
) -> CmdResult<Option<Home>> {
    blocking(app, move |app| {
        home_set_impl(&app.state::<AppState>(), home)
    })
    .await
}
