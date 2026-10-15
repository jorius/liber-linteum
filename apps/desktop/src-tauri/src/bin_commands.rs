//! M5b §5: the vault's Trash and Archive — thin wrappers over `nimw-session`.
//! (`entry_trash` in `vault_commands` moves an item into the Trash.)

use crate::dto::RenameOutcomeDto;
use crate::error::CmdResult;
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_session::BinItem;
use nimw_vault::VaultPath;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinItemDto {
    pub path: String,
    pub from: Option<String>,
    pub at: Option<u64>,
    pub folder: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BinListsDto {
    pub trash: Vec<BinItemDto>,
    pub archive: Vec<BinItemDto>,
}

fn item(i: BinItem) -> BinItemDto {
    BinItemDto {
        path: i.path,
        from: i.from,
        at: i.at,
        folder: i.folder,
    }
}

pub(crate) fn bin_list_impl(state: &AppState) -> CmdResult<BinListsDto> {
    let s = state.session()?;
    Ok(BinListsDto {
        trash: s.trash_list()?.into_iter().map(item).collect(),
        archive: s.archive_list()?.into_iter().map(item).collect(),
    })
}

#[tauri::command]
pub async fn bin_list<R: Runtime>(app: AppHandle<R>) -> CmdResult<BinListsDto> {
    blocking(app, move |app| bin_list_impl(&app.state::<AppState>())).await
}

#[tauri::command]
pub async fn trash_restore<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    keep_both: bool,
) -> CmdResult<String> {
    blocking(app, move |app| {
        let s = app.state::<AppState>().session()?;
        Ok(s.trash_restore(&VaultPath::new(&path)?, keep_both)?
            .to_string())
    })
    .await
}

/// Deletes items from the Trash for good: to the OS trash.
#[tauri::command]
pub async fn trash_delete<R: Runtime>(app: AppHandle<R>, paths: Vec<String>) -> CmdResult<()> {
    blocking(app, move |app| {
        let paths = paths
            .iter()
            .map(|p| VaultPath::new(p))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(app.state::<AppState>().session()?.trash_delete(&paths)?)
    })
    .await
}

#[tauri::command]
pub async fn trash_empty<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| {
        Ok(app.state::<AppState>().session()?.trash_empty()?)
    })
    .await
}

#[tauri::command]
pub async fn entry_archive<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> CmdResult<RenameOutcomeDto> {
    blocking(app, move |app| {
        let state = app.state::<AppState>();
        let rewrite = state.settings.get().0.rewrite_links;
        Ok(state
            .session()?
            .archive(&VaultPath::new(&path)?, rewrite)?
            .into())
    })
    .await
}

#[tauri::command]
pub async fn archive_restore<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    keep_both: bool,
) -> CmdResult<RenameOutcomeDto> {
    blocking(app, move |app| {
        let state = app.state::<AppState>();
        let rewrite = state.settings.get().0.rewrite_links;
        Ok(state
            .session()?
            .unarchive(&VaultPath::new(&path)?, keep_both, rewrite)?
            .into())
    })
    .await
}
