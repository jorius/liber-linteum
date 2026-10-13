//! M1b commands through the real IPC path: real `generate_context!()` (config +
//! capabilities), real command registration, mock runtime, temp config/cache dirs.

use nimw_desktop::AppDirs;
use nimw_testkit::{copy_fixture, real_trash_tests_enabled, trashable_fixture};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::test::MockRuntime;
use tauri::{
    App, Listener, WebviewWindow, WebviewWindowBuilder,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

/// Every command M1b adds (spec §2.4).
const COMMANDS: &[&str] = &[
    "vault_open",
    "vault_create",
    "vault_close",
    "vault_tree",
    "page_get",
    "backlink_count",
    "entry_create_page",
    "entry_create_folder",
    "entry_rename",
    "entry_trash",
    "settings_get",
    "settings_set",
    "vaults_recent",
    "vaults_forget",
];

struct Harness {
    app: App<MockRuntime>,
    main: WebviewWindow<MockRuntime>,
    _config: tempfile::TempDir,
    _cache: tempfile::TempDir,
}

fn harness() -> Harness {
    let config = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let dirs = AppDirs {
        config: config.path().to_path_buf(),
        cache: cache.path().to_path_buf(),
    };
    let app = nimw_desktop::configure(mock_builder(), Some(dirs))
        .build(tauri::generate_context!())
        .expect("app builds with the real context");
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Harness {
        app,
        main,
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

#[test]
fn m1b_every_command_is_allowed_from_main_and_denied_elsewhere() {
    let h = harness();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    for cmd in COMMANDS {
        if let Err(e) = call(&h.main, cmd, json!({})) {
            assert!(
                !e.to_string().contains("not allowed"),
                "{cmd} must be allowed from main: {e}"
            );
        }
        let err = call(&other, cmd, json!({})).expect_err(cmd);
        assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
    }
}

#[test]
fn vlt_01_open_fixture_then_tree_and_page() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    let info = call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    assert_eq!(info["report"]["pages"], 5);
    let name = info["name"].as_str().unwrap();
    assert!(!name.is_empty() && info["root"].as_str().unwrap().ends_with(name));
    let tree = call(&h.main, "vault_tree", json!({})).unwrap();
    let paths: Vec<&str> = tree
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"Welcome.md"));
    assert!(!paths.iter().any(|p| p.starts_with(".obsidian")));
    assert_eq!(
        tree.as_array().unwrap()[0]["kind"],
        "folder",
        "folders come first"
    );
    let page = call(
        &h.main,
        "page_get",
        json!({ "path": "Character Design/rex-draft.md" }),
    )
    .unwrap();
    assert_eq!(page["title"], "Generator Rex");
    assert_eq!(page["subtitle"], "Hero redesign · v3");
    assert_eq!(page["tags"], json!(["character", "redesign"]));
    assert_eq!(page["truncated"], false);
    assert_eq!(page["binary"], false);
    assert!(page["text"].as_str().unwrap().contains("# Generator Rex"));
    assert!(page["links"].as_u64().unwrap() >= 5);
    let sparda = call(
        &h.main,
        "backlink_count",
        json!({ "path": "Character Design/DMC/Sparda.md" }),
    )
    .unwrap();
    assert_eq!(sparda, 4);
    let folder = call(
        &h.main,
        "backlink_count",
        json!({ "path": "Character Design/DMC" }),
    )
    .unwrap();
    assert_eq!(folder, 4, "links from outside the folder into it");
    let recent = call(&h.main, "vaults_recent", json!({})).unwrap();
    assert_eq!(recent.as_array().unwrap().len(), 1);
    assert_eq!(recent[0]["missing"], false);
}

#[test]
fn page_get_truncates_large_pages_and_flags_binary_ones() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    let big = format!("# Big\n\n{}", "é".repeat(600_000)); // 1.2 MB of 2-byte chars
    std::fs::write(vault.path().join("big.md"), &big).unwrap();
    std::fs::write(vault.path().join("latin1.md"), [b'#', b' ', 0xe9, b'\n']).unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let page = call(&h.main, "page_get", json!({ "path": "big.md" })).unwrap();
    assert_eq!(page["truncated"], true);
    let text = page["text"].as_str().unwrap();
    assert!(text.len() <= 1024 * 1024 && text.len() > 1_000_000);
    let bin = call(&h.main, "page_get", json!({ "path": "latin1.md" })).unwrap();
    assert_eq!(bin["binary"], true);
    assert_eq!(bin["text"], "");
    assert_eq!(bin["title"], "latin1");
}

#[test]
fn no_vault_and_traversal_and_missing_are_typed_errors() {
    let h = harness();
    assert_eq!(
        kind(call(&h.main, "vault_tree", json!({})).unwrap_err()),
        "noVault"
    );
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    for bad in ["../outside.md", "/etc/passwd", "a/../../b.md"] {
        assert_eq!(
            kind(call(&h.main, "page_get", json!({ "path": bad })).unwrap_err()),
            "outsideVault",
            "{bad}"
        );
    }
    assert_eq!(
        kind(call(&h.main, "page_get", json!({ "path": "nope.md" })).unwrap_err()),
        "notFound"
    );
    let gone = tempfile::tempdir().unwrap();
    let missing = gone.path().join("not-here");
    assert_eq!(
        kind(call(&h.main, "vault_open", json!({ "path": missing })).unwrap_err()),
        "notFound"
    );
}

#[test]
fn vlt_01_create_requires_an_empty_or_new_folder() {
    let h = harness();
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(parent.path().join("x.md"), "x").unwrap();
    assert_eq!(
        kind(call(&h.main, "vault_create", json!({ "path": parent.path() })).unwrap_err()),
        "notEmpty"
    );
    let only_metadata = parent.path().join("meta");
    std::fs::create_dir(&only_metadata).unwrap();
    std::fs::write(only_metadata.join(".DS_Store"), "x").unwrap();
    call(&h.main, "vault_create", json!({ "path": only_metadata })).unwrap();
    let fresh = parent.path().join("brand new");
    let info = call(&h.main, "vault_create", json!({ "path": fresh })).unwrap();
    assert_eq!(info["name"], "brand new");
    assert!(fresh.is_dir());
    assert!(
        !fresh.join(".nimw").exists(),
        "creating writes nothing inside"
    );
}

#[test]
fn exp_02_04_create_rename_and_close() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let page = call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "Game Design", "name": "Untitled" }),
    )
    .unwrap();
    assert_eq!(page, "Game Design/Untitled.md");
    let folder = call(
        &h.main,
        "entry_create_folder",
        json!({ "parent": "", "name": "Inbox" }),
    )
    .unwrap();
    assert_eq!(folder, "Inbox");
    assert_eq!(
        kind(
            call(
                &h.main,
                "entry_create_page",
                json!({ "dir": "", "name": "a#b" })
            )
            .unwrap_err()
        ),
        "invalidName"
    );
    let out = call(
        &h.main,
        "entry_rename",
        json!({ "from": "Character Design/DMC/Sparda.md", "to": "Character Design/DMC/Dante.md" }),
    )
    .unwrap();
    assert_eq!(out["updatedLinks"], 4);
    assert_eq!(out["updatedFiles"].as_array().unwrap().len(), 2);
    assert_eq!(out["failed"], json!([]));
    assert!(
        std::fs::read_to_string(vault.path().join("Character Design/rex-draft.md"))
            .unwrap()
            .contains("[[Dante]]")
    );
    // With rewriting turned off, only the file moves.
    call(
        &h.main,
        "settings_set",
        json!({ "patch": { "rewriteLinks": false } }),
    )
    .unwrap();
    let out = call(
        &h.main,
        "entry_rename",
        json!({ "from": "Character Design/DMC/Dante.md", "to": "Character Design/DMC/Vergil.md" }),
    )
    .unwrap();
    assert_eq!(out["updatedLinks"], 0);
    call(&h.main, "vault_close", json!({})).unwrap();
    assert_eq!(
        kind(call(&h.main, "vault_tree", json!({})).unwrap_err()),
        "noVault"
    );
}

#[test]
fn exp_03_trash_through_ipc() {
    if !real_trash_tests_enabled() {
        return;
    }
    let h = harness();
    let vault = trashable_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    call(&h.main, "entry_trash", json!({ "path": "Welcome.md" })).unwrap();
    assert!(!vault.path().join("Welcome.md").exists());
}

#[test]
fn settings_round_trip_and_recent_vaults_through_ipc() {
    let h = harness();
    let got = call(&h.main, "settings_get", json!({})).unwrap();
    assert_eq!(got["settings"]["theme"], "system");
    assert_eq!(got["settings"]["language"], Value::Null);
    let saved = call(
        &h.main,
        "settings_set",
        json!({ "patch": { "theme": "dark", "language": "es" } }),
    )
    .unwrap();
    assert_eq!(saved["theme"], "dark");
    assert_eq!(saved["language"], "es");
    let vault = copy_fixture("ambiguous-names");
    let info = call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let root = info["root"].as_str().unwrap().to_string();
    call(&h.main, "vaults_forget", json!({ "path": root })).unwrap();
    assert_eq!(
        call(&h.main, "vaults_recent", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn vlt_04_opening_emits_progress_events() {
    let h = harness();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    h.app.listen_any("vault:progress", move |e| {
        sink.lock().unwrap().push(e.payload().to_string())
    });
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let got = seen.lock().unwrap().clone();
    assert!(!got.is_empty());
    let last: Value = serde_json::from_str(got.last().unwrap()).unwrap();
    assert_eq!(last["done"], last["total"]);
}

/// Regression (real window: stuck on "Opening vault"): the UI subscribes to
/// `vault:*` events through Tauri's event plugin, so `main` must be allowed to
/// listen and unlisten — and another window must not be.
#[test]
fn vlt_04_main_window_may_listen_to_vault_events() {
    let h = harness();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    for event in ["vault:progress", "vault:changed", "vault:warning"] {
        let body = json!({ "event": event, "target": { "kind": "Any" }, "handler": 7 });
        if let Err(e) = call(&h.main, "plugin:event|listen", body.clone()) {
            panic!("main must be allowed to listen to {event}: {e}");
        }
        let err = call(&other, "plugin:event|listen", body).expect_err(event);
        assert!(err.to_string().contains("not allowed"), "{event}: {err}");
    }
    let unlisten = json!({ "event": "vault:progress", "eventId": 7 });
    if let Err(e) = call(&h.main, "plugin:event|unlisten", unlisten) {
        assert!(
            !e.to_string().contains("not allowed"),
            "main must be allowed to unlisten: {e}"
        );
    }
}
