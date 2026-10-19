pub mod asset;
pub mod attachment_commands;
pub mod commands;
pub mod drops;
pub mod dto;
pub mod editor_commands;
pub mod error;
pub mod fonts;
pub mod menu;
pub mod navigation;
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
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        // Used only from our own commands (url_open, file_open_external); the
        // webview gets no opener permission.
        .plugin(tauri_plugin_opener::init())
        // The webview only ever shows the app itself (no vault file, no web page).
        .plugin(navigation::guard())
        // Our Quit item (macOS app menu) closes the windows through their close
        // request, so the UI saves pending pages first (see `menu`).
        .on_menu_event(menu::on_menu_event)
        // Files dropped from the OS become importable (M2c §8).
        .on_window_event(drops::on_window_event)
        .on_webview_event(drops::on_webview_event)
        .register_asynchronous_uri_scheme_protocol(asset::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let response = match app.try_state::<AppState>() {
                    Some(state) => {
                        let range = request
                            .headers()
                            .get("range")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                        asset::serve(&state, request.uri().path(), range.as_deref())
                    }
                    None => asset::AssetResponse {
                        status: 404,
                        mime: "text/plain",
                        body: Vec::new(),
                        headers: Vec::new(),
                    },
                };
                responder.respond(response.into_response());
            });
        });
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
        editor_commands::page_read,
        editor_commands::page_write,
        editor_commands::page_create_conflict_copy,
        editor_commands::links_resolve,
        editor_commands::url_open,
        editor_commands::file_open_external,
        fonts::fonts_list,
        attachment_commands::vault_settings_get,
        attachment_commands::vault_settings_set,
        attachment_commands::attachment_paste,
        attachment_commands::attachment_import,
        attachment_commands::cover_pick,
        attachment_commands::link_suggest,
    ])
}

pub fn run() {
    menu::with_app_menu(configure(tauri::Builder::default(), None))
        .run(tauri::generate_context!())
        .expect("error while running Notes In My Way");
}
