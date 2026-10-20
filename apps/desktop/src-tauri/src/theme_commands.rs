//! Custom themes (custom themes §4): export and import a theme file through
//! the native dialogs. The JSON itself is built and validated in the UI.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// A theme file is small; anything bigger is not one.
pub const MAX_THEME_FILE: u64 = 64 * 1024;

/// Asks where to save `<name>.liber-theme.json` and writes `json` there;
/// `false` when the user cancels.
#[tauri::command]
pub async fn theme_export<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    json: String,
) -> CmdResult<bool> {
    blocking(app, move |app| {
        let state = app.state::<AppState>();
        // Tests replace the dialog through the cover picker hook (M2c §7.4).
        let picked = match state.cover_picker() {
            Some(pick) => pick(),
            None => app
                .dialog()
                .file()
                .add_filter("Liber Linteum theme", &["json"])
                .set_file_name(format!("{name}.liber-theme.json"))
                .blocking_save_file()
                .and_then(|f| f.into_path().ok()),
        };
        let Some(path) = picked else {
            return Ok(false);
        };
        std::fs::write(&path, json)?; // seam: outside (app-chosen export path, not vault content)
        Ok(true)
    })
    .await
}

/// Asks for a theme file and returns its text; `None` when cancelled.
#[tauri::command]
pub async fn theme_import<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<String>> {
    blocking(app, |app| {
        let state = app.state::<AppState>();
        let picked = match state.cover_picker() {
            Some(pick) => pick(),
            None => app
                .dialog()
                .file()
                .add_filter("Liber Linteum theme", &["json"])
                .blocking_pick_file()
                .and_then(|f| f.into_path().ok()),
        };
        let Some(path) = picked else {
            return Ok(None);
        };
        let len = std::fs::metadata(&path)?.len(); // seam: outside (app-chosen import path)
        if len > MAX_THEME_FILE {
            return Err(CommandError::new(
                ErrorKind::InvalidInput,
                "this file is too big to be a theme",
            ));
        }
        Ok(Some(std::fs::read_to_string(&path)?)) // seam: outside (app-chosen import path)
    })
    .await
}
