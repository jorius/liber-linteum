//! M4c Scratchpad (spec §2, §4, §7) through the real IPC path: real
//! `generate_context!()` (config + capabilities), real command registration,
//! mock runtime, temp config/cache dirs. The default location and the folder
//! dialog are replaced through `ScratchpadState`, so no test touches the
//! user's Documents folder or opens a dialog.

use nimw_desktop::AppDirs;
use nimw_desktop::scratchpad_commands::ScratchpadState;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::test::MockRuntime;
use tauri::{
    App, Manager, WebviewWindow, WebviewWindowBuilder,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

/// Every command this stream adds.
const COMMANDS: &[&str] = &[
    "scratchpad_default",
    "scratchpad_choose",
    "scratchpad_set",
    "scratchpad_open",
    "quick_note_create",
    "quick_note_autoname",
    "quick_notes_state",
    "scratch_folder_set",
];

struct Harness {
    app: App<MockRuntime>,
    main: WebviewWindow<MockRuntime>,
    /// Stands in for `~/Documents`.
    docs: tempfile::TempDir,
    _config: tempfile::TempDir,
    _cache: tempfile::TempDir,
}

fn harness() -> Harness {
    let config = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let docs = tempfile::tempdir().unwrap();
    let dirs = AppDirs {
        config: config.path().to_path_buf(),
        cache: cache.path().to_path_buf(),
    };
    let app = nimw_desktop::configure(mock_builder(), Some(dirs))
        .build(tauri::generate_context!())
        .expect("app builds with the real context");
    app.state::<ScratchpadState>()
        .set_documents_dir(Some(docs.path().to_path_buf()));
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Harness {
        app,
        main,
        docs,
        _config: config,
        _cache: cache,
    }
}

fn request(cmd: &str, body: Value) -> InvokeRequest {
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
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn call(w: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(w, request(cmd, body)).map(|r| r.deserialize::<Value>().unwrap())
}

fn kind(err: Value) -> String {
    err["kind"].as_str().unwrap_or_default().to_string()
}

fn picks(h: &Harness, folder: Option<PathBuf>) {
    h.app
        .state::<ScratchpadState>()
        .set_folder_picker(Some(Arc::new(move || folder.clone())));
}

fn canonical(p: &Path) -> String {
    dunce::canonicalize(p)
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

/// The global Scratchpad at its default place, open.
fn open_scratchpad(h: &Harness) -> Value {
    let default = call(&h.main, "scratchpad_default", json!({})).unwrap();
    call(&h.main, "scratchpad_set", json!({ "path": default })).unwrap();
    call(&h.main, "scratchpad_open", json!({})).unwrap()
}

fn write_page(h: &Harness, path: &str, text: &str) {
    let read = call(&h.main, "page_read", json!({ "path": path })).unwrap();
    call(
        &h.main,
        "page_write",
        json!({ "path": path, "text": text, "expectedHash": read["hash"] }),
    )
    .unwrap();
}

#[test]
fn m4c_scratchpad_commands_are_allowed_from_main_and_denied_elsewhere() {
    let h = harness();
    picks(&h, None);
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    for cmd in COMMANDS {
        if let Err(e) = call(&h.main, cmd, json!({ "path": "x.md", "name": "X" })) {
            let text = e.to_string();
            assert!(
                !text.contains("not allowed") && !text.contains("denied"),
                "{cmd} refused from main: {text}"
            );
        }
        let err = call(&other, cmd, json!({})).expect_err(cmd);
        assert!(err.to_string().contains(cmd), "{cmd}: {err}");
    }
}

#[test]
fn m4c_first_use_with_the_default_creates_and_opens_the_scratchpad() {
    let h = harness();
    let settings = call(&h.main, "settings_get", json!({})).unwrap();
    assert_eq!(settings["settings"]["scratchpadPath"], Value::Null);
    let default = call(&h.main, "scratchpad_default", json!({})).unwrap();
    let want = h.docs.path().join("Notes In My Way").join("Scratchpad");
    assert_eq!(default, json!(want.to_string_lossy()));
    assert!(!want.exists(), "asking for the default creates nothing");

    let saved = call(&h.main, "scratchpad_set", json!({ "path": default })).unwrap();
    assert!(want.is_dir(), "the folder and its parents are created");
    assert_eq!(saved["scratchpadPath"], json!(canonical(&want)));

    let info = call(&h.main, "scratchpad_open", json!({})).unwrap();
    assert_eq!(info["scratchpad"], true);
    assert_eq!(info["root"], json!(canonical(&want)));
    let recent = call(&h.main, "vaults_recent", json!({})).unwrap();
    assert_eq!(recent[0]["scratchpad"], true);
    // An ordinary vault is not the Scratchpad.
    let other = tempfile::tempdir().unwrap();
    let info = call(&h.main, "vault_open", json!({ "path": other.path() })).unwrap();
    assert_eq!(info["scratchpad"], false);
    let recent = call(&h.main, "vaults_recent", json!({})).unwrap();
    assert_eq!(recent[0]["scratchpad"], false);
    assert_eq!(recent[1]["scratchpad"], true);
}

#[test]
fn m4c_scratchpad_set_refuses_a_path_the_user_did_not_pick() {
    let h = harness();
    let elsewhere = tempfile::tempdir().unwrap();
    let target = elsewhere.path().join("Mine");
    let err = call(&h.main, "scratchpad_set", json!({ "path": target })).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    assert!(!target.exists());
    // Cancelled dialog: nothing granted.
    picks(&h, None);
    assert_eq!(
        call(&h.main, "scratchpad_choose", json!({})).unwrap(),
        Value::Null
    );
    // The folder the user picks may be used.
    picks(&h, Some(target.clone()));
    let chosen = call(&h.main, "scratchpad_choose", json!({})).unwrap();
    assert_eq!(chosen, json!(target.to_string_lossy()));
    let saved = call(&h.main, "scratchpad_set", json!({ "path": chosen })).unwrap();
    assert_eq!(saved["scratchpadPath"], json!(canonical(&target)));
    // …and only that one.
    let err = call(
        &h.main,
        "scratchpad_set",
        json!({ "path": elsewhere.path().join("Other") }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}

#[test]
fn m4c_settings_set_cannot_change_the_scratchpad() {
    let h = harness();
    let saved = call(
        &h.main,
        "settings_set",
        json!({ "patch": { "scratchpadPath": "/tmp/x", "theme": "dark" } }),
    )
    .unwrap();
    assert_eq!(saved["theme"], "dark");
    assert_eq!(saved["scratchpadPath"], Value::Null);
    let err = call(&h.main, "scratchpad_open", json!({})).unwrap_err();
    assert_eq!(kind(err), "notFound");
}

#[test]
fn m4c_a_deleted_scratchpad_folder_is_created_again() {
    let h = harness();
    open_scratchpad(&h);
    let folder = h.docs.path().join("Notes In My Way").join("Scratchpad");
    call(&h.main, "vault_close", json!({})).unwrap();
    std::fs::remove_dir_all(&folder).unwrap();
    let info = call(&h.main, "scratchpad_open", json!({})).unwrap();
    assert!(folder.is_dir());
    assert_eq!(info["scratchpad"], true);
}

#[test]
fn m4c_quick_notes_go_to_the_open_vaults_scratch_place_and_are_auto_named_over_ipc() {
    let h = harness();
    // No vault open: nowhere to put it.
    let err = call(&h.main, "quick_note_create", json!({ "name": "Q" })).unwrap_err();
    assert_eq!(kind(err), "noVault");
    // An ordinary vault: its scratch folder, created on first use.
    let vault = tempfile::tempdir().unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let state = call(&h.main, "quick_notes_state", json!({})).unwrap();
    assert_eq!(state, json!({ "folder": "Scratchpad", "autoNamed": [] }));
    assert!(!vault.path().join("Scratchpad").exists());
    let note = call(
        &h.main,
        "quick_note_create",
        json!({ "name": "Quick note X" }),
    )
    .unwrap();
    assert_eq!(note, "Scratchpad/Quick note X.md");
    write_page(&h, "Scratchpad/Quick note X.md", "# Trip to Lima\n");
    let out = call(
        &h.main,
        "quick_note_autoname",
        json!({ "path": "Scratchpad/Quick note X.md" }),
    )
    .unwrap();
    assert_eq!(out["path"], "Scratchpad/Trip to Lima.md");
    assert_eq!(out["autoNamed"], true);
    assert_eq!(
        out["outcome"]["moved"][0],
        json!(["Scratchpad/Quick note X.md", "Scratchpad/Trip to Lima.md"])
    );
    let state = call(&h.main, "quick_notes_state", json!({})).unwrap();
    assert_eq!(state["autoNamed"], json!(["Scratchpad/Trip to Lima.md"]));
    // A rename by hand ends it.
    call(
        &h.main,
        "entry_rename",
        json!({ "from": "Scratchpad/Trip to Lima.md", "to": "Scratchpad/Lima.md" }),
    )
    .unwrap();
    let state = call(&h.main, "quick_notes_state", json!({})).unwrap();
    assert_eq!(state["autoNamed"], json!([]));
    let out = call(
        &h.main,
        "quick_note_autoname",
        json!({ "path": "Scratchpad/Lima.md" }),
    )
    .unwrap();
    assert_eq!(out["autoNamed"], false);
    assert_eq!(out["outcome"], Value::Null);
    // The global Scratchpad: its root, no folder.
    open_scratchpad(&h);
    let state = call(&h.main, "quick_notes_state", json!({})).unwrap();
    assert_eq!(state["folder"], Value::Null);
    let note = call(
        &h.main,
        "quick_note_create",
        json!({ "name": "Quick note Y" }),
    )
    .unwrap();
    assert_eq!(note, "Quick note Y.md");
}

#[test]
fn m4c_scratch_folder_set_over_ipc() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    call(&h.main, "quick_note_create", json!({ "name": "Q" })).unwrap();
    let out = call(&h.main, "scratch_folder_set", json!({ "name": "Inbox" })).unwrap();
    assert_eq!(out["folder"], "Inbox");
    assert_eq!(out["from"], "Scratchpad");
    assert_eq!(
        out["outcome"]["moved"][0],
        json!(["Scratchpad/Q.md", "Inbox/Q.md"])
    );
    assert!(vault.path().join("Inbox/Q.md").is_file());
    let state = call(&h.main, "quick_notes_state", json!({})).unwrap();
    assert_eq!(state["folder"], "Inbox");
    let err = call(&h.main, "scratch_folder_set", json!({ "name": "a/b" })).unwrap_err();
    assert_eq!(kind(err), "invalidName");
    // The global Scratchpad has no scratch folder to name.
    open_scratchpad(&h);
    let err = call(&h.main, "scratch_folder_set", json!({ "name": "X" })).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}
