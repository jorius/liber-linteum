pub mod asset;
pub mod attachment_commands;
pub mod commands;
pub mod drops;
pub mod dto;
pub mod editor_commands;
pub mod error;
pub mod external_commands;
pub mod file_commands;
pub mod file_windows;
pub mod fonts;
pub mod gv_commands;
pub mod menu;
pub mod navigation;
pub mod opening;
pub mod scratchpad_commands;
pub mod search_commands;
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
        // Single-file windows' grants (M4c §3).
        .manage(file_windows::FileWindows::default())
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
        // Quick notes (M4c): the folder dialog and its grant.
        .manage(scratchpad_commands::ScratchpadState::default())
        .register_asynchronous_uri_scheme_protocol(asset::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // A single-file window is served its file's folder (M4c §4).
            let label = ctx.webview_label().to_string();
            std::thread::spawn(move || {
                let state = app.try_state::<AppState>();
                let files = app.try_state::<file_windows::FileWindows>();
                let response = match (state, files) {
                    (Some(state), Some(files)) => {
                        let range = request
                            .headers()
                            .get("range")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                        asset::serve_window(
                            &state,
                            &files,
                            &label,
                            request.uri().path(),
                            range.as_deref(),
                        )
                    }
                    _ => asset::AssetResponse {
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
        commands::window_close_self,
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
        gv_commands::gv_children,
        gv_commands::gv_edges,
        gv_commands::layout_get,
        gv_commands::layout_set,
        gv_commands::link_target,
        gv_commands::index_pick_set,
        attachment_commands::page_width_set,
        editor_commands::text_read,
        editor_commands::text_write,
        vault_commands::entry_create_text,
        attachment_commands::cover_height_set,
        attachment_commands::cover_side_set,
        attachment_commands::cover_width_set,
        external_commands::links_external,
        external_commands::external_open,
        external_commands::external_reveal,
        external_commands::external_network_allow,
        external_commands::file_pick,
        scratchpad_commands::scratchpad_default,
        scratchpad_commands::scratchpad_choose,
        scratchpad_commands::scratchpad_set,
        scratchpad_commands::scratchpad_open,
        scratchpad_commands::quick_note_create,
        scratchpad_commands::quick_note_autoname,
        scratchpad_commands::quick_notes_state,
        scratchpad_commands::scratch_folder_set,
        // Single-file windows (M4c §3, §4).
        file_commands::file_info,
        file_commands::file_read,
        file_commands::file_write,
        file_commands::file_conflict_copy,
        file_commands::file_recreate,
        file_commands::file_rename,
        file_commands::file_links_resolve,
        file_commands::file_note_read,
        file_commands::file_follow,
        file_commands::file_open_in_vault,
        file_commands::file_open_dialog,
        search_commands::search,
    ])
}

pub fn run() {
    let builder = tauri::Builder::default();
    // M4c §3: a second launch (a file opened from Explorer, a command line)
    // hands its files to this one. Registered first, as the plugin asks;
    // never in tests (a second app in the test process would exit it).
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let args: Vec<std::ffi::OsString> = args.into_iter().skip(1).map(Into::into).collect();
        let cwd = std::path::Path::new(&cwd);
        opening::open_later(app, opening::paths_from_args(&args, cwd));
    }));
    menu::with_app_menu(configure(builder, None))
        .build(tauri::generate_context!())
        .expect("error while building Notes In My Way")
        .run(|app, event| match event {
            // Files named on the command line that started the app.
            tauri::RunEvent::Ready => {
                let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
                let cwd = std::env::current_dir().unwrap_or_default();
                opening::open_later(app, opening::paths_from_args(&args, &cwd));
            }
            // Finder's Open With and the Dock (M4c §3).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                opening::open_later(app, opening::paths_from_urls(&urls));
            }
            _ => {}
        });
}
