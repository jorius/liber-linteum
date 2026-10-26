use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

pub fn build_app_info() -> AppInfo {
    AppInfo {
        name: "Liber Linteum".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    build_app_info()
}

/// Closes the calling window, and only it (M4c review I2): the window
/// plugin's `destroy` takes any label, so a page could close another window
/// past its save-on-close. The page saves first, as before.
#[tauri::command]
pub async fn window_close_self<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<()> {
    window
        .destroy()
        .map_err(|e| crate::error::CommandError::new(crate::error::ErrorKind::Io, e.to_string()))
}

/// The longest window title kept (M5b §11.8).
const TITLE_MAX_CHARS: usize = 200;

/// A page-supplied title, cleaned: no control characters, at most 200
/// characters.
/// Bidi controls and zero-width characters (M5b final review M11): a synced
/// file name holding them could reorder or hide part of the window title.
fn is_invisible_format(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}' | '\u{061C}')
}

pub fn clean_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| !c.is_control() && !is_invisible_format(*c))
        .take(TITLE_MAX_CHARS)
        .collect()
}

/// Names the calling window, and only it (M5b §2.3: "Page — Vault" once the
/// top bar is gone). The window plugin isn't granted (M4c review I2).
#[tauri::command]
pub async fn window_title_set<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    title: String,
) -> crate::error::CmdResult<()> {
    window
        .set_title(&clean_title(&title))
        .map_err(|e| crate::error::CommandError::new(crate::error::ErrorKind::Io, e.to_string()))
}

fn window_error(e: tauri::Error) -> crate::error::CommandError {
    crate::error::CommandError::new(crate::error::ErrorKind::Io, e.to_string())
}

/// The title bar the app draws itself where the system's is off (Linux and
/// Windows, custom title bar §2): its window buttons, dragging and the Window
/// menu. Each acts on the calling window only, as `window_close_self` (the
/// window plugin isn't granted, M4c review I2).
#[tauri::command]
pub async fn window_minimize<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<()> {
    window.minimize().map_err(window_error)
}

/// Maximizes the calling window, or restores it; answers whether it is now
/// maximized (the title bar swaps its button).
#[tauri::command]
pub async fn window_toggle_maximize<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<bool> {
    let maximized = window.is_maximized().map_err(window_error)?;
    if maximized {
        window.unmaximize().map_err(window_error)?;
    } else {
        window.maximize().map_err(window_error)?;
    }
    Ok(!maximized)
}

/// Whether the calling window is maximized.
#[tauri::command]
pub async fn window_maximized<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<bool> {
    window.is_maximized().map_err(window_error)
}

/// View → Full Screen (F11).
#[tauri::command]
pub async fn window_toggle_fullscreen<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<()> {
    let full = window.is_fullscreen().map_err(window_error)?;
    window.set_fullscreen(!full).map_err(window_error)
}

/// Moves the calling window with the pointer (a press on the title bar).
#[tauri::command]
pub async fn window_start_drag<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<()> {
    window.start_dragging().map_err(window_error)
}

/// The title bar's close button and Window → Close Window: a close request,
/// as the system's button sends, so the page saves first (or keeps the window).
#[tauri::command]
pub async fn window_close_request<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<()> {
    window.close().map_err(window_error)
}

/// Edit → Paste on Linux: WebKitGTK's own Paste into the focused field, as a
/// GTK menu would run it (a page can't read the clipboard there). Elsewhere
/// the page pastes itself, so this answers `notPermitted`.
#[tauri::command]
pub async fn window_paste<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> crate::error::CmdResult<()> {
    #[cfg(target_os = "linux")]
    {
        window
            .with_webview(|webview| {
                use webkit2gtk::WebViewExt;
                webview.inner().execute_editing_command("Paste");
            })
            .map_err(window_error)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Err(crate::error::CommandError::new(
            crate::error::ErrorKind::NotPermitted,
            "paste",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::build_app_info;

    #[test]
    fn m5b_titles_lose_control_characters_and_stop_at_200() {
        assert_eq!(super::clean_title("Ranks — Galaxy"), "Ranks — Galaxy");
        let long = format!("a\u{7}b\n{}", "é".repeat(300));
        let t = super::clean_title(&long);
        assert!(t.starts_with("abé"), "{t}");
        assert_eq!(t.chars().count(), 200);
    }

    #[test]
    fn m5b_final_m11_titles_lose_bidi_and_zero_width_characters() {
        // A synced file name can't reorder the title in the Dock or taskbar.
        let spoof = "inv\u{202E}fdp.exe\u{2066}x\u{2069}\u{200B}y\u{FEFF}z\u{200D}";
        assert_eq!(super::clean_title(spoof), "invfdp.exexyz");
    }

    #[test]
    fn app_info_reports_name_and_crate_version() {
        let info = build_app_info();
        assert_eq!(info.name, "Liber Linteum");
        assert_eq!(info.version, "0.1.2");
    }

    #[test]
    fn app_info_serializes_camel_case() {
        let json = serde_json::to_value(build_app_info()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "name": "Liber Linteum", "version": "0.1.2" })
        );
    }
}
