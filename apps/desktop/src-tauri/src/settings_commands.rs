//! Settings and recent-vault commands (M1b spec §2.3–2.4).

use crate::error::CmdResult;
use crate::settings::{RecentVaultDto, Settings, SettingsDto, SettingsPatch};
use crate::state::AppState;
use crate::vault_commands::blocking;
use tauri::{AppHandle, Manager, Runtime, State};

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

// ---- command wrappers: run off the UI thread (final review I2) ----

#[tauri::command]
pub async fn settings_set<R: Runtime>(
    app: AppHandle<R>,
    patch: SettingsPatch,
) -> CmdResult<Settings> {
    blocking(app, move |app| {
        settings_set_impl(&app.state::<AppState>(), patch)
    })
    .await
}

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
