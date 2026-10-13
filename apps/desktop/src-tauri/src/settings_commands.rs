//! Settings and recent-vault commands (M1b spec §2.3–2.4).

use crate::error::CmdResult;
use crate::settings::{RecentVaultDto, Settings, SettingsDto, SettingsPatch};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> SettingsDto {
    state.settings.dto()
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, patch: SettingsPatch) -> CmdResult<Settings> {
    Ok(state.settings.update(patch)?)
}

#[tauri::command]
pub fn vaults_recent(state: State<'_, AppState>) -> Vec<RecentVaultDto> {
    state.settings.recent()
}

#[tauri::command]
pub fn vaults_forget(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    Ok(state.settings.forget(&path)?)
}
