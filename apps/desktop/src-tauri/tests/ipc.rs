//! Drives the real IPC path: real `generate_context!()` (tauri.conf.json plus the
//! capability files) and the real command registration from `liber_desktop::configure`.
//! Capability or registration mistakes that the UI would swallow fail here instead.

use tauri::test::MockRuntime;
use tauri::{
    App, WebviewWindowBuilder,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

fn build_app() -> App<MockRuntime> {
    // Temp config/cache dirs so tests never read or write the user's settings.
    let dirs = liber_desktop::AppDirs {
        config: std::env::temp_dir().join(format!("liber-ipc-cfg-{}", std::process::id())),
        cache: std::env::temp_dir().join(format!("liber-ipc-cache-{}", std::process::id())),
    };
    liber_desktop::configure(mock_builder(), Some(dirs))
        .build(tauri::generate_context!())
        .expect("failed to build app with the real context")
}

fn request(cmd: &str) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::default(),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

#[test]
fn app_info_is_callable_from_the_main_window() {
    let app = build_app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let value = get_ipc_response(&main, request("app_info"))
        .expect("app_info must be allowed for the main window")
        .deserialize::<serde_json::Value>()
        .unwrap();

    assert_eq!(
        value,
        serde_json::json!({ "name": "Liber Linteum", "version": "0.1.1" })
    );
}

#[test]
fn unregistered_command_is_rejected() {
    let app = build_app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let err = get_ipc_response(&main, request("not_a_command"))
        .expect_err("unknown commands must not resolve");
    assert!(err.to_string().contains("not_a_command"), "{err}");
}

#[test]
fn app_info_is_denied_outside_the_main_window() {
    let app = build_app();
    let other = WebviewWindowBuilder::new(&app, "other", Default::default())
        .build()
        .unwrap();

    let err = get_ipc_response(&other, request("app_info"))
        .expect_err("capability is scoped to the main window only");
    assert!(err.to_string().contains("app_info"), "{err}");
}
