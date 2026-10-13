//! Font families installed on this computer (M2b §5), for the Live Preview
//! and Source font pickers. Read from the local font files with `fontdb`
//! (no network, no file access from the webview); the webview then uses a
//! family by name in `font-family`.

use crate::error::CmdResult;
use crate::vault_commands::blocking;
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime};

/// The family names of every installed font: English names where a font has
/// several, hidden families (`.SF NS…`) removed, unique and sorted ignoring
/// case.
pub fn system_families() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut names: Vec<String> = db
        .faces()
        .filter_map(|face| {
            face.families
                .iter()
                .find(|(_, lang)| *lang == fontdb::Language::English_UnitedStates)
                .or_else(|| face.families.first())
                .map(|(name, _)| name.trim().to_string())
        })
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup_by_key(|n| n.to_lowercase());
    names
}

static FAMILIES: OnceLock<Vec<String>> = OnceLock::new();

/// Installed font families, read once per app session (scanning takes a
/// moment on machines with many fonts).
#[tauri::command]
pub async fn fonts_list<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<String>> {
    blocking(app, |_| Ok(FAMILIES.get_or_init(system_families).clone())).await
}
