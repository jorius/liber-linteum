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

#[cfg(test)]
mod tests {
    use super::build_app_info;

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
