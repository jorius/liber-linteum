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

use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Id of our Quit item.
pub const QUIT_ID: &str = "liber-quit";
/// Ids of View → Back / Forward (M2b §3 link trail).
pub const BACK_ID: &str = "liber-back";
pub const FORWARD_ID: &str = "liber-forward";
/// Event telling the page to walk the link trail; payload `"back"` or
/// `"forward"`.
pub const NAVIGATE_EVENT: &str = "menu:navigate";
/// Ids of View → Toggle Formatting Toolbar / Toggle Line Numbers.
pub const TOOLBAR_ID: &str = "liber-toggle-toolbar";
pub const LINE_NUMBERS_ID: &str = "liber-toggle-line-numbers";
/// Id of View → Toggle Outline (M4b part 2 §5).
pub const OUTLINE_ID: &str = "liber-toggle-outline";
/// Event telling the page to flip a setting; payload `"toolbar"`,
/// `"lineNumbers"` or `"outline"` (the settings key).
pub const TOGGLE_EVENT: &str = "menu:toggle";
/// Ids of View → Editor / Global View (M3a §2).
pub const EDITOR_ID: &str = "liber-screen-edit";
pub const GLOBAL_VIEW_ID: &str = "liber-screen-global";
/// Id of View → See Atoms of This Page (M4b part 3 §6).
pub const ATOMS_ID: &str = "liber-see-atoms";
/// Id of View → Search… (M5 §4); the page answers `menu:search`.
pub const SEARCH_ID: &str = "liber-search";
pub const SEARCH_EVENT: &str = "menu:search";
/// Event telling the page which screen to show; payload `"edit"`,
/// `"global"`, or `"atoms"` (the open page's atoms in the Global View).
pub const SCREEN_EVENT: &str = "menu:screen";
/// Id of File → Create New Scratchpad in This Vault (M4c §2; renamed in round 3 §2.4).
pub const QUICK_NOTE_ID: &str = "liber-quick-note";
/// File → Create New Scratchpad names the open vault (round 3 §9.4); names
/// longer than this many characters are cut with "…".
const VAULT_NAME_MAX: usize = 40;

/// `name` as menus show it: at most `VAULT_NAME_MAX` visible characters
/// (accents, emoji), then "…", with `&` doubled (menus read a lone `&` as a
/// mnemonic marker).
fn menu_name(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    use unicode_segmentation::UnicodeSegmentation;
    let name: String = name.nfc().collect();
    let chars: Vec<&str> = name.graphemes(true).collect();
    let short = if chars.len() > VAULT_NAME_MAX {
        format!("{}…", chars[..VAULT_NAME_MAX - 1].concat())
    } else {
        name
    };
    short.replace('&', "&&")
}

/// The quick-note item's label: the open vault's name, or the generic label.
pub fn quick_note_label(vault: Option<&str>) -> String {
    match vault {
        Some(name) => format!("Create New Scratchpad for {}", menu_name(name)),
        None => "Create New Scratchpad in This Vault".into(),
    }
}

/// Vault → Encrypt "<name>"… (encryption UX round §4.1): the open plain
/// vault's name, or the generic label while the item is off.
pub fn encrypt_label(vault: Option<&str>) -> String {
    match vault {
        Some(name) => format!("Encrypt “{}”…", menu_name(name)),
        None => "Encrypt Vault…".into(),
    }
}

/// The app menu's item `id`, in any submenu.
fn find_item<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<MenuItem<R>> {
    fn find<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str) -> Option<MenuItem<R>> {
        items.into_iter().find_map(|i| match i {
            MenuItemKind::MenuItem(m) if m.id() == id => Some(m),
            MenuItemKind::Submenu(s) => find(s.items().ok()?, id),
            _ => None,
        })
    }
    find(app.menu()?.items().ok()?, id)
}

/// Renames the quick-note item after the vault that opened or closed.
pub fn show_vault_in_menu<R: Runtime>(app: &AppHandle<R>, vault: Option<&str>) {
    if let Some(item) = find_item(app, QUICK_NOTE_ID) {
        let _ = item.set_text(quick_note_label(vault));
    }
}

/// Event telling the main window to take a quick note (no payload).
pub const QUICK_NOTE_EVENT: &str = "menu:quickNote";
/// Id of File → Open File… (M4c §3).
pub const OPEN_FILE_ID: &str = "liber-open-file";
/// File → Import from Notion… (M7): the import dialog, in the main window.
pub const NOTION_IMPORT_ID: &str = "liber-notion-import";
pub const NOTION_IMPORT_EVENT: &str = "menu:notionImport";
/// Event asking the page to run Open File… (it shows what couldn't open).
pub const OPEN_FILE_EVENT: &str = "menu:open-file";
/// ⌘⇧O: ⌘O already opens a folder as a vault (spec §3.5).
pub const OPEN_FILE_ACCELERATOR: &str = "CmdOrCtrl+Shift+O";
/// Liber Linteum → Settings… (M5b §2.1): the focused window answers
/// `menu:settings` (file windows have Settings too).
pub const SETTINGS_ID: &str = "liber-settings";
pub const SETTINGS_EVENT: &str = "menu:settings";
/// Vault → Open Vault… / Close Vault (M5b §2.1): the main window answers
/// `menu:vault` with `"open"` or `"close"`.
pub const VAULT_OPEN_ID: &str = "liber-vault-open";
pub const VAULT_CLOSE_ID: &str = "liber-vault-close";
pub const VAULT_EVENT: &str = "menu:vault";
/// Vault → Lock Vault (E4): enabled only while an encrypted vault is open
/// (`menu_set_lock_enabled`). Plain ⌘⇧L is 1Password's global lock, so ⌥⌘L.
pub const VAULT_LOCK_ID: &str = "liber-vault-lock";
pub const VAULT_LOCK_ACCELERATOR: &str = "Alt+CmdOrCtrl+L";
/// Vault → New Vault… (encryption UX round §2): the New vault dialog.
pub const VAULT_NEW_ID: &str = "liber-vault-new";
/// Vault → Encrypt "<name>"… (encryption UX round §4.1): enabled and named
/// only while a plain vault is open (`menu_set_encrypt_item`).
pub const VAULT_ENCRYPT_ID: &str = "liber-vault-encrypt";

/// The `menu:vault` payload of a Vault menu item.
fn vault_action(id: &str) -> Option<&'static str> {
    match id {
        VAULT_NEW_ID => Some("new"),
        VAULT_OPEN_ID => Some("open"),
        VAULT_CLOSE_ID => Some("close"),
        VAULT_LOCK_ID => Some("lock"),
        VAULT_ENCRYPT_ID => Some("encrypt"),
        _ => None,
    }
}

/// Enables or disables Vault → Lock Vault (the page calls this as an
/// encrypted vault opens and closes).
#[tauri::command]
pub fn menu_set_lock_enabled<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    if let Some(item) = find_item(&app, VAULT_LOCK_ID) {
        let _ = item.set_enabled(enabled);
    }
}

/// Names and enables Vault → Encrypt "<vault>"…, or turns it off with no
/// vault (the page calls this as a plain vault opens and goes).
#[tauri::command]
pub fn menu_set_encrypt_item<R: Runtime>(app: AppHandle<R>, vault: Option<String>) {
    if let Some(item) = find_item(&app, VAULT_ENCRYPT_ID) {
        let _ = item.set_text(encrypt_label(vault.as_deref()));
        let _ = item.set_enabled(vault.is_some());
    }
}
/// File → Save (M5b §6, auto save off): the focused window saves its page.
pub const SAVE_ID: &str = "liber-save";
pub const SAVE_EVENT: &str = "menu:save";
/// View → Toggle Sidebar (M5b §2.5): the main window's sidebar.
pub const SIDEBAR_ID: &str = "liber-toggle-sidebar";
pub const SIDEBAR_EVENT: &str = "menu:sidebar";

/// The app menu: About, Settings… (M5b §2.1), Services, Hide, Hide Others,
/// Show All, Quit (ours); Vault (Open Vault…, Close Vault ⌥⌘W, M5b §2.1);
/// File (New Quick Note, ⌘⇧N: from any window, so it carries the
/// accelerator; the page also answers ⌘⇧N where there is no app menu and
/// ignores a second trigger within a second, M4c §7.10); Edit (Undo, Redo, Cut, Copy, Paste, Select All: macOS routes the text
/// editing shortcuts through it); View (Editor, Global View — no
/// accelerators: the page handles ⌘1 / ⌘2; Back, Forward along the link trail —
/// no accelerators: the page handles ⌘[ / ⌘] itself, which also works where
/// there is no app menu; the formatting toolbar, line-number and outline toggles —
/// plain items, the page owns the settings; full screen); Window (Minimize,
/// Zoom, Close Window).
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
    // ⌘, here and on the page: opening Settings twice is harmless (§11.3).
    let settings = MenuItem::with_id(app, SETTINGS_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_submenu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
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
    let quick_note = MenuItem::with_id(
        app,
        QUICK_NOTE_ID,
        quick_note_label(None),
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    // M4c §3: a Markdown, text or code file in a window of its own.
    let open_file = MenuItem::with_id(
        app,
        OPEN_FILE_ID,
        "Open File…",
        true,
        Some(OPEN_FILE_ACCELERATOR),
    )?;
    let notion_import = MenuItem::with_id(
        app,
        NOTION_IMPORT_ID,
        "Import from Notion…",
        true,
        None::<&str>,
    )?;
    // ⌘S here and on the page: a second save finds nothing to write.
    let save = MenuItem::with_id(app, SAVE_ID, "Save", true, Some("CmdOrCtrl+S"))?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &quick_note,
            &open_file,
            &PredefinedMenuItem::separator(app)?,
            &notion_import,
            &PredefinedMenuItem::separator(app)?,
            &save,
        ],
    )?;
    // No accelerator on Open Vault…: the page answers ⌘O, and two folder
    // dialogs would open (§11.3). ⌥⌘W is the menu's alone.
    let vault_open = MenuItem::with_id(app, VAULT_OPEN_ID, "Open Vault…", true, None::<&str>)?;
    let vault_close = MenuItem::with_id(
        app,
        VAULT_CLOSE_ID,
        "Close Vault",
        true,
        Some("Alt+CmdOrCtrl+W"),
    )?;
    let vault_lock = MenuItem::with_id(
        app,
        VAULT_LOCK_ID,
        "Lock Vault",
        false,
        Some(VAULT_LOCK_ACCELERATOR),
    )?;
    let vault_new = MenuItem::with_id(app, VAULT_NEW_ID, "New Vault…", true, None::<&str>)?;
    let vault_encrypt = MenuItem::with_id(
        app,
        VAULT_ENCRYPT_ID,
        encrypt_label(None),
        false,
        None::<&str>,
    )?;
    let vault = Submenu::with_items(
        app,
        "Vault",
        true,
        &[
            &vault_new,
            &vault_open,
            &PredefinedMenuItem::separator(app)?,
            &vault_encrypt,
            &vault_lock,
            &vault_close,
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
    let back = MenuItem::with_id(app, BACK_ID, "Back", true, None::<&str>)?;
    let forward = MenuItem::with_id(app, FORWARD_ID, "Forward", true, None::<&str>)?;
    // No accelerators: the page handles ⌘1 / ⌘2 itself (as ⌘[ / ⌘]).
    let editor = MenuItem::with_id(app, EDITOR_ID, "Editor", true, None::<&str>)?;
    let global_view = MenuItem::with_id(app, GLOBAL_VIEW_ID, "Global View", true, None::<&str>)?;
    // ⌘F shows on the item (M5b §7.3); the page answers it too, and opening
    // Search a second time does nothing, so either may win.
    let search = MenuItem::with_id(app, SEARCH_ID, "Search…", true, Some("CmdOrCtrl+F"))?;
    let atoms = MenuItem::with_id(app, ATOMS_ID, "See Atoms of This Page", true, None::<&str>)?;
    let toolbar = MenuItem::with_id(
        app,
        TOOLBAR_ID,
        "Toggle Formatting Toolbar",
        true,
        None::<&str>,
    )?;
    let line_numbers = MenuItem::with_id(
        app,
        LINE_NUMBERS_ID,
        "Toggle Line Numbers",
        true,
        None::<&str>,
    )?;
    let outline = MenuItem::with_id(app, OUTLINE_ID, "Toggle Outline", true, None::<&str>)?;
    // No accelerator: the page handles ⌘\, and a toggle fired twice undoes itself.
    let sidebar = MenuItem::with_id(app, SIDEBAR_ID, "Toggle Sidebar", true, None::<&str>)?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &search,
            &PredefinedMenuItem::separator(app)?,
            &editor,
            &global_view,
            &atoms,
            &PredefinedMenuItem::separator(app)?,
            &back,
            &forward,
            &PredefinedMenuItem::separator(app)?,
            &sidebar,
            &toolbar,
            &line_numbers,
            &outline,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
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
    Menu::with_items(app, &[&app_submenu, &file, &vault, &edit, &view, &window])
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
    activate(app, event.id().0.as_str(), menu_target(app));
}

/// An item of the menu bar the app draws itself (custom title bar §3: Linux
/// and Windows have no app menu): runs exactly as the macOS item with that id,
/// for the window it was chosen in. Unknown ids do nothing.
#[tauri::command]
pub fn menu_activate<R: Runtime>(window: tauri::WebviewWindow<R>, id: String) {
    activate(window.app_handle(), &id, Some(window.label().to_string()));
}

/// Runs the menu item `id`; `target` is the window that answers the items
/// acting on one window (Settings, Save, the toggles, Back and Forward).
fn activate<R: Runtime>(app: &AppHandle<R>, id: &str, target: Option<String>) {
    if id == QUIT_ID {
        request_quit(app);
    } else if id == BACK_ID || id == FORWARD_ID {
        let direction = if id == BACK_ID { "back" } else { "forward" };
        emit_to(app, &target, NAVIGATE_EVENT, direction);
    } else if id == EDITOR_ID || id == GLOBAL_VIEW_ID || id == ATOMS_ID {
        let screen = match id {
            EDITOR_ID => "edit",
            GLOBAL_VIEW_ID => "global",
            _ => "atoms",
        };
        emit_to(app, &target, SCREEN_EVENT, screen);
    } else if id == SEARCH_ID {
        // Search lives in the main window only (file windows have no vault).
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
        }
        let _ = app.emit_to("main", SEARCH_EVENT, ());
    } else if id == TOOLBAR_ID {
        emit_to(app, &target, TOGGLE_EVENT, "toolbar");
    } else if id == LINE_NUMBERS_ID {
        emit_to(app, &target, TOGGLE_EVENT, "lineNumbers");
    } else if id == OUTLINE_ID {
        emit_to(app, &target, TOGGLE_EVENT, "outline");
    } else if id == QUICK_NOTE_ID {
        // Quick notes are taken in the main window, wherever ⌘⇧N was pressed.
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
        let _ = app.emit_to("main", QUICK_NOTE_EVENT, ());
    } else if id == NOTION_IMPORT_ID {
        // An import opens a new vault, so it runs in the main window.
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
        let _ = app.emit_to("main", NOTION_IMPORT_EVENT, ());
    } else if id == OPEN_FILE_ID {
        emit_to(app, &target, OPEN_FILE_EVENT, ());
    } else if id == SETTINGS_ID {
        emit_to(app, &target, SETTINGS_EVENT, ());
    } else if id == SAVE_ID {
        emit_to(app, &target, SAVE_EVENT, ());
    } else if let Some(what) = vault_action(id) {
        emit_main(app, VAULT_EVENT, what);
    } else if id == SIDEBAR_ID {
        emit_main(app, SIDEBAR_EVENT, ());
    }
}

/// The window a menu item acts on (M4c §3): the focused one, else the main
/// window, else any. With several windows, a toggle sent to all of them
/// flipped the setting once per window.
pub fn menu_target<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| windows.values().next())
        .map(|w| w.label().to_string())
}

/// Shows and focuses the main window, then tells it (vault actions live there).
fn emit_main<R: Runtime, S: serde::Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit_to("main", event, payload);
}

/// Tells the window a menu item acts on (`target`, see [`activate`]).
fn emit_to<R: Runtime, S: serde::Serialize + Clone>(
    app: &AppHandle<R>,
    target: &Option<String>,
    event: &str,
    payload: S,
) {
    if let Some(label) = target {
        let _ = app.emit_to(label.as_str(), event, payload);
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

#[cfg(test)]
mod label_tests {
    use super::quick_note_label;

    #[test]
    fn quick_note_label_names_the_vault_and_shortens_long_names() {
        assert_eq!(
            quick_note_label(None),
            "Create New Scratchpad in This Vault"
        );
        assert_eq!(
            quick_note_label(Some("Smartjob")),
            "Create New Scratchpad for Smartjob"
        );
        let long = "Á".repeat(60);
        let label = quick_note_label(Some(&long));
        assert_eq!(
            label,
            format!("Create New Scratchpad for {}…", "Á".repeat(39))
        );
        assert_eq!(
            quick_note_label(Some(&"x".repeat(40))),
            format!("Create New Scratchpad for {}", "x".repeat(40))
        );
    }
}

#[cfg(test)]
mod tests {
    use super::quick_note_label;

    /// Review #3: `&` is a mnemonic marker in menus; it must show as itself.
    #[test]
    fn subpages_review_an_ampersand_in_the_vault_name_survives() {
        assert_eq!(
            quick_note_label(Some("R&D")),
            "Create New Scratchpad for R&&D"
        );
    }

    /// Review #4: the cut keeps whole characters, accents and emoji included.
    #[test]
    fn subpages_review_long_names_are_cut_between_characters() {
        let decomposed = format!("{}e\u{301}", "a".repeat(38)); // 39 chars as typed, NFD
        assert_eq!(
            quick_note_label(Some(&decomposed)),
            format!("Create New Scratchpad for {}\u{e9}", "a".repeat(38))
        );
        let long = format!("{}e\u{301}xyz", "a".repeat(38));
        assert_eq!(
            quick_note_label(Some(&long)),
            format!("Create New Scratchpad for {}\u{e9}…", "a".repeat(38))
        );
        let emoji = format!("{}👩‍💻tail", "a".repeat(38));
        assert_eq!(
            quick_note_label(Some(&emoji)),
            format!("Create New Scratchpad for {}👩‍💻…", "a".repeat(38))
        );
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn vault_menu_items_emit_their_action() {
        assert_eq!(vault_action(VAULT_NEW_ID), Some("new"));
        assert_eq!(vault_action(VAULT_ENCRYPT_ID), Some("encrypt"));
        assert_eq!(vault_action(VAULT_LOCK_ID), Some("lock"));
        assert_eq!(vault_action(VAULT_OPEN_ID), Some("open"));
        assert_eq!(vault_action(VAULT_CLOSE_ID), Some("close"));
        // New Encrypted Vault… is gone (UX round §2).
        assert_eq!(vault_action("liber-vault-new-encrypted"), None);
        assert_eq!(vault_action("liber-quit"), None);
    }

    #[test]
    fn encrypt_label_names_the_vault_cut_like_the_scratchpad_item() {
        assert_eq!(encrypt_label(None), "Encrypt Vault…");
        assert_eq!(encrypt_label(Some("Smartjob")), "Encrypt “Smartjob”…");
        assert_eq!(encrypt_label(Some("R&D")), "Encrypt “R&&D”…");
        assert_eq!(
            encrypt_label(Some(&"Á".repeat(60))),
            format!("Encrypt “{}…”…", "Á".repeat(39))
        );
    }
}
