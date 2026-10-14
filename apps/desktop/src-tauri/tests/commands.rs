//! M1b commands through the real IPC path: real `generate_context!()` (config +
//! capabilities), real command registration, mock runtime, temp config/cache dirs.

use nimw_desktop::AppDirs;
use nimw_testkit::{copy_fixture, real_trash_tests_enabled, trashable_fixture};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::test::MockRuntime;
use tauri::{
    App, Listener, Manager, WebviewWindow, WebviewWindowBuilder,
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
    "page_read",
    "page_write",
    "page_create_conflict_copy",
    "links_resolve",
    "url_open",
    "file_open_external",
    "fonts_list",
    "vault_settings_get",
    "vault_settings_set",
    "attachment_paste",
    "attachment_import",
    "cover_pick",
    "link_suggest",
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

/// Final review I2: Tauri runs non-`async` commands on the macOS main (UI)
/// thread, so any command that touches the disk, the index or the OS trash
/// must be `async` (it then runs on the async runtime / a blocking thread).
/// Only `settings_get` (in-memory) may stay synchronous.
#[test]
fn nfr_ui_thread_never_runs_disk_or_index_commands() {
    const SYNC_ALLOWED: &[&str] = &["settings_get"];
    let sources = [
        include_str!("../src/vault_commands.rs"),
        include_str!("../src/settings_commands.rs"),
        include_str!("../src/editor_commands.rs"),
        include_str!("../src/fonts.rs"),
        include_str!("../src/attachment_commands.rs"),
    ];
    let mut offenders = Vec::new();
    for src in sources {
        let lines: Vec<&str> = src.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            let sig = lines[i + 1].trim();
            let name = sig
                .split("fn ")
                .nth(1)
                .and_then(|s| s.split(['(', '<']).next())
                .unwrap_or(sig);
            if !sig.contains("async fn") && !SYNC_ALLOWED.contains(&name) {
                offenders.push(name.to_string());
            }
        }
    }
    assert!(offenders.is_empty(), "must be async: {offenders:?}");
}

/// M2a §3.1: full-text read and compare-and-swap write; a stale hash returns
/// a `conflict` error carrying the current text and hash, and writes nothing.
#[test]
fn ed_08_page_read_and_write_with_conflict_payload() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let read = call(&h.main, "page_read", json!({ "path": "Welcome.md" })).unwrap();
    let text = read["text"].as_str().unwrap().to_string();
    let hash = read["hash"].as_str().unwrap().to_string();
    let new_text = format!("{text}\nEdited [[Sparda]]\n");
    let written = call(
        &h.main,
        "page_write",
        json!({ "path": "Welcome.md", "text": new_text, "expectedHash": hash }),
    )
    .unwrap();
    assert_ne!(written["hash"], read["hash"]);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("Welcome.md")).unwrap(),
        new_text
    );
    let err = call(
        &h.main,
        "page_write",
        json!({ "path": "Welcome.md", "text": "lost", "expectedHash": hash }),
    )
    .unwrap_err();
    assert_eq!(kind(err.clone()), "conflict");
    assert_eq!(err["currentText"], new_text.as_str());
    assert_eq!(err["currentHash"], written["hash"]);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("Welcome.md")).unwrap(),
        new_text
    );
    let bad = call(
        &h.main,
        "page_write",
        json!({ "path": "Welcome.md", "text": "x", "expectedHash": "zz" }),
    )
    .unwrap_err();
    assert_eq!(kind(bad), "io");
}

#[test]
fn ed_08_page_read_refuses_binary_and_traversal() {
    let h = harness();
    let vault = copy_fixture("edge-cases");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let err = call(&h.main, "page_read", json!({ "path": "latin1.md" })).unwrap_err();
    assert_eq!(kind(err), "binary");
    let err = call(&h.main, "page_read", json!({ "path": "../outside.md" })).unwrap_err();
    assert_eq!(kind(err), "outsideVault");
}

#[test]
fn ed_08_conflict_copy_through_ipc() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let path = call(
        &h.main,
        "page_create_conflict_copy",
        json!({ "path": "Game Design/Game 1.md", "text": "theirs" }),
    )
    .unwrap();
    assert_eq!(path, "Game Design/Game 1 (conflict).md");
    assert_eq!(
        std::fs::read_to_string(vault.path().join("Game Design/Game 1 (conflict).md")).unwrap(),
        "theirs"
    );
}

#[test]
fn pg_05_links_resolve_through_ipc() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let got = call(
        &h.main,
        "links_resolve",
        json!({
            "source": "Character Design/rex-draft.md",
            "targets": [
                { "kind": "wiki", "target": "Sparda" },
                { "kind": "embed", "target": "rex-turnaround.png" },
                { "kind": "markdown", "target": "DMC/Sparda.md" },
                { "kind": "wiki", "target": "Nowhere" }
            ]
        }),
    )
    .unwrap();
    assert_eq!(
        got,
        json!([
            "Character Design/DMC/Sparda.md",
            "Character Design/assets/rex-turnaround.png",
            "Character Design/DMC/Sparda.md",
            null
        ])
    );
    let err = call(
        &h.main,
        "links_resolve",
        json!({ "source": "Welcome.md", "targets": [{ "kind": "bogus", "target": "x" }] }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "invalidUrl");
}

/// Opening in the OS browser / default app goes through our own commands
/// (no opener permission is granted to the webview); unsafe targets are refused
/// before anything is opened.
#[test]
fn external_open_commands_refuse_unsafe_targets() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    for url in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,x",
        "nimw-asset://x",
        "relative.md",
    ] {
        let err = call(&h.main, "url_open", json!({ "url": url })).unwrap_err();
        assert_eq!(kind(err), "invalidUrl", "{url}");
    }
    let err = call(&h.main, "file_open_external", json!({ "path": "../x.png" })).unwrap_err();
    assert_eq!(kind(err), "outsideVault");
    let err = call(&h.main, "file_open_external", json!({ "path": "nope.pdf" })).unwrap_err();
    assert_eq!(kind(err), "notFound");
    // m3: folders (an .app bundle is one), programs and scripts never reach
    // the OS opener. (Opening a real document isn't exercised here: it would
    // launch the default app; `check_openable` is unit-tested instead.)
    std::fs::create_dir_all(vault.path().join("Bundle.app/Contents/MacOS")).unwrap();
    std::fs::write(vault.path().join("run.sh"), "echo hi\n").unwrap();
    std::fs::write(vault.path().join("Setup.exe"), "MZ").unwrap();
    for path in ["Bundle.app", "Character Design", "run.sh", "Setup.exe"] {
        let err = call(&h.main, "file_open_external", json!({ "path": path })).unwrap_err();
        assert_eq!(kind(err), "invalidUrl", "{path}");
    }
    let err = call(
        &h.main,
        "plugin:opener|open_url",
        json!({ "url": "https://example.com" }),
    )
    .unwrap_err();
    assert!(err.to_string().contains("not allowed"), "{err}");
}

/// M2a §3.3: closing the window first flushes unsaved pages. The UI listens for
/// `tauri://close-requested` and then destroys the window itself, so `main`
/// needs `core:window:allow-destroy` — and another window must not get it.
#[test]
fn ed_08_main_window_may_flush_then_close_itself() {
    let h = harness();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    let listen = json!({
        "event": "tauri://close-requested",
        "target": { "kind": "Window", "label": "main" },
        "handler": 9
    });
    if let Err(e) = call(&h.main, "plugin:event|listen", listen) {
        panic!("main must be allowed to listen for close requests: {e}");
    }
    let destroy = json!({ "label": "other" });
    let err = call(&other, "plugin:window|destroy", destroy.clone()).expect_err("other");
    assert!(err.to_string().contains("not allowed"), "{err}");
    if let Err(e) = call(&h.main, "plugin:window|destroy", json!({ "label": "main" })) {
        assert!(
            !e.to_string().contains("not allowed"),
            "main must be allowed to destroy itself: {e}"
        );
    }
}

/// M1b hand-off §10 j: a read-only config dir must not stop a vault from
/// opening; the failed recent-vaults update becomes an index warning.
#[cfg(unix)]
#[test]
fn vlt_01_open_survives_an_unwritable_config_dir() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness();
    let config = h._config.path().to_path_buf();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o555)).unwrap();
    let vault = copy_fixture("obsidian-basic");
    let res = call(&h.main, "vault_open", json!({ "path": vault.path() }));
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o755)).unwrap();
    let info = res.expect("vault opens");
    let warnings: Vec<String> = serde_json::from_value(info["report"]["warnings"].clone()).unwrap();
    assert!(
        warnings.iter().any(|w| w.contains("recent vaults")),
        "{warnings:?}"
    );
    call(&h.main, "vault_tree", json!({})).expect("the vault is open");
}

/// M2b §7: the new appearance/editor settings travel through `settings_set`
/// and come back from `settings_get`; an invalid value is refused.
#[test]
fn m2b_settings_round_trip_over_ipc() {
    let h = harness();
    let saved = call(
        &h.main,
        "settings_set",
        json!({ "patch": {
            "palette": "graphite",
            "accentColor": "#2AA198",
            "fontLivePreview": "system:Avenir Next",
            "fontSource": "source-code-pro",
            "fontSize": 17,
            "toolbar": false,
            "lineNumbers": true
        }}),
    )
    .unwrap();
    assert_eq!(saved["palette"], "graphite");
    assert_eq!(saved["accentColor"], "#2aa198");
    assert_eq!(saved["fontLivePreview"], "system:Avenir Next");
    assert_eq!(saved["fontSource"], "source-code-pro");
    assert_eq!(saved["fontSize"], 17);
    assert_eq!(saved["toolbar"], false);
    assert_eq!(saved["lineNumbers"], true);
    let got = call(&h.main, "settings_get", json!({})).unwrap();
    assert_eq!(got["settings"]["palette"], "graphite");
    assert!(
        call(
            &h.main,
            "settings_set",
            json!({ "patch": { "accentColor": "red" } })
        )
        .is_err()
    );
}

/// M2b §5: the fonts installed on this computer, read locally (no network):
/// unique family names, sorted, without hidden (dot) families.
#[test]
fn m2b_fonts_list_returns_installed_families() {
    let h = harness();
    let list = call(&h.main, "fonts_list", json!({})).unwrap();
    let families: Vec<String> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(!families.is_empty(), "every desktop OS has fonts");
    assert!(
        families
            .iter()
            .all(|f| !f.starts_with('.') && !f.trim().is_empty())
    );
    let mut sorted = families.clone();
    sorted.sort_by_key(|f| f.to_lowercase());
    sorted.dedup_by_key(|f| f.to_lowercase());
    assert_eq!(families, sorted, "sorted case-insensitively, no duplicates");
    // Cached: a second call returns the same list.
    assert_eq!(call(&h.main, "fonts_list", json!({})).unwrap(), list);
}

/// A raw-body request (`invoke(cmd, Uint8Array, { headers })` in the UI).
fn raw_request(cmd: &str, body: Vec<u8>, headers: &[(&'static str, &str)]) -> InvokeRequest {
    let mut req = request(cmd, json!({}));
    req.body = InvokeBody::Raw(body);
    for (name, value) in headers {
        req.headers
            .insert(*name, tauri::http::HeaderValue::from_str(value).unwrap());
    }
    req
}

fn open_fixture(h: &Harness, name: &str) -> tempfile::TempDir {
    let vault = copy_fixture(name);
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    vault
}

/// M2c §7.5: NIMW's attachment setting over IPC; Obsidian's wins and blocks it.
#[test]
fn m2c_vault_settings_round_trip_over_ipc() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(
        got,
        json!({ "attachments": { "mode": "subfolder", "path": "attachments" }, "obsidian": null })
    );
    let saved = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "attachments": { "mode": "folder", "path": "Media" } } }),
    )
    .unwrap();
    assert_eq!(
        saved["attachments"],
        json!({ "mode": "folder", "path": "Media" })
    );
    assert!(vault.path().join(".nimw/vault.json").is_file());
    let err = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "attachments": { "mode": "subfolder", "path": "a/b" } } }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "invalidName");

    let h = harness();
    let _obsidian = open_fixture(&h, "obsidian-basic");
    assert_eq!(
        call(&h.main, "vault_settings_get", json!({})).unwrap()["obsidian"],
        "./assets"
    );
    let err = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "attachments": { "mode": "same" } } }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}

/// M2c §5.1 / §7.3: a pasted image arrives as a raw body with percent-encoded
/// headers; it is saved, indexed and linked. Wrong types and JSON are refused.
#[test]
fn m2c_attachment_paste_takes_a_raw_body() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let page = "Character%20Design/rex-draft.md";
    let name = "Pasted%20image%2020261014101500.png";
    let res = get_ipc_response(
        &h.main,
        raw_request(
            "attachment_paste",
            b"\x89PNG".to_vec(),
            &[("x-nimw-page", page), ("x-nimw-name", name)],
        ),
    )
    .map(|r| r.deserialize::<Value>().unwrap())
    .unwrap();
    assert_eq!(
        res,
        json!({
            "path": "Character Design/assets/Pasted image 20261014101500.png",
            "link": "Pasted image 20261014101500.png",
            "copied": true
        })
    );
    assert_eq!(
        std::fs::read(
            vault
                .path()
                .join("Character Design/assets/Pasted image 20261014101500.png")
        )
        .unwrap(),
        b"\x89PNG"
    );
    let refuse = |body: Vec<u8>, name: &str| {
        kind(
            get_ipc_response(
                &h.main,
                raw_request(
                    "attachment_paste",
                    body,
                    &[("x-nimw-page", page), ("x-nimw-name", name)],
                ),
            )
            .map(|r| r.deserialize::<Value>().unwrap())
            .unwrap_err(),
        )
    };
    assert_eq!(refuse(b"<svg/>".to_vec(), "x.svg"), "invalidName");
    assert_eq!(refuse(Vec::new(), "x.png"), "invalidName");
    assert_eq!(
        refuse(
            vec![0u8; nimw_desktop::attachment_commands::MAX_PASTE_BYTES + 1],
            "x.png"
        ),
        "tooLarge"
    );
    let err = call(&h.main, "attachment_paste", json!({ "page": "x.md" })).unwrap_err();
    assert_eq!(kind(err), "invalidName");
}

/// M2c §8: only paths seen in a native drop are imported, once each.
#[test]
fn m2c_attachment_import_requires_a_native_drop_grant() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let outside = tempfile::tempdir().unwrap();
    let dropped = outside.path().join("brief.pdf");
    let secret = outside.path().join("id_ed25519");
    std::fs::write(&dropped, b"%PDF").unwrap();
    std::fs::write(&secret, b"key").unwrap();
    let window = h.main.as_ref().window();
    nimw_desktop::drops::on_window_event(
        &window,
        &tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
            paths: vec![dropped.clone(), outside.path().to_path_buf()],
            position: tauri::PhysicalPosition::new(10.0, 10.0),
        }),
    );
    let page = "Character Design/rex-draft.md";
    let results = call(
        &h.main,
        "attachment_import",
        json!({ "page": page, "paths": [dropped, secret, outside.path()] }),
    )
    .unwrap();
    assert_eq!(
        results[0],
        json!({ "source": dropped, "ok": { "path": "Character Design/assets/brief.pdf", "link": "brief.pdf", "copied": true } })
    );
    assert_eq!(results[1]["err"]["kind"], "notPermitted");
    assert_eq!(results[2]["err"]["kind"], "notAFile");
    assert!(
        !vault
            .path()
            .join("Character Design/assets/id_ed25519")
            .exists()
    );
    // A grant is used once.
    let again = call(
        &h.main,
        "attachment_import",
        json!({ "page": page, "paths": [dropped] }),
    )
    .unwrap();
    assert_eq!(again[0]["err"]["kind"], "notPermitted");
}

/// M2c §7.4: Rust picks the cover file (a fake picker in tests), imports it
/// and returns the frontmatter reference; cancelling returns null.
#[test]
fn m2c_cover_pick_imports_the_picked_image() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    let outside = tempfile::tempdir().unwrap();
    let image = outside.path().join("sky.png");
    std::fs::write(&image, b"\x89PNG").unwrap();
    let state = h.app.state::<nimw_desktop::state::AppState>();
    let picked = image.clone();
    state.set_cover_picker(Some(Arc::new(move || Some(picked.clone()))));
    let cover = call(
        &h.main,
        "cover_pick",
        json!({ "page": "Character Design/rex-draft.md" }),
    )
    .unwrap();
    assert_eq!(
        cover,
        json!({ "path": "Character Design/assets/sky.png", "reference": "assets/sky.png" })
    );
    state.set_cover_picker(Some(Arc::new(|| None)));
    assert_eq!(
        call(&h.main, "cover_pick", json!({ "page": "Welcome.md" })).unwrap(),
        Value::Null
    );
}

/// M2c §7.2 + PG-05 over IPC; `page_get` carries `coverY`.
#[test]
fn m2c_link_suggest_and_cover_y_over_ipc() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    let found = call(
        &h.main,
        "link_suggest",
        json!({ "source": "Welcome.md", "query": "gen", "embed": false }),
    )
    .unwrap();
    assert_eq!(
        found[0],
        json!({
            "path": "Character Design/rex-draft.md",
            "kind": "page",
            "title": "Generator Rex",
            "target": "rex-draft"
        })
    );
    let page = call(
        &h.main,
        "page_get",
        json!({ "path": "Character Design/rex-draft.md" }),
    )
    .unwrap();
    assert_eq!(page["coverY"], 40);
    let welcome = call(&h.main, "page_get", json!({ "path": "Welcome.md" })).unwrap();
    assert_eq!(welcome["coverY"], Value::Null);
}

/// Review focus (M2c §2): a cover saved outside the page's folder (attachments
/// in a fixed vault folder) gets a vault-rooted reference that resolves back.
#[test]
fn m2c_cover_outside_the_page_folder_is_vault_rooted_and_resolves() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir(vault.path().join("Chars")).unwrap();
    std::fs::write(vault.path().join("Chars/Rex.md"), "# Rex\n").unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "attachments": { "mode": "folder", "path": "Media" } } }),
    )
    .unwrap();
    let outside = tempfile::tempdir().unwrap();
    let image = outside.path().join("sky.png");
    std::fs::write(&image, b"\x89PNG").unwrap();
    let state = h.app.state::<nimw_desktop::state::AppState>();
    state.set_cover_picker(Some(Arc::new(move || Some(image.clone()))));
    let cover = call(&h.main, "cover_pick", json!({ "page": "Chars/Rex.md" })).unwrap();
    assert_eq!(
        cover,
        json!({ "path": "Media/sky.png", "reference": "/Media/sky.png" })
    );
    let resolved = call(
        &h.main,
        "links_resolve",
        json!({ "source": "Chars/Rex.md", "targets": [{ "kind": "cover", "target": "/Media/sky.png" }] }),
    )
    .unwrap();
    assert_eq!(resolved, json!(["Media/sky.png"]));
}
