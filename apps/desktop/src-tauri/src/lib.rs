pub mod commands;
pub mod dto;
pub mod error;
pub mod settings;
pub mod settings_commands;
pub mod state;
pub mod vault_commands;

use settings::SettingsStore;
use state::AppState;
use std::path::PathBuf;
use tauri::Manager;

/// Where settings and the index cache live. `None` in `configure` means the
/// OS app config/cache dirs for `app.notesinmyway.desktop`; tests pass temp dirs.
#[derive(Debug, Clone)]
pub struct AppDirs {
    pub config: PathBuf,
    pub cache: PathBuf,
}

/// Registers everything the app exposes to the webview. Shared by `run()` and the
/// IPC integration tests so the tests exercise the real command registration.
pub fn configure<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    dirs: Option<AppDirs>,
) -> tauri::Builder<R> {
    let builder = builder.plugin(tauri_plugin_dialog::init());
    // Known dirs (tests): manage the state up front. Otherwise resolve the OS
    // dirs once the app exists.
    let builder = match dirs {
        Some(dirs) => builder.manage(AppState::new(SettingsStore::load(&dirs.config), dirs.cache)),
        None => builder.setup(|app| {
            let config = app.path().app_config_dir()?;
            let cache = app.path().app_cache_dir()?;
            app.manage(AppState::new(SettingsStore::load(&config), cache));
            Ok(())
        }),
    };
    builder.invoke_handler(tauri::generate_handler![
        commands::app_info,
        vault_commands::vault_open,
        vault_commands::vault_create,
        vault_commands::vault_close,
        vault_commands::vault_tree,
        vault_commands::page_get,
        vault_commands::backlink_count,
        vault_commands::entry_create_page,
        vault_commands::entry_create_folder,
        vault_commands::entry_rename,
        vault_commands::entry_trash,
        settings_commands::settings_get,
        settings_commands::settings_set,
        settings_commands::vaults_recent,
        settings_commands::vaults_forget,
    ])
}

pub fn run() {
    configure(tauri::Builder::default(), None)
        .run(tauri::generate_context!())
        .expect("error while running Notes In My Way");
}
