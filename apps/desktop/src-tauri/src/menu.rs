//! The macOS app menu (M2a §3.3 quit flush, final review I1).
//!
//! Tauri's default macOS menu uses the predefined Quit item, which calls
//! `-[NSApp terminate:]`: tao turns that into `applicationWillTerminate` →
//! `RunEvent::Exit` with no `CloseRequested`, so ⌘Q skipped the UI's
//! save-before-close guard and could drop the last half second of typing.
//!
//! This menu keeps the standard items but its Quit is our own item: it asks
//! every window to close (`Window::close`), which tauri-runtime-wry handles
//! exactly like the title-bar close button (`WindowMessage::Close` and tao's
//! `CloseRequested` both go through `on_close_requested`). The UI's
//! close-requested listener then saves pending pages (or keeps the window open
//! when text can't be written) and destroys the window; the app exits when the
//! last window is gone. The window plugin's `destroy` permission it uses is
//! already granted (`core:window:allow-destroy`).

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

/// Id of our Quit item.
pub const QUIT_ID: &str = "nimw-quit";

/// The app menu: About, Services, Hide, Hide Others, Show All, Quit (ours);
/// Edit (Undo, Redo, Cut, Copy, Paste, Select All: macOS routes the text
/// editing shortcuts through it); View (full screen); Window (Minimize, Zoom,
/// Close Window).
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let config = app.config();
    let name = pkg.name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let quit = MenuItem::with_id(
        app,
        QUIT_ID,
        format!("Quit {name}"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_submenu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_submenu, &edit, &view, &window])
}

/// Installs [`app_menu`] on macOS (the only platform with an app menu by
/// default). Not part of `configure`: muda menus can only be created on the
/// main thread, which the IPC test harness doesn't run on.
pub fn with_app_menu<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
}

/// Menu events (registered by `configure`).
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == QUIT_ID {
        request_quit(app);
    }
}

/// Quits through the windows' close requests, so pending saves are flushed
/// first; with no window left there is nothing to save.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        app.exit(0);
        return;
    }
    for window in windows.into_values() {
        let _ = window.close();
    }
}
