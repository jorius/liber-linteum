//! Settings and recent-vault commands (M1b spec §2.3–2.4).

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::settings::{RecentVaultDto, Settings, SettingsDto, SettingsPatch};
use crate::state::AppState;
use crate::vault_commands::blocking;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> SettingsDto {
    state.settings.dto()
}

pub(crate) fn settings_set_impl(state: &AppState, patch: SettingsPatch) -> CmdResult<Settings> {
    Ok(state.settings.update(patch)?)
}

pub(crate) fn vaults_recent_impl(state: &AppState) -> Vec<RecentVaultDto> {
    state.settings.recent()
}

pub(crate) fn vaults_forget_impl(state: &AppState, path: String) -> CmdResult<()> {
    Ok(state.settings.forget(&path)?)
}

/// R3 §7: shows a recent vault's folder in Finder or Explorer. Only a path on
/// the recent list: the webview can't ask to reveal anything else.
pub(crate) fn vaults_reveal_impl<R: Runtime>(app: &AppHandle<R>, path: String) -> CmdResult<()> {
    if !app.state::<AppState>().settings.is_recent(&path) {
        return Err(CommandError::new(
            ErrorKind::NotPermitted,
            "only a recent vault can be revealed",
        ));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

// ---- command wrappers: run off the UI thread (final review I2) ----

#[tauri::command]
pub async fn settings_set<R: Runtime>(
    app: AppHandle<R>,
    patch: SettingsPatch,
) -> CmdResult<Settings> {
    blocking(app, move |app| {
        let settings = settings_set_impl(&app.state::<AppState>(), patch)?;
        // Every window shows the change (M4c §3: single-file windows too).
        let _ = app.emit(SETTINGS_CHANGED_EVENT, &settings);
        Ok(settings)
    })
    .await
}

/// Sent to every window after a settings change, with the new settings.
pub const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

#[tauri::command]
pub async fn vaults_recent<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<RecentVaultDto>> {
    blocking(app, move |app| {
        Ok(vaults_recent_impl(&app.state::<AppState>()))
    })
    .await
}

#[tauri::command]
pub async fn vaults_forget<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<()> {
    blocking(app, move |app| {
        vaults_forget_impl(&app.state::<AppState>(), path)
    })
    .await
}

#[tauri::command]
pub async fn vaults_reveal<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<()> {
    blocking(app, move |app| vaults_reveal_impl(&app, path)).await
}
