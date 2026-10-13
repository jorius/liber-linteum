//! The `nimw-asset:` protocol (M2a spec §2.5): serves files of the open vault
//! only, through `VaultPath` (no traversal, no hidden files), with ranges.

use nimw_desktop::AppDirs;
use nimw_desktop::asset::serve;
use nimw_desktop::state::AppState;
use nimw_testkit::copy_fixture;
use serde_json::json;
use tauri::Manager;
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::{WebviewWindowBuilder, ipc::CallbackFn, ipc::InvokeBody, webview::InvokeRequest};

/// One `generate_context!()` per test binary (it embeds an Info.plist symbol).
fn app() -> (
    tauri::App<tauri::test::MockRuntime>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let config = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let app = nimw_desktop::configure(
        mock_builder(),
        Some(AppDirs {
            config: config.path().into(),
            cache: cache.path().into(),
        }),
    )
    .build(tauri::generate_context!())
    .unwrap();
    (app, config, cache)
}

fn open(
    vault: &std::path::Path,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let (app, config, cache) = app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let request = InvokeRequest {
        cmd: "vault_open".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(json!({ "path": vault })),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(&main, request).unwrap();
    (app, config, cache)
}

#[test]
fn serves_vault_files_with_their_media_type() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    let r = serve(&state, "/Character%20Design/assets/rex-cover.png", None);
    assert_eq!(r.status, 200);
    assert_eq!(r.mime, "image/png");
    assert_eq!(
        r.body,
        std::fs::read(vault.path().join("Character Design/assets/rex-cover.png")).unwrap()
    );
    let mp3 = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        None,
    );
    assert_eq!(mp3.mime, "audio/mpeg");
}

#[test]
fn refuses_traversal_hidden_files_and_missing_files() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    assert_eq!(serve(&state, "/../secret.png", None).status, 403);
    assert_eq!(serve(&state, "/%2E%2E/secret.png", None).status, 403);
    assert_eq!(serve(&state, "/.obsidian/app.json", None).status, 403);
    assert_eq!(serve(&state, "/nope.png", None).status, 404);
    assert_eq!(serve(&state, "/", None).status, 403);
}

#[test]
fn nothing_is_served_without_an_open_vault() {
    let (app, _c, _k) = app();
    assert_eq!(
        serve(&app.state::<AppState>(), "/Welcome.md", None).status,
        404
    );
}

#[test]
fn byte_ranges_for_audio_seeking() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    let full = std::fs::read(
        vault
            .path()
            .join("Character Design/assets/voice-reference.mp3"),
    )
    .unwrap();
    let r = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        Some("bytes=2-5"),
    );
    assert_eq!(r.status, 206);
    assert_eq!(r.body, full[2..=5]);
    assert!(
        r.headers
            .iter()
            .any(|(k, v)| k == "Content-Range" && v == &format!("bytes 2-5/{}", full.len()))
    );
    let open_end = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        Some("bytes=3-"),
    );
    assert_eq!(open_end.body, full[3..]);
    let bad = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        Some("bytes=999999-"),
    );
    assert_eq!(bad.status, 416);
}

/// Spec §7 "revoked on close": once the vault is closed nothing of it is served.
#[test]
fn closing_the_vault_stops_serving_it() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let path = "/Character%20Design/assets/rex-cover.png";
    assert_eq!(serve(&app.state::<AppState>(), path, None).status, 200);
    let main = app.get_webview_window("main").unwrap();
    let request = InvokeRequest {
        cmd: "vault_close".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(json!({})),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(&main, request).unwrap();
    assert_eq!(serve(&app.state::<AppState>(), path, None).status, 404);
}
