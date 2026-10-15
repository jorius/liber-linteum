use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

pub fn build_app_info() -> AppInfo {
    AppInfo {
        name: "Notes In My Way".to_string(),
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
pub fn clean_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| !c.is_control())
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
    fn app_info_reports_name_and_crate_version() {
        let info = build_app_info();
        assert_eq!(info.name, "Notes In My Way");
        assert_eq!(info.version, "0.1.0");
    }

    #[test]
    fn app_info_serializes_camel_case() {
        let json = serde_json::to_value(build_app_info()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "name": "Notes In My Way", "version": "0.1.0" })
        );
    }
}
