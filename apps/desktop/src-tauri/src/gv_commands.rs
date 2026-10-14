//! M3a §8: the Global View — levels and their cards, edges between visible
//! cards, pinned card positions. Thin wrappers over `nimw-session`.

use crate::dto::{GvCardDto, GvEdgeDto, GvLevelDto, GvLevelResultDto};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_session::{GvLevel, MAX_VISIBLE};
use nimw_vault::{CardPosition, VaultPath};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager, Runtime};

pub(crate) fn gv_children_impl(state: &AppState, level: GvLevelDto) -> CmdResult<GvLevelResultDto> {
    let session = state.session()?;
    let level = match level {
        GvLevelDto::Vault => GvLevel::Vault,
        GvLevelDto::Folder { path } => GvLevel::Folder(VaultPath::new(&path)?),
        GvLevelDto::Page { path } => GvLevel::Page(VaultPath::new(&path)?),
    };
    let found = session.gv_children(&level)?;
    Ok(GvLevelResultDto {
        cards: found.cards.into_iter().map(Into::into).collect(),
        centre: found.centre,
        omitted: found.omitted,
    })
}

pub(crate) fn gv_edges_impl(state: &AppState, visible: Vec<String>) -> CmdResult<Vec<GvEdgeDto>> {
    if visible.len() > MAX_VISIBLE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("at most {MAX_VISIBLE} cards at once"),
        ));
    }
    let session = state.session()?;
    Ok(session
        .gv_edges(&visible)?
        .into_iter()
        .map(Into::into)
        .collect())
}

pub(crate) fn layout_get_impl(
    state: &AppState,
    level: String,
) -> CmdResult<BTreeMap<String, CardPosition>> {
    Ok(state.session()?.vault().layout_level(&level))
}

pub(crate) fn layout_set_impl(
    state: &AppState,
    level: String,
    positions: BTreeMap<String, CardPosition>,
) -> CmdResult<()> {
    state
        .session()?
        .vault()
        .set_layout_level(&level, &positions)?;
    Ok(())
}

#[tauri::command]
pub async fn gv_children<R: Runtime>(
    app: AppHandle<R>,
    level: GvLevelDto,
) -> CmdResult<GvLevelResultDto> {
    blocking(app, move |app| {
        gv_children_impl(&app.state::<AppState>(), level)
    })
    .await
}

#[tauri::command]
pub async fn gv_edges<R: Runtime>(
    app: AppHandle<R>,
    visible: Vec<String>,
) -> CmdResult<Vec<GvEdgeDto>> {
    blocking(app, move |app| {
        gv_edges_impl(&app.state::<AppState>(), visible)
    })
    .await
}

#[tauri::command]
pub async fn layout_get<R: Runtime>(
    app: AppHandle<R>,
    level: String,
) -> CmdResult<BTreeMap<String, CardPosition>> {
    blocking(app, move |app| {
        layout_get_impl(&app.state::<AppState>(), level)
    })
    .await
}

#[tauri::command]
pub async fn layout_set<R: Runtime>(
    app: AppHandle<R>,
    level: String,
    positions: BTreeMap<String, CardPosition>,
) -> CmdResult<()> {
    blocking(app, move |app| {
        layout_set_impl(&app.state::<AppState>(), level, positions)
    })
    .await
}

pub(crate) fn link_target_impl(
    state: &AppState,
    source: String,
    target: String,
) -> CmdResult<String> {
    Ok(state
        .session()?
        .link_target(&VaultPath::new(&source)?, &VaultPath::new(&target)?)?)
}

pub(crate) fn index_pick_set_impl(
    state: &AppState,
    folder: String,
    page: Option<String>,
) -> CmdResult<GvCardDto> {
    let page = page.as_deref().map(VaultPath::new).transpose()?;
    Ok(state
        .session()?
        .index_pick_set(&VaultPath::new(&folder)?, page.as_ref())?
        .into())
}

/// M3b §6: the shortest wiki target from `source` to the vault path `target`.
#[tauri::command]
pub async fn link_target<R: Runtime>(
    app: AppHandle<R>,
    source: String,
    target: String,
) -> CmdResult<String> {
    blocking(app, move |app| {
        link_target_impl(&app.state::<AppState>(), source, target)
    })
    .await
}

/// M3b §4: picks (or clears, `page: null`) a folder's index note.
#[tauri::command]
pub async fn index_pick_set<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    page: Option<String>,
) -> CmdResult<GvCardDto> {
    blocking(app, move |app| {
        index_pick_set_impl(&app.state::<AppState>(), folder, page)
    })
    .await
}
