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
    "window_close_self",
    "window_title_set",
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
    "vaults_reveal",
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
    "gv_children",
    "gv_edges",
    "layout_get",
    "layout_set",
    "link_target",
    "index_pick_set",
    "page_width_set",
    "text_read",
    "text_write",
    "entry_create_text",
    "cover_height_set",
    "cover_side_set",
    "cover_width_set",
    "links_external",
    "external_open",
    "external_reveal",
    "external_network_allow",
    "file_pick",
    "search",
    "folder_icon_set",
    "vault_icon_set",
    // M5b §5: the vault's Trash and Archive.
    "bin_list",
    "trash_restore",
    "trash_delete",
    "trash_empty",
    "entry_archive",
    "archive_restore",
    // M5b round 2: folder orders.
    "folder_sort_get",
    "folder_sort_set",
    // M5b §19: Favorites.
    "favorites_get",
    "favorites_set",
    // M6: audio clips.
    "audio_devices",
    "audio_record_start",
    "audio_record_stop",
    "audio_record_cancel",
    "audio_pick",
    // Spell checking: local dictionaries.
    "spell_dictionaries",
    "spell_import",
    "spell_remove",
    "spell_check",
    "spell_suggest",
    "spell_add_word",
    "spell_ignore",
    "spell_words",
    "spell_remove_word",
    "spell_vault_get",
    "spell_vault_set",
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
    assert_eq!(out["pair"], json!(null));
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

/// R3 §7: the Welcome screen can show a recent vault in Finder or Explorer,
/// but only a vault on the recent list (the webview can't reveal any path).
#[test]
fn r3_vaults_reveal_refuses_a_path_not_on_the_recent_list() {
    let h = harness();
    let elsewhere = tempfile::tempdir().unwrap();
    let err = call(
        &h.main,
        "vaults_reveal",
        json!({ "path": elsewhere.path() }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
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
/// `tauri://close-requested` and then closes the window itself with
/// `window_close_self` (M4c review I2: the window plugin's `destroy` takes
/// any label, so no window has it) — and another window gets neither.
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
    let err = call(&other, "window_close_self", json!({})).expect_err("other");
    assert!(err.to_string().contains("not allowed"), "{err}");
    let err = call(&h.main, "plugin:window|destroy", json!({ "label": "main" })).expect_err("main");
    assert!(err.to_string().contains("not allowed"), "{err}");
    call(&h.main, "window_close_self", json!({})).expect("main closes itself");
}

/// M5b §11.8: the page names its own window ("Page — Vault"); the mock
/// runtime keeps no title, so the cleaning is a unit test (`clean_title`).
#[test]
fn m5b_window_title_set_is_the_main_windows() {
    let h = harness();
    call(
        &h.main,
        "window_title_set",
        json!({ "title": "Military Ranks — Dark Galaxy" }),
    )
    .expect("main sets its title");
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
            "lineNumbers": true,
            "globalViewMode": "expand",
            "globalViewEdges": { "links": false, "tree": true, "manual": true, "aggregated": true }
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
    assert_eq!(saved["globalViewMode"], "expand");
    assert_eq!(saved["globalViewEdges"]["links"], false);
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
        json!({
            "attachments": { "mode": "subfolder", "path": "attachments" },
            "obsidian": null,
            "overrideObsidian": false,
            "pageWidth": null,
            "pageWidths": {},
            "coverHeights": {},
            "coverSides": {},
            "coverWidths": {},
            "attachmentLinkFormat": null,
            "obsidianLinkFormat": null
        })
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

/// M4b §5: with Obsidian's setting present, NIMW's own place applies only
/// while `overrideObsidian` is on; turning it off restores Obsidian's.
#[test]
fn m4b_vault_settings_override_obsidian_over_ipc() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let app_json = std::fs::read(vault.path().join(".obsidian/app.json")).unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["obsidian"], "./assets");
    assert_eq!(got["overrideObsidian"], false);
    let saved = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "attachments": { "mode": "same" }, "overrideObsidian": true } }),
    )
    .unwrap();
    assert_eq!(saved["overrideObsidian"], true);
    assert_eq!(saved["attachments"], json!({ "mode": "same", "path": "" }));
    // The override alone can be turned off; the place is kept for next time.
    let saved = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "overrideObsidian": false } }),
    )
    .unwrap();
    assert_eq!(saved["overrideObsidian"], false);
    assert_eq!(saved["attachments"], json!({ "mode": "same", "path": "" }));
    // Without the override, the place can't change while Obsidian's applies.
    let err = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "attachments": { "mode": "vault" } } }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    assert_eq!(
        std::fs::read(vault.path().join(".obsidian/app.json")).unwrap(),
        app_json
    );
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
    assert_eq!(page["coverX"], Value::Null);
    let welcome = call(&h.main, "page_get", json!({ "path": "Welcome.md" })).unwrap();
    assert_eq!(welcome["coverY"], Value::Null);
}

/// M5 §5: search over IPC, camelCase both ways, with filters and facets.
#[test]
fn m5_search_over_ipc() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    let found = call(
        &h.main,
        "search",
        json!({ "query": { "text": "generator" } }),
    )
    .unwrap();
    assert_eq!(found["results"][0]["path"], "Character Design/rex-draft.md");
    assert_eq!(found["results"][0]["title"], "Generator Rex");
    assert_eq!(
        found["results"][0]["cover"],
        "Character Design/assets/rex-cover.png"
    );
    assert_eq!(found["results"][0]["hasImage"], true);
    assert_eq!(found["recent"], false);
    assert_eq!(found["indexing"], false);
    assert!(found["facets"]["tags"].is_array());
    assert!(found["facets"]["linksTo"].is_array());
    assert_eq!(found["facets"]["linksFrom"], Value::Null);

    let tagged = call(
        &h.main,
        "search",
        json!({ "query": { "tags": ["character"], "hasImage": true, "limit": 5 } }),
    )
    .unwrap();
    assert_eq!(tagged["total"], 1);
    assert_eq!(tagged["results"][0]["tags"][0], "character");
    assert!(
        tagged["facets"]["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["value"] == "Character Design")
    );

    let recent = call(&h.main, "search", json!({ "query": {} })).unwrap();
    assert_eq!(recent["recent"], true);
    assert!(recent["results"].as_array().unwrap().len() >= 4);
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

/// Final review M7: the `page` an attachment is placed for must be a visible,
/// indexed page. A compromised UI naming a hidden one (`.obsidian/x.md`,
/// `.git/hooks/x.md`) or a missing one is refused before anything is written
/// (and, for the cover, before the dialog opens).
#[test]
fn m2c_attachments_refuse_a_hidden_or_missing_page() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic"); // attachmentFolderPath "./assets"
    std::fs::write(vault.path().join(".obsidian/x.md"), "# x\n").unwrap();
    std::fs::create_dir_all(vault.path().join(".git/hooks")).unwrap();
    std::fs::write(vault.path().join(".git/hooks/x.md"), "# x\n").unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();

    // Paste.
    for page in [".obsidian/x.md", ".git/hooks/x.md", "Nope.md"] {
        let err = get_ipc_response(
            &h.main,
            raw_request(
                "attachment_paste",
                b"\x89PNG".to_vec(),
                &[("x-nimw-page", page), ("x-nimw-name", "shot.png")],
            ),
        )
        .map(|r| r.deserialize::<Value>().unwrap())
        .unwrap_err();
        assert_eq!(kind(err), "notFound", "paste for {page}");
    }
    assert!(!vault.path().join(".obsidian/assets").exists());
    assert!(!vault.path().join(".git/hooks/assets").exists());
    assert!(!vault.path().join("assets").exists());

    // Drop: granted by a native drop, so only the page decides.
    let outside = tempfile::tempdir().unwrap();
    let dropped = outside.path().join("main.js");
    std::fs::write(&dropped, b"evil()").unwrap();
    let window = h.main.as_ref().window();
    nimw_desktop::drops::on_window_event(
        &window,
        &tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
            paths: vec![dropped.clone()],
            position: tauri::PhysicalPosition::new(10.0, 10.0),
        }),
    );
    let err = call(
        &h.main,
        "attachment_import",
        json!({ "page": ".obsidian/x.md", "paths": [dropped] }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notFound");
    assert!(!vault.path().join(".obsidian/assets").exists());

    // Cover: refused before the dialog opens.
    let asked = Arc::new(Mutex::new(0));
    let image = outside.path().join("sky.png");
    std::fs::write(&image, b"\x89PNG").unwrap();
    let state = h.app.state::<nimw_desktop::state::AppState>();
    let counter = asked.clone();
    state.set_cover_picker(Some(Arc::new(move || {
        *counter.lock().unwrap() += 1;
        Some(image.clone())
    })));
    for page in [".git/hooks/x.md", ".obsidian/x.md", "Nope.md"] {
        let err = call(&h.main, "cover_pick", json!({ "page": page })).unwrap_err();
        assert_eq!(kind(err), "notFound", "cover for {page}");
    }
    assert_eq!(*asked.lock().unwrap(), 0);
    assert!(!vault.path().join(".git/hooks/assets").exists());

    // A visible page still works.
    let cover = call(&h.main, "cover_pick", json!({ "page": "Welcome.md" })).unwrap();
    assert_eq!(cover["path"], "assets/sky.png");
}

/// M3a §8: Global View levels over IPC (camelCase cards; index notes; the
/// Obsidian attachment folder `assets` is no card; page neighbourhoods).
#[test]
fn m3a_gv_children_over_ipc() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    let level = |body: Value| call(&h.main, "gv_children", json!({ "level": body }));
    let paths = |v: &Value| -> Vec<String> {
        v["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["path"].as_str().unwrap().to_string())
            .collect()
    };
    let root = level(json!({ "kind": "vault" })).unwrap();
    assert_eq!(
        paths(&root),
        ["Character Design", "Game Design", "Welcome.md"]
    );
    assert_eq!(root["cards"][0]["kind"], "project");
    assert_eq!(root["cards"][1]["indexPage"], "Game Design/Game 1.md");
    assert_eq!(root["cards"][1]["title"], "Game 1");
    assert_eq!(root["centre"], Value::Null);
    assert_eq!(root["omitted"], 0, "m14: neighbours over the cap");

    let chars = level(json!({ "kind": "folder", "path": "Character Design" })).unwrap();
    assert_eq!(
        paths(&chars),
        [
            "Character Design/DMC",
            "Character Design/My characters.md",
            "Character Design/rex-draft.md"
        ]
    );
    let dmc = &chars["cards"][0];
    assert_eq!(dmc["kind"], "folder");
    assert_eq!(dmc["indexPage"], "Character Design/DMC/Sparda.md");
    assert_eq!(
        (dmc["pages"].as_u64(), dmc["folders"].as_u64()),
        (Some(1), Some(0))
    );
    let rex = &chars["cards"][2];
    assert_eq!(rex["cover"], "Character Design/assets/rex-cover.png");
    assert_eq!(rex["coverY"], 40);
    assert_eq!(rex["coverX"], Value::Null);
    assert_eq!(rex["coverSide"], "top");
    assert_eq!(rex["coverRemote"], false);
    assert_eq!(rex["subtitle"], "Hero redesign · v3");
    assert_eq!(rex["hasImage"], true);
    assert_eq!(rex["hasAudio"], true);

    let page = level(json!({ "kind": "page", "path": "Character Design/rex-draft.md" })).unwrap();
    assert_eq!(page["centre"], "Character Design/rex-draft.md");
    let relation = |path: &str| {
        page["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["path"] == path)
            .map(|c| c["relation"].clone())
    };
    assert_eq!(
        relation("Character Design/rex-draft.md"),
        Some(json!("centre"))
    );
    assert_eq!(relation("Game Design/Game 1.md"), Some(json!("both")));
    assert_eq!(
        relation("Character Design/My characters.md"),
        Some(json!("in"))
    );
    assert_eq!(
        relation("Character Design/DMC/Sparda.md"),
        Some(json!("out"))
    );

    let missing = level(json!({ "kind": "folder", "path": "Nope" })).unwrap_err();
    assert_eq!(kind(missing), "notFound");
    assert!(level(json!({ "kind": "galaxy" })).is_err());
}

/// M3a §6, §8: aggregated edges between visible cards; at most 1,000 cards.
#[test]
fn m3a_gv_edges_over_ipc() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    let edges = call(
        &h.main,
        "gv_edges",
        json!({ "visible": ["Character Design", "Game Design", "Welcome.md"] }),
    )
    .unwrap();
    let edges = edges.as_array().unwrap();
    let find = |a: &str, b: &str, kind: &str| {
        edges
            .iter()
            .find(|e| {
                e["kind"] == kind
                    && ((e["from"] == a && e["to"] == b) || (e["from"] == b && e["to"] == a))
            })
            .cloned()
            .unwrap_or_else(|| panic!("no {kind} edge {a}–{b} in {edges:?}"))
    };
    let links = find("Character Design", "Game Design", "link");
    assert_eq!(
        (links["count"].as_u64(), links["aggregated"].as_bool()),
        (Some(3), Some(true))
    );
    let manual = find("Character Design", "Game Design", "manual");
    assert_eq!(manual["directed"], true);
    assert_eq!(manual["label"], "playable version");
    assert_eq!(
        (manual["from"].as_str(), manual["to"].as_str()),
        (Some("Character Design"), Some("Game Design"))
    );
    find("Character Design", "Welcome.md", "link");
    assert_eq!(edges.len(), 3, "{edges:?}");

    let too_many: Vec<String> = (0..1001).map(|i| format!("p{i}.md")).collect();
    let err = call(&h.main, "gv_edges", json!({ "visible": too_many })).unwrap_err();
    assert_eq!(kind(err), "tooLarge");
}

/// M3a §7: pinned positions round-trip per level; an empty map removes it.
#[test]
fn m3a_layout_get_set_over_ipc() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    assert_eq!(
        call(&h.main, "layout_get", json!({ "level": "" })).unwrap(),
        json!({})
    );
    assert!(!vault.path().join(".nimw").exists(), "VLT-02");
    call(
        &h.main,
        "layout_set",
        json!({ "level": "", "positions": { "Game Design": { "x": 12.5, "y": -40 } } }),
    )
    .unwrap();
    assert_eq!(
        call(&h.main, "layout_get", json!({ "level": "" })).unwrap(),
        json!({ "Game Design": { "x": 12.5, "y": -40.0 } })
    );
    assert!(vault.path().join(".nimw/layout.json").exists());
    call(
        &h.main,
        "layout_set",
        json!({ "level": "", "positions": {} }),
    )
    .unwrap();
    assert_eq!(
        call(&h.main, "layout_get", json!({ "level": "" })).unwrap(),
        json!({})
    );
}

/// M3b §6: the wiki target a relationship writes, and index-note picks, over
/// IPC; a pick answers the folder's card, and only visible paths are taken.
#[test]
fn m3b_link_target_and_index_pick_set_over_ipc() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    assert_eq!(
        call(
            &h.main,
            "link_target",
            json!({ "source": "Welcome.md", "target": "Character Design/DMC/Sparda.md" })
        )
        .unwrap(),
        json!("Sparda")
    );
    assert_eq!(
        kind(
            call(
                &h.main,
                "link_target",
                json!({ "source": "Welcome.md", "target": "nope.md" })
            )
            .unwrap_err()
        ),
        "notFound"
    );

    assert!(!vault.path().join(".nimw").exists(), "VLT-02");
    let card = call(
        &h.main,
        "index_pick_set",
        json!({ "folder": "Character Design", "page": "Character Design/My characters.md" }),
    )
    .unwrap();
    assert_eq!(card["path"], "Character Design");
    assert_eq!(card["indexPage"], "Character Design/My characters.md");
    assert_eq!(card["indexFrom"], "picked");
    let json: Value = serde_json::from_str(
        &std::fs::read_to_string(vault.path().join(".nimw/vault.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        json["indexPicks"]["Character Design"],
        "Character Design/My characters.md"
    );
    let cleared = call(
        &h.main,
        "index_pick_set",
        json!({ "folder": "Character Design", "page": null }),
    )
    .unwrap();
    assert_eq!(cleared["indexPage"], Value::Null);

    for (folder, page) in [
        (".obsidian", ".obsidian/app.json"),
        ("Character Design", "Welcome.md"),
        ("Character Design", "Character Design/DMC/Sparda.md"),
        ("Character Design", "../x.md"),
    ] {
        assert!(
            call(
                &h.main,
                "index_pick_set",
                json!({ "folder": folder, "page": page })
            )
            .is_err(),
            "{folder} ← {page}"
        );
    }
}

/// M4b part 2 §1: a page's own width and the vault's default live in
/// `.nimw/vault.json`; the page entry follows a rename; only visible pages.
#[test]
fn m4b2_page_width_over_ipc() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["pageWidth"], serde_json::Value::Null);
    assert_eq!(got["pageWidths"], json!({}));
    let saved = call(
        &h.main,
        "page_width_set",
        json!({ "path": "Welcome.md", "width": "full" }),
    )
    .unwrap();
    assert_eq!(saved["pageWidths"], json!({ "Welcome.md": "full" }));
    let saved = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "pageWidth": "readable" } }),
    )
    .unwrap();
    assert_eq!(saved["pageWidth"], "readable");
    // M4b part 3 (wide elements §2): `wide` at both levels.
    let saved = call(
        &h.main,
        "page_width_set",
        json!({ "path": "Welcome.md", "width": "wide" }),
    )
    .unwrap();
    assert_eq!(saved["pageWidths"], json!({ "Welcome.md": "wide" }));
    let saved = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "pageWidth": "wide" } }),
    )
    .unwrap();
    assert_eq!(saved["pageWidth"], "wide");
    call(
        &h.main,
        "page_width_set",
        json!({ "path": "Welcome.md", "width": "full" }),
    )
    .unwrap();
    // The page entry follows an in-app rename.
    call(
        &h.main,
        "entry_rename",
        json!({ "from": "Welcome.md", "to": "Hello.md" }),
    )
    .unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["pageWidths"], json!({ "Hello.md": "full" }));
    // Clearing: the page entry and the vault default.
    call(
        &h.main,
        "page_width_set",
        json!({ "path": "Hello.md", "width": null }),
    )
    .unwrap();
    let got = call(
        &h.main,
        "vault_settings_set",
        json!({ "patch": { "pageWidth": "default" } }),
    )
    .unwrap();
    assert_eq!(got["pageWidth"], serde_json::Value::Null);
    assert_eq!(got["pageWidths"], json!({}));
    // Only visible, indexed pages; a bad width is refused.
    for path in [".obsidian/x.md", "Missing.md"] {
        let err = call(
            &h.main,
            "page_width_set",
            json!({ "path": path, "width": "full" }),
        )
        .unwrap_err();
        assert_eq!(kind(err), "notFound", "{path}");
    }
    assert!(
        call(
            &h.main,
            "page_width_set",
            json!({ "path": "Hello.md", "width": "huge" })
        )
        .is_err()
    );
    assert!(vault.path().join(".nimw/vault.json").exists());
}

/// Cover resize: a page's cover height lives in `.nimw/vault.json`
/// (`coverHeights`), never in the note; clamped to 132–2000 px; the entry
/// follows an in-app rename; only visible, indexed pages.
#[test]
fn cover_height_over_ipc() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let before = std::fs::read(vault.path().join("Welcome.md")).unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["coverHeights"], json!({}));
    let saved = call(
        &h.main,
        "cover_height_set",
        json!({ "path": "Welcome.md", "height": 280 }),
    )
    .unwrap();
    assert_eq!(saved["coverHeights"], json!({ "Welcome.md": 280 }));
    // A fractional drag position is rounded; out-of-range values are clamped.
    let saved = call(
        &h.main,
        "cover_height_set",
        json!({ "path": "Welcome.md", "height": 300.6 }),
    )
    .unwrap();
    assert_eq!(saved["coverHeights"], json!({ "Welcome.md": 301 }));
    for (height, kept) in [(10, 132), (99_999, 2000)] {
        let saved = call(
            &h.main,
            "cover_height_set",
            json!({ "path": "Welcome.md", "height": height }),
        )
        .unwrap();
        assert_eq!(saved["coverHeights"]["Welcome.md"], kept, "{height}");
    }
    // The note itself is never written.
    assert_eq!(
        std::fs::read(vault.path().join("Welcome.md")).unwrap(),
        before
    );
    // The entry follows an in-app rename.
    call(
        &h.main,
        "entry_rename",
        json!({ "from": "Welcome.md", "to": "Hello.md" }),
    )
    .unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["coverHeights"], json!({ "Hello.md": 2000 }));
    let file: Value =
        serde_json::from_slice(&std::fs::read(vault.path().join(".nimw/vault.json")).unwrap())
            .unwrap();
    assert_eq!(file["coverHeights"], json!({ "Hello.md": 2000 }));
    // `null` clears it.
    let got = call(
        &h.main,
        "cover_height_set",
        json!({ "path": "Hello.md", "height": null }),
    )
    .unwrap();
    assert_eq!(got["coverHeights"], json!({}));
    // Only visible, indexed pages; a height that isn't a number is refused.
    for path in [".obsidian/x.md", "Missing.md", "../x.md"] {
        assert!(
            call(
                &h.main,
                "cover_height_set",
                json!({ "path": path, "height": 200 })
            )
            .is_err(),
            "{path}"
        );
    }
    let err = call(
        &h.main,
        "cover_height_set",
        json!({ "path": "Missing.md", "height": 200 }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notFound");
    assert!(
        call(
            &h.main,
            "cover_height_set",
            json!({ "path": "Hello.md", "height": "tall" })
        )
        .is_err()
    );
}

/// Cover resize: the command is in the main window's capability and nowhere
/// else (the real ACL from `capabilities/main.json`, not a test stand-in).
#[test]
fn cover_height_set_is_allowed_from_main_only() {
    let h = harness();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    let main = call(
        &h.main,
        "cover_height_set",
        json!({ "path": "A.md", "height": 200 }),
    )
    .unwrap_err();
    assert!(!main.to_string().contains("not allowed"), "{main}");
    assert_eq!(kind(main), "noVault");
    let denied = call(
        &other,
        "cover_height_set",
        json!({ "path": "A.md", "height": 200 }),
    )
    .unwrap_err();
    assert!(denied.to_string().contains("not allowed"), "{denied}");
}

/// M4b part 3 §3: a page's cover placement (`coverSides`) and strip width
/// (`coverWidths`) live in `.nimw/vault.json`, never in the note; `top`
/// clears the placement, widths are clamped to 160–2000 px; both follow an
/// in-app rename; only visible, indexed pages; Global View cards carry the
/// placement.
#[test]
fn cover_side_and_width_over_ipc() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let before = std::fs::read(vault.path().join("Welcome.md")).unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["coverSides"], json!({}));
    assert_eq!(got["coverWidths"], json!({}));
    let saved = call(
        &h.main,
        "cover_side_set",
        json!({ "path": "Welcome.md", "side": "left" }),
    )
    .unwrap();
    assert_eq!(saved["coverSides"], json!({ "Welcome.md": "left" }));
    let level = call(
        &h.main,
        "gv_children",
        json!({ "level": { "kind": "vault" } }),
    )
    .unwrap();
    let welcome = level["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["path"] == "Welcome.md")
        .unwrap();
    assert_eq!(welcome["coverSide"], "left");
    let saved = call(
        &h.main,
        "cover_width_set",
        json!({ "path": "Welcome.md", "width": 300.4 }),
    )
    .unwrap();
    assert_eq!(saved["coverWidths"], json!({ "Welcome.md": 300 }));
    for (width, kept) in [(10, 160), (99_999, 2000)] {
        let saved = call(
            &h.main,
            "cover_width_set",
            json!({ "path": "Welcome.md", "width": width }),
        )
        .unwrap();
        assert_eq!(saved["coverWidths"]["Welcome.md"], kept, "{width}");
    }
    assert_eq!(
        std::fs::read(vault.path().join("Welcome.md")).unwrap(),
        before,
        "the note itself is never written"
    );
    call(
        &h.main,
        "entry_rename",
        json!({ "from": "Welcome.md", "to": "Hello.md" }),
    )
    .unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["coverSides"], json!({ "Hello.md": "left" }));
    assert_eq!(got["coverWidths"], json!({ "Hello.md": 2000 }));
    // `top` clears the placement, `null` the width.
    let got = call(
        &h.main,
        "cover_side_set",
        json!({ "path": "Hello.md", "side": "top" }),
    )
    .unwrap();
    assert_eq!(got["coverSides"], json!({}));
    let got = call(
        &h.main,
        "cover_width_set",
        json!({ "path": "Hello.md", "width": null }),
    )
    .unwrap();
    assert_eq!(got["coverWidths"], json!({}));
    // Only visible, indexed pages; unknown sides and non-numbers are refused.
    for path in [".obsidian/x.md", "Missing.md", "../x.md"] {
        assert!(
            call(
                &h.main,
                "cover_side_set",
                json!({ "path": path, "side": "left" })
            )
            .is_err(),
            "{path}"
        );
        assert!(
            call(
                &h.main,
                "cover_width_set",
                json!({ "path": path, "width": 300 })
            )
            .is_err(),
            "{path}"
        );
    }
    let err = call(
        &h.main,
        "cover_side_set",
        json!({ "path": "Hello.md", "side": "diagonal" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "invalidName");
    assert!(
        call(
            &h.main,
            "cover_width_set",
            json!({ "path": "Hello.md", "width": "wide" })
        )
        .is_err()
    );
}

/// M4b part 3 §3: both commands are in the main window's capability and
/// nowhere else (the real ACL from `capabilities/main.json`).
#[test]
fn cover_side_and_width_set_are_allowed_from_main_only() {
    let h = harness();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    for (cmd, args) in [
        ("cover_side_set", json!({ "path": "A.md", "side": "left" })),
        ("cover_width_set", json!({ "path": "A.md", "width": 300 })),
    ] {
        let main = call(&h.main, cmd, args.clone()).unwrap_err();
        assert!(!main.to_string().contains("not allowed"), "{cmd}: {main}");
        assert_eq!(kind(main), "noVault", "{cmd}");
        let denied = call(&other, cmd, args).unwrap_err();
        assert!(
            denied.to_string().contains("not allowed"),
            "{cmd}: {denied}"
        );
    }
}

/// M4b part 2 §6: text files over IPC — read, compare-and-swap write with the
/// conflict reply, `notAText` for anything that isn't an eligible text file.
#[test]
fn m4b2_text_files_over_ipc() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("notes.txt"), "one\n").unwrap();
    std::fs::write(vault.path().join("data.json"), b"{\"a\":\0}").unwrap();
    std::fs::write(vault.path().join("Page.md"), "# Page\n").unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let got = call(&h.main, "text_read", json!({ "path": "notes.txt" })).unwrap();
    assert_eq!(got["text"], "one\n");
    let hash = got["hash"].as_str().unwrap().to_string();
    let saved = call(
        &h.main,
        "text_write",
        json!({ "path": "notes.txt", "text": "two\n", "expectedHash": hash }),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.path().join("notes.txt")).unwrap(),
        "two\n"
    );
    let err = call(
        &h.main,
        "text_write",
        json!({ "path": "notes.txt", "text": "lost\n", "expectedHash": hash }),
    )
    .unwrap_err();
    assert_eq!(err["kind"], "conflict");
    assert_eq!(err["currentText"], "two\n");
    assert_eq!(err["currentHash"], saved["hash"]);
    for path in ["data.json", "Page.md"] {
        let err = call(&h.main, "text_read", json!({ "path": path })).unwrap_err();
        assert_eq!(kind(err), "notAText", "{path}");
    }
    let err = call(&h.main, "text_read", json!({ "path": "missing.txt" })).unwrap_err();
    assert_eq!(kind(err), "notFound");
}

/// Final review I6: recovery keeps a text file's type. An unclean merge's
/// copy of `data.csv` is `data (conflict).csv`, and "Save as new" for a text
/// file deleted outside the app creates `notes.json` again, not a page.
#[test]
fn m4b2_text_files_keep_their_type_in_recovery_over_ipc() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir(vault.path().join("data")).unwrap();
    std::fs::write(vault.path().join("data/data.csv"), "a,b\n").unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let copy = call(
        &h.main,
        "page_create_conflict_copy",
        json!({ "path": "data/data.csv", "text": "theirs\n" }),
    )
    .unwrap();
    assert_eq!(copy, "data/data (conflict).csv");
    let got = call(
        &h.main,
        "text_read",
        json!({ "path": "data/data (conflict).csv" }),
    )
    .unwrap();
    assert_eq!(got["text"], "theirs\n");

    let made = call(
        &h.main,
        "entry_create_text",
        json!({ "dir": "data", "name": "notes.json" }),
    )
    .unwrap();
    assert_eq!(made, "data/notes.json");
    let got = call(&h.main, "text_read", json!({ "path": "data/notes.json" })).unwrap();
    assert_eq!(got["text"], "");
    call(
        &h.main,
        "text_write",
        json!({ "path": "data/notes.json", "text": "{}\n", "expectedHash": got["hash"] }),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.path().join("data/notes.json")).unwrap(),
        "{}\n"
    );
    let err = call(
        &h.main,
        "entry_create_text",
        json!({ "dir": "data", "name": "notes.json" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "alreadyExists");
    let err = call(
        &h.main,
        "entry_create_text",
        json!({ "dir": "", "name": "Page.md" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notAText");
}

/// Final review I3: a file rewritten outside as something the app can't edit
/// (Windows-1252 from Excel, a NUL byte, over 2 MB; a page that isn't UTF-8)
/// makes a stale write fail as `notAText` / `binary` — never a `conflict`
/// carrying lossy text the merge would write back over every accent.
#[test]
fn final_review_i3_a_conflict_with_a_non_text_file_carries_no_lossy_text() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("data.csv"), "José,Bogotá\n").unwrap();
    std::fs::write(vault.path().join("Page.md"), "# Café\n").unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let text_hash = call(&h.main, "text_read", json!({ "path": "data.csv" })).unwrap()["hash"]
        .as_str()
        .unwrap()
        .to_string();
    let page_hash = call(&h.main, "page_read", json!({ "path": "Page.md" })).unwrap()["hash"]
        .as_str()
        .unwrap()
        .to_string();
    let big = vec![b'a'; nimw_session::TEXT_MAX_BYTES + 1];
    let outside: [&[u8]; 3] = [b"Jos\xe9,Bogot\xe1\n", b"Jose\0,Bogota\n", &big];
    for bytes in outside {
        std::fs::write(vault.path().join("data.csv"), bytes).unwrap();
        let err = call(
            &h.main,
            "text_write",
            json!({ "path": "data.csv", "text": "José,Bogotá\nmine\n", "expectedHash": text_hash }),
        )
        .unwrap_err();
        assert_eq!(kind(err.clone()), "notAText", "{err}");
        assert!(err.get("currentText").is_none(), "{err}");
        assert_eq!(std::fs::read(vault.path().join("data.csv")).unwrap(), bytes);
    }
    std::fs::write(vault.path().join("Page.md"), b"# Caf\xe9\n").unwrap();
    let err = call(
        &h.main,
        "page_write",
        json!({ "path": "Page.md", "text": "# Café\nmine\n", "expectedHash": page_hash }),
    )
    .unwrap_err();
    assert_eq!(kind(err.clone()), "binary", "{err}");
    assert!(err.get("currentText").is_none(), "{err}");
    assert_eq!(
        std::fs::read(vault.path().join("Page.md")).unwrap(),
        b"# Caf\xe9\n"
    );
}

/// M4b part 3 §8: the link format over IPC — Obsidian's `newLinkFormat` is
/// reported, NIMW's own choice wins, `default` clears it, nonsense is refused;
/// a paste in the absolute format comes back with its `file:` URL.
#[test]
fn m4b3_link_format_over_ipc() {
    let h = harness();
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir(vault.path().join(".obsidian")).unwrap();
    std::fs::write(
        vault.path().join(".obsidian/app.json"),
        r#"{ "newLinkFormat": "relative" }"#,
    )
    .unwrap();
    std::fs::write(vault.path().join("a.md"), "# A\n").unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let got = call(&h.main, "vault_settings_get", json!({})).unwrap();
    assert_eq!(got["attachmentLinkFormat"], Value::Null);
    assert_eq!(got["obsidianLinkFormat"], "relative");
    let set = |value: &str| {
        call(
            &h.main,
            "vault_settings_set",
            json!({ "patch": { "attachmentLinkFormat": value } }),
        )
    };
    assert_eq!(set("absolute").unwrap()["attachmentLinkFormat"], "absolute");
    let pasted = get_ipc_response(
        &h.main,
        raw_request(
            "attachment_paste",
            b"\x89PNG".to_vec(),
            &[("x-nimw-page", "a.md"), ("x-nimw-name", "shot.png")],
        ),
    )
    .map(|r| r.deserialize::<Value>().unwrap())
    .unwrap();
    assert_eq!(pasted["link"], "shot.png");
    assert!(
        pasted["url"]
            .as_str()
            .is_some_and(|u| u.starts_with("file:///") && u.ends_with("/attachments/shot.png")),
        "{pasted}"
    );
    assert_eq!(set("default").unwrap()["attachmentLinkFormat"], Value::Null);
    assert_eq!(kind(set("sideways").unwrap_err()), "invalidName");
    assert_eq!(
        std::fs::read_to_string(vault.path().join(".obsidian/app.json")).unwrap(),
        r#"{ "newLinkFormat": "relative" }"#
    );
}

/// M4b part 3 §7: Rust opens the file dialog (a fake picker in tests); each
/// picked file comes back with its `file:` URL and, when it already lives in
/// the vault, its vault path. The picks are granted for one import each.
#[test]
fn m4b3_file_pick_returns_the_picks_and_grants_them_for_import() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let outside = tempfile::Builder::new()
        .prefix("nimw-pick")
        .tempdir()
        .unwrap();
    let pdf = outside.path().join("my brief.pdf");
    std::fs::write(&pdf, b"%PDF").unwrap();
    let inside = vault.path().join("Character Design/assets/rex-cover.png");
    let state = h.app.state::<nimw_desktop::state::AppState>();
    let picks = vec![pdf.clone(), inside.clone()];
    state.set_file_picker(Some(Arc::new(move || picks.clone())));
    let got = call(&h.main, "file_pick", json!({ "page": "Welcome.md" })).unwrap();
    let pdf_s = pdf.to_str().unwrap();
    assert_eq!(got[0]["path"], pdf_s);
    assert_eq!(got[0]["name"], "my brief.pdf");
    assert_eq!(got[0]["inVault"], Value::Null);
    assert!(
        got[0]["url"].as_str().unwrap().ends_with("/my%20brief.pdf"),
        "{got}"
    );
    assert_eq!(got[1]["inVault"], "Character Design/assets/rex-cover.png");
    let imported = call(
        &h.main,
        "attachment_import",
        json!({ "page": "Welcome.md", "paths": [pdf_s] }),
    )
    .unwrap();
    assert_eq!(imported[0]["ok"]["copied"], true, "{imported}");
    let again = call(
        &h.main,
        "attachment_import",
        json!({ "page": "Welcome.md", "paths": [pdf_s] }),
    )
    .unwrap();
    assert_eq!(again[0]["err"]["kind"], "notPermitted", "used once");
    // Cancelled: nothing picked.
    state.set_file_picker(Some(Arc::new(Vec::new)));
    assert_eq!(
        call(&h.main, "file_pick", json!({ "page": "Welcome.md" })).unwrap(),
        json!([])
    );
}

/// M4b part 3 §9 over IPC: `links_external` reports outside files; opening or
/// revealing one that no page links to, or a program, is refused (the
/// success paths would open apps on the machine running the tests).
#[test]
fn m4b3_outside_files_over_ipc() {
    let h = harness();
    let base = tempfile::Builder::new()
        .prefix("nimw-ext")
        .tempdir()
        .unwrap();
    let pics = dunce::canonicalize(base.path()).unwrap().join("Pics");
    std::fs::create_dir_all(&pics).unwrap();
    std::fs::write(pics.join("x.png"), b"\x89PNG").unwrap();
    std::fs::write(pics.join("run.sh"), b"#!/bin/sh\n").unwrap();
    std::fs::write(pics.join("other.pdf"), b"%PDF").unwrap();
    std::fs::write(pics.join("disk.iso"), b"iso").unwrap();
    let iso = pics.join("disk.iso").to_str().unwrap().to_string();
    let pic = pics.join("x.png").to_str().unwrap().to_string();
    let script = pics.join("run.sh").to_str().unwrap().to_string();
    let other = pics.join("other.pdf").to_str().unwrap().to_string();
    std::fs::create_dir_all(base.path().join("Vault")).unwrap();
    let unc = r"\\nas.example\share\x.png";
    std::fs::write(
        base.path().join("Vault/a.md"),
        format!("# A\n\n![[{pic}]] [[{script}]] [[b]] ![[{unc}]] [[{iso}]]\n"),
    )
    .unwrap();
    std::fs::write(base.path().join("Vault/b.md"), "# B\n").unwrap();
    call(
        &h.main,
        "vault_open",
        json!({ "path": base.path().join("Vault") }),
    )
    .unwrap();
    let got = call(
        &h.main,
        "links_external",
        json!({ "source": "a.md", "targets": [
            { "kind": "embed", "target": pic },
            { "kind": "wiki", "target": "b" },
            // As a `file:` URL: a bare `/…` is the vault root first (I1).
            { "kind": "embed", "target": if cfg!(windows) { other.clone() } else { format!("file://{other}") } },
            { "kind": "embed", "target": unc },
        ] }),
    )
    .unwrap();
    // An unlinked file isn't looked up; a network file waits for the user
    // (final review C1).
    assert_eq!(
        got,
        json!([
            { "path": pic, "exists": true, "listed": true, "network": false, "askFirst": false, "openable": true },
            null,
            { "path": other, "exists": false, "listed": false, "network": false, "askFirst": false, "openable": true },
            { "path": unc, "exists": false, "listed": true, "network": true, "askFirst": true, "openable": true },
        ])
    );
    for cmd in ["external_open", "external_reveal"] {
        let err = call(&h.main, cmd, json!({ "path": unc })).unwrap_err();
        assert_eq!(kind(err), "notPermitted", "{cmd}: not loaded yet");
    }
    let err = call(&h.main, "external_network_allow", json!({ "path": other })).unwrap_err();
    assert_eq!(
        kind(err),
        "notPermitted",
        "only a linked path can be loaded"
    );
    // Loaded: looked up from now on (nas.example is nowhere, so it's missing).
    let loaded = call(&h.main, "external_network_allow", json!({ "path": unc })).unwrap();
    assert_eq!(
        loaded,
        json!({ "path": unc, "exists": false, "listed": true, "network": true, "askFirst": false, "openable": true })
    );
    for cmd in ["external_open", "external_reveal"] {
        let err = call(&h.main, cmd, json!({ "path": other })).unwrap_err();
        assert_eq!(kind(err), "notPermitted", "{cmd}");
    }
    let err = call(&h.main, "external_open", json!({ "path": script })).unwrap_err();
    assert_eq!(kind(err), "invalidUrl", "a script is never opened");
    // Final review I2: a linked disk image is no document: shown, not opened.
    let err = call(&h.main, "external_open", json!({ "path": iso })).unwrap_err();
    assert_eq!(kind(err), "invalidUrl", "only documents and media open");
}

/// M5b §4: folder and vault icons over IPC; the tree, vault info and recent
/// vaults carry them, page icons come from frontmatter; text is refused.
#[test]
fn m5b_icons_over_ipc() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    std::fs::write(vault.path().join("Rocket.md"), "---\nicon: 🚀\n---\n# R\n").unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    call(
        &h.main,
        "folder_icon_set",
        json!({ "path": "Game Design", "icon": "🎮" }),
    )
    .unwrap();
    let tree = call(&h.main, "vault_tree", json!({})).unwrap();
    let icon = |path: &str| {
        tree.as_array()
            .unwrap()
            .iter()
            .find(|n| n["path"] == path)
            .map(|n| n["icon"].clone())
            .unwrap()
    };
    assert_eq!(icon("Game Design"), json!("🎮"));
    assert_eq!(icon("Rocket.md"), json!("🚀"));
    assert_eq!(icon("Welcome.md"), Value::Null);
    call(&h.main, "vault_icon_set", json!({ "icon": "🌌" })).unwrap();
    let info = call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    assert_eq!(info["icon"], "🌌");
    let recent = call(&h.main, "vaults_recent", json!({})).unwrap();
    assert_eq!(recent[0]["icon"], "🌌");
    for bad in ["x", "🚀🚀", ""] {
        let err = call(&h.main, "vault_icon_set", json!({ "icon": bad })).unwrap_err();
        assert_eq!(kind(err), "invalidName", "{bad:?}");
        let err = call(
            &h.main,
            "folder_icon_set",
            json!({ "path": "Game Design", "icon": bad }),
        )
        .unwrap_err();
        assert_eq!(kind(err), "invalidName", "{bad:?}");
    }
    for path in ["Welcome.md", "Missing", ".obsidian", "../x"] {
        assert!(
            call(
                &h.main,
                "folder_icon_set",
                json!({ "path": path, "icon": "🎮" })
            )
            .is_err(),
            "{path}"
        );
    }
    // Clearing.
    call(
        &h.main,
        "folder_icon_set",
        json!({ "path": "Game Design", "icon": null }),
    )
    .unwrap();
    call(&h.main, "vault_icon_set", json!({ "icon": null })).unwrap();
    let tree = call(&h.main, "vault_tree", json!({})).unwrap();
    assert!(
        tree.as_array()
            .unwrap()
            .iter()
            .all(|n| n["path"] != "Game Design" || n.get("icon").is_none())
    );
}

/// M5b round 2: a folder (or the root, `""`) lists its entries in its own
/// order; the default isn't stored; files and unknown orders are refused.
#[test]
fn m5b_r2_folder_sorts_over_ipc() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    let get = |path: &str| call(&h.main, "folder_sort_get", json!({ "path": path })).unwrap();
    assert_eq!(get(""), "name-asc");
    call(
        &h.main,
        "folder_sort_set",
        json!({ "path": "", "sort": "name-desc" }),
    )
    .unwrap();
    call(
        &h.main,
        "folder_sort_set",
        json!({ "path": "Game Design", "sort": "modified-desc" }),
    )
    .unwrap();
    assert_eq!(get(""), "name-desc");
    assert_eq!(get("Game Design"), "modified-desc");
    let tree = call(&h.main, "vault_tree", json!({})).unwrap();
    let roots: Vec<&str> = tree
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["path"].as_str().unwrap())
        .filter(|p| !p.contains('/'))
        .collect();
    let mut names = roots.clone();
    names.sort_by_key(|p| std::cmp::Reverse(p.to_lowercase()));
    names.sort_by_key(|p| !vault.path().join(p).is_dir());
    assert_eq!(roots, names);
    for (path, sort) in [
        ("Welcome.md", "name-asc"),
        ("Missing", "name-asc"),
        (".obsidian", "name-asc"),
        ("", "size"),
    ] {
        assert!(
            call(
                &h.main,
                "folder_sort_set",
                json!({ "path": path, "sort": sort })
            )
            .is_err(),
            "{path} {sort}"
        );
    }
    call(
        &h.main,
        "folder_sort_set",
        json!({ "path": "", "sort": "name-asc" }),
    )
    .unwrap();
    assert_eq!(get(""), "name-asc");
}

/// M5b round 2: archived pages are read-only. Every command that would
/// change one, or put something in the Archive, is refused; Unarchive and
/// Move to Trash still work.
#[test]
fn m5b_r2_the_archive_is_read_only() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    call(&h.main, "entry_archive", json!({ "path": "Welcome.md" })).unwrap();
    let a = ".archive/Welcome.md";
    let read = call(&h.main, "page_read", json!({ "path": a })).unwrap();
    let hash = read["hash"].clone();
    let refused: Vec<(&str, Value)> = vec![
        (
            "page_write",
            json!({ "path": a, "text": "x", "expectedHash": hash }),
        ),
        (
            "text_write",
            json!({ "path": a, "text": "x", "expectedHash": hash }),
        ),
        (
            "page_create_conflict_copy",
            json!({ "path": a, "text": "x" }),
        ),
        (
            "entry_rename",
            json!({ "from": a, "to": ".archive/Other.md" }),
        ),
        (
            "entry_rename",
            json!({ "from": "Game Design", "to": ".archive/Game Design" }),
        ),
        (
            "entry_create_page",
            json!({ "dir": ".archive", "name": "New" }),
        ),
        (
            "entry_create_folder",
            json!({ "parent": ".archive", "name": "New" }),
        ),
        (
            "entry_create_text",
            json!({ "dir": ".archive", "name": "n.txt" }),
        ),
        ("attachment_import", json!({ "page": a, "paths": [] })),
        ("cover_pick", json!({ "page": a })),
        ("page_width_set", json!({ "path": a, "width": "full" })),
        ("cover_height_set", json!({ "path": a, "height": 200.0 })),
        ("cover_side_set", json!({ "path": a, "side": "left" })),
        ("cover_width_set", json!({ "path": a, "width": 300.0 })),
    ];
    for (cmd, args) in refused {
        let err = call(&h.main, cmd, args.clone()).unwrap_err();
        assert_eq!(kind(err), "notPermitted", "{cmd} {args}");
    }
    assert!(vault.path().join(a).exists());
    // Sorting it is fine; Unarchive and Move to Trash still work.
    std::fs::create_dir_all(vault.path().join(".archive/Old")).unwrap();
    call(
        &h.main,
        "folder_sort_set",
        json!({ "path": ".archive/Old", "sort": "name-desc" }),
    )
    .unwrap();
    call(
        &h.main,
        "archive_restore",
        json!({ "path": a, "keepBoth": false }),
    )
    .unwrap();
    call(&h.main, "entry_archive", json!({ "path": "Welcome.md" })).unwrap();
    call(&h.main, "entry_trash", json!({ "path": a })).unwrap();
}

/// M5b §5: delete moves into the vault's Trash and comes back; archive moves
/// into `.archive/` and back; search leaves archived pages out unless asked.
/// (Never `trash_delete`/`trash_empty` here: they reach the OS trash.)
#[test]
fn m5b_trash_and_archive_over_ipc() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let inner = call(&h.main, "entry_trash", json!({ "path": "Welcome.md" })).unwrap();
    assert_eq!(inner, ".trash/Welcome.md");
    let bins = call(&h.main, "bin_list", json!({})).unwrap();
    assert_eq!(bins["trash"][0]["path"], ".trash/Welcome.md");
    assert_eq!(bins["trash"][0]["from"], "Welcome.md");
    assert!(bins["trash"][0]["at"].is_u64());
    assert_eq!(bins["trash"][0]["folder"], false);
    // M5b round 2: its size, for the Trash view.
    assert!(bins["trash"][0]["size"].as_u64().unwrap() > 0);
    let back = call(
        &h.main,
        "trash_restore",
        json!({ "path": ".trash/Welcome.md", "keepBoth": false }),
    )
    .unwrap();
    assert_eq!(back, "Welcome.md");
    assert!(vault.path().join("Welcome.md").exists());

    let out = call(&h.main, "entry_archive", json!({ "path": "Welcome.md" })).unwrap();
    assert_eq!(out["moved"][0][1], ".archive/Welcome.md");
    let bins = call(&h.main, "bin_list", json!({})).unwrap();
    assert_eq!(bins["archive"][0]["path"], ".archive/Welcome.md");
    // M5b round 2: the tree carries the Archive too, for its own read-only
    // folder in the sidebar; the UI keeps it out of the vault's tree.
    let tree = call(&h.main, "vault_tree", json!({})).unwrap();
    assert!(
        tree.as_array()
            .unwrap()
            .iter()
            .any(|n| n["path"] == ".archive/Welcome.md")
    );
    let page = call(
        &h.main,
        "page_get",
        json!({ "path": ".archive/Welcome.md" }),
    );
    assert!(page.is_ok(), "an archived page still opens: {page:?}");
    let hidden = call(&h.main, "search", json!({ "query": { "text": "welcome" } })).unwrap();
    assert!(hidden["facets"]["archived"].as_u64().unwrap() >= 1);
    let shown = call(
        &h.main,
        "search",
        json!({ "query": { "text": "welcome", "archived": true } }),
    )
    .unwrap();
    assert!(
        shown["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["path"] == ".archive/Welcome.md")
    );
    let out = call(
        &h.main,
        "archive_restore",
        json!({ "path": ".archive/Welcome.md", "keepBoth": false }),
    )
    .unwrap();
    assert_eq!(out["moved"][0][1], "Welcome.md");
    // Refused: the bins themselves.
    assert!(call(&h.main, "entry_trash", json!({ "path": ".nimw" })).is_err());
}

/// M5b §19: Favorites are one ordered list; escaping or hidden paths are
/// refused, missing ones and repeats dropped, and the list follows renames.
#[test]
fn m5b_favorites_over_ipc() {
    let h = harness();
    let vault = copy_fixture("obsidian-basic");
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    assert_eq!(
        call(&h.main, "favorites_get", json!({})).unwrap(),
        json!([])
    );
    let stored = call(
        &h.main,
        "favorites_set",
        json!({ "paths": ["Welcome.md", "Game Design", "Missing.md", "Welcome.md"] }),
    )
    .unwrap();
    assert_eq!(stored, json!(["Welcome.md", "Game Design"]));
    for bad in [
        "../x.md",
        ".obsidian/app.json",
        ".nimw/vault.json",
        ".trash/.x",
        "/abs.md",
    ] {
        assert!(
            call(&h.main, "favorites_set", json!({ "paths": [bad] })).is_err(),
            "{bad}"
        );
    }
    call(
        &h.main,
        "entry_rename",
        json!({ "from": "Game Design", "to": "Design" }),
    )
    .unwrap();
    assert_eq!(
        call(&h.main, "favorites_get", json!({})).unwrap(),
        json!(["Welcome.md", "Design"])
    );
}

/// Round-2 review M3: the Archive's write guard ignores letter case — on a
/// case-insensitive disk `.ARCHIVE/x.md` is the archived file.
#[test]
fn m5b_r2_review_m3_the_archive_guard_ignores_case() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    call(&h.main, "entry_archive", json!({ "path": "Welcome.md" })).unwrap();
    for path in [".ARCHIVE/Welcome.md", ".Archive/x.md"] {
        let err = call(
            &h.main,
            "page_write",
            json!({ "path": path, "text": "x", "expectedHash": "0" }),
        )
        .unwrap_err();
        assert_eq!(kind(err.clone()), "notPermitted", "{path}: {err}");
    }
}

/// Round-2 review M9: a favourite that can't be checked (no permission)
/// counts as missing; it doesn't fail the whole list.
#[cfg(unix)]
#[test]
fn m5b_r2_review_m9_an_unreadable_favorite_is_dropped_not_fatal() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let locked = vault.path().join("Locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("x.md"), "x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let out = call(
        &h.main,
        "favorites_set",
        json!({ "paths": ["Welcome.md", "Locked/x.md"] }),
    );
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(out.unwrap(), json!(["Welcome.md"]));
}

/// M6 §3: the synthetic microphone (tests never open a real one) records a
/// take into the cache; Stop imports it as the page's attachment.
#[test]
fn m6_a_take_becomes_an_attachment_of_its_page() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let devices = call(&h.main, "audio_devices", json!({})).unwrap();
    assert_eq!(devices[0]["isDefault"], true);
    let levels = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = levels.clone();
    h.app.listen_any("audio:level", move |e| {
        seen.lock()
            .unwrap()
            .push(serde_json::from_str(e.payload()).unwrap());
    });
    let started = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101500" }),
    )
    .unwrap();
    // One take at a time, app-wide.
    let busy = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101501" }),
    )
    .unwrap_err();
    assert_eq!(kind(busy), "alreadyExists");
    std::thread::sleep(std::time::Duration::from_millis(250));
    let id = started["recordingId"].clone();
    let clip = call(&h.main, "audio_record_stop", json!({ "recordingId": id })).unwrap();
    let path = clip["path"].as_str().unwrap();
    assert!(path.ends_with("clip-20261018-101500.wav"), "{clip}");
    assert!(
        clip["link"]
            .as_str()
            .unwrap()
            .ends_with("clip-20261018-101500.wav")
    );
    let on_disk = vault.path().join(path);
    let wav = std::fs::read(&on_disk).unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    assert!(
        wav.len() > 44 + 48_000 * 2 / 10,
        "about 0.25 s of 16-bit mono"
    );
    let levels = levels.lock().unwrap();
    assert!(!levels.is_empty());
    assert_eq!(levels[0]["recordingId"], id);
    assert!(levels[0]["peak"].as_f64().unwrap() > 0.1);
    // Stopping again: that take is over.
    let again = call(&h.main, "audio_record_stop", json!({ "recordingId": id })).unwrap_err();
    assert_eq!(kind(again), "notFound");
}

/// 16-bit mono 48 kHz WAV bytes whose header still says "no sound", as a
/// take cut short by a killed app leaves it (batch 6 review C1).
fn unfinished_wav(samples: usize) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&36u32.to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&48_000u32.to_le_bytes());
    b.extend_from_slice(&96_000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend(std::iter::repeat_n(0x11u8, samples * 2));
    b
}

/// The samples a WAV's header claims (RIFF data chunk size / 2).
fn wav_samples(bytes: &[u8]) -> usize {
    let at = bytes.windows(4).position(|w| w == b"data").unwrap();
    u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize / 2
}

/// Batch 6 review C1: a take a killed app left in the cache is recovered —
/// imported next to the page it was recorded on, its header repaired — when
/// the next take starts. Never wiped.
#[test]
fn b6_review_c1_a_take_left_by_a_killed_app_is_recovered() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let cache = h
        .app
        .state::<nimw_desktop::state::AppState>()
        .cache_dir
        .join("audio")
        .join("clip-20261018-090000-1");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(
        cache.join("clip-20261018-090000.wav"),
        unfinished_wav(4_800),
    )
    .unwrap();
    std::fs::write(
        cache.join("take.json"),
        json!({ "root": vault.path(), "page": "Game Design/Game 1.md" }).to_string(),
    )
    .unwrap();
    let started = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101500" }),
    )
    .unwrap();
    let recovered = started["recovered"].as_array().cloned().unwrap_or_default();
    assert_eq!(recovered.len(), 1, "{started}");
    let path = recovered[0]["path"].as_str().unwrap();
    assert_eq!(
        path,
        "Game Design/assets/clip-20261018-090000-recovered.wav"
    );
    let wav = std::fs::read(vault.path().join(path)).unwrap();
    assert_eq!(
        wav_samples(&wav),
        4_800,
        "the header counts the sound again"
    );
    assert!(!cache.exists(), "a recovered take leaves the cache");
    call(
        &h.main,
        "audio_record_cancel",
        json!({ "recordingId": started["recordingId"] }),
    )
    .unwrap();
}

/// Batch 6 review I1: a Stop whose import fails keeps the take (the next
/// Start recovers it); it is never deleted.
#[test]
#[cfg(unix)]
fn b6_review_i1_a_failed_import_keeps_the_take() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let started = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101500" }),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let root = vault.path();
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o555)).unwrap();
    let err = call(
        &h.main,
        "audio_record_stop",
        json!({ "recordingId": started["recordingId"], "page": "Welcome.md" }),
    )
    .unwrap_err();
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        err["message"].as_str().unwrap().contains("kept"),
        "the error says the clip is kept: {err}"
    );
    let again = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101600" }),
    )
    .unwrap();
    let recovered = again["recovered"].as_array().cloned().unwrap_or_default();
    assert_eq!(recovered.len(), 1, "{again}");
    let path = recovered[0]["path"].as_str().unwrap();
    assert_eq!(path, "assets/clip-20261018-101500-recovered.wav");
    assert!(wav_samples(&std::fs::read(root.join(path)).unwrap()) > 0);
    call(
        &h.main,
        "audio_record_cancel",
        json!({ "recordingId": again["recordingId"] }),
    )
    .unwrap();
}

/// Batch 6 review I2: Stop imports next to where the page is now, not
/// where it was when the take started.
#[test]
fn b6_review_i2_stop_imports_next_to_the_page_where_it_is_now() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    let started = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101500" }),
    )
    .unwrap();
    call(
        &h.main,
        "entry_rename",
        json!({ "from": "Welcome.md", "to": "Game Design/Welcome.md" }),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(150));
    let clip = call(
        &h.main,
        "audio_record_stop",
        json!({ "recordingId": started["recordingId"], "page": "Game Design/Welcome.md" }),
    )
    .unwrap();
    assert_eq!(
        clip["path"].as_str().unwrap(),
        "Game Design/assets/clip-20261018-101500.wav"
    );
}

/// Batch 6 review I4: a take whose page went away (the window reloaded or
/// closed) is stopped and kept — the microphone is released.
#[test]
fn b6_review_i4_an_orphaned_take_is_stopped_and_kept() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101500" }),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(150));
    nimw_desktop::audio_commands::stop_orphaned(h.app.handle());
    assert!(
        vault
            .path()
            .join("assets/clip-20261018-101500.wav")
            .is_file()
    );
    // The microphone is free again.
    let next = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101600" }),
    )
    .unwrap();
    call(
        &h.main,
        "audio_record_cancel",
        json!({ "recordingId": next["recordingId"] }),
    )
    .unwrap();
}

/// M6 §3: Cancel leaves nothing in the vault; bad input is refused.
#[test]
fn m6_cancel_writes_nothing_and_bad_takes_are_refused() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    let before = nimw_testkit_files(vault.path());
    let started = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Welcome.md", "device": null, "name": "clip-20261018-101500" }),
    )
    .unwrap();
    call(
        &h.main,
        "audio_record_cancel",
        json!({ "recordingId": started["recordingId"] }),
    )
    .unwrap();
    assert_eq!(nimw_testkit_files(vault.path()), before);
    for (body, expected) in [
        (
            json!({ "page": "Welcome.md", "device": null, "name": "../x" }),
            "invalidName",
        ),
        (
            json!({ "page": "Welcome.md", "device": null, "name": "clip-1.wav" }),
            "invalidName",
        ),
        (
            json!({ "page": "Nope.md", "device": null, "name": "clip-20261018-101500" }),
            "notFound",
        ),
        (
            json!({ "page": "Welcome.md", "device": "no-such-mic", "name": "clip-20261018-101500" }),
            "notFound",
        ),
    ] {
        let err = call(&h.main, "audio_record_start", body.clone()).unwrap_err();
        assert_eq!(kind(err), expected, "{body}");
    }
    // Archived pages are read-only (M5b round 2).
    call(&h.main, "entry_archive", json!({ "path": "Welcome.md" })).unwrap();
    let err = call(
        &h.main,
        "audio_record_start",
        json!({ "page": ".archive/Welcome.md", "device": null, "name": "clip-20261018-101500" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}

/// M6 §1.3: Upload clip — Rust picks the file (a fake picker in tests).
#[test]
fn m6_audio_pick_imports_the_picked_clip() {
    let h = harness();
    let _vault = open_fixture(&h, "obsidian-basic");
    let outside = tempfile::tempdir().unwrap();
    let clip = outside.path().join("voice memo.m4a");
    std::fs::write(&clip, b"....ftypM4A ").unwrap();
    let state = h.app.state::<nimw_desktop::state::AppState>();
    let picked = clip.clone();
    state.set_cover_picker(Some(Arc::new(move || Some(picked.clone()))));
    let attached = call(&h.main, "audio_pick", json!({ "page": "Welcome.md" })).unwrap();
    assert!(
        attached["path"]
            .as_str()
            .unwrap()
            .ends_with("voice memo.m4a"),
        "{attached}"
    );
    state.set_cover_picker(Some(Arc::new(|| None)));
    assert_eq!(
        call(&h.main, "audio_pick", json!({ "page": "Welcome.md" })).unwrap(),
        Value::Null
    );
}

/// Every file under `root`, relative, sorted.
fn nimw_testkit_files(root: &std::path::Path) -> Vec<String> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else {
                out.push(p.strip_prefix(root).unwrap().to_string_lossy().into_owned());
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.retain(|p| !p.starts_with(".nimw"));
    out.sort();
    out
}

fn check(h: &Harness, words: &[&str], lang: &str) -> Vec<bool> {
    serde_json::from_value(
        call(
            &h.main,
            "spell_check",
            json!({ "words": words, "lang": lang }),
        )
        .unwrap(),
    )
    .unwrap()
}

/// Spelling: the language's default dictionary until one is chosen; a
/// vault's own choice wins while it's open.
#[test]
fn spell_checks_with_the_language_default_then_settings_then_the_vault_override() {
    let h = harness();
    assert_eq!(check(&h, &["canción", "receive"], "es"), [true, false]);
    assert_eq!(check(&h, &["canción", "receive"], "en"), [false, true]);
    call(
        &h.main,
        "settings_set",
        json!({ "patch": { "spellDictionaries": ["es_CO", "en_US"] } }),
    )
    .unwrap();
    assert_eq!(check(&h, &["parcero", "receive"], "es"), [true, true]);
    let _vault = open_fixture(&h, "obsidian-basic");
    call(&h.main, "spell_vault_set", json!({ "ids": ["en_US"] })).unwrap();
    assert_eq!(
        call(&h.main, "spell_vault_get", json!({})).unwrap(),
        json!(["en_US"])
    );
    assert_eq!(check(&h, &["parcero", "receive"], "es"), [false, true]);
    call(&h.main, "spell_vault_set", json!({ "ids": null })).unwrap();
    assert_eq!(check(&h, &["parcero", "receive"], "es"), [true, true]);
    let err = call(&h.main, "spell_vault_set", json!({ "ids": ["xx"] })).unwrap_err();
    assert_eq!(kind(err), "invalidInput");
    // es_CO then en_US: the English suggestion is among them.
    let suggested = call(
        &h.main,
        "spell_suggest",
        json!({ "word": "recieve", "lang": "en" }),
    )
    .unwrap();
    assert!(
        suggested.as_array().unwrap().contains(&json!("receive")),
        "{suggested}"
    );
}

#[test]
fn spell_add_word_and_ignore() {
    let h = harness();
    let vault = open_fixture(&h, "obsidian-basic");
    assert_eq!(check(&h, &["Ioque"], "es"), [false]);
    call(&h.main, "spell_add_word", json!({ "word": "Ioque" })).unwrap();
    assert_eq!(check(&h, &["Ioque"], "es"), [true]);
    assert_eq!(
        call(&h.main, "spell_words", json!({})).unwrap(),
        json!(["Ioque"])
    );
    let json: Value =
        serde_json::from_slice(&std::fs::read(vault.path().join(".nimw/vault.json")).unwrap())
            .unwrap();
    assert_eq!(json["spellingWords"], json!(["Ioque"]));
    call(&h.main, "spell_ignore", json!({ "word": "Wayuunaiki" })).unwrap();
    assert_eq!(check(&h, &["Wayuunaiki"], "es"), [true]);
    call(&h.main, "vault_close", json!({})).unwrap();
    call(&h.main, "vault_open", json!({ "path": vault.path() })).unwrap();
    assert_eq!(check(&h, &["Wayuunaiki", "Ioque"], "es"), [false, true]);
    call(&h.main, "spell_remove_word", json!({ "word": "Ioque" })).unwrap();
    assert_eq!(check(&h, &["Ioque"], "es"), [false]);
    for bad in ["two words", "", "tab\there"] {
        let err = call(&h.main, "spell_add_word", json!({ "word": bad })).unwrap_err();
        assert_eq!(kind(err), "invalidInput", "{bad:?}");
    }
    let err = call(
        &h.main,
        "spell_add_word",
        json!({ "word": "a".repeat(101) }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "invalidInput");
}

#[test]
fn spell_import_validates_copies_and_removes() {
    let h = harness();
    let state = h.app.state::<nimw_desktop::state::AppState>();
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../crates/nimw-spell/dictionaries/en_US");
    let outside = tempfile::tempdir().unwrap();
    let aff = outside.path().join("Mine.aff");
    std::fs::copy(src.join("index.aff"), &aff).unwrap();
    std::fs::copy(src.join("index.dic"), outside.path().join("Mine.dic")).unwrap();
    let picked = aff.clone();
    state.set_cover_picker(Some(Arc::new(move || Some(picked.clone()))));
    let added = call(&h.main, "spell_import", json!({})).unwrap();
    assert_eq!(
        added,
        json!({ "id": "user:mine", "name": "Mine", "bundled": false, "available": true })
    );
    let folder = h._config.path().join("dictionaries/user-mine");
    assert!(folder.join("index.aff").is_file() && folder.join("index.dic").is_file());
    // A second import of the same name gets its own id.
    assert_eq!(
        call(&h.main, "spell_import", json!({})).unwrap()["id"],
        "user:mine-2"
    );
    let list = call(&h.main, "spell_dictionaries", json!({})).unwrap();
    let ids: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["en_US", "es", "es_CO", "user:mine", "user:mine-2"]);
    call(
        &h.main,
        "settings_set",
        json!({ "patch": { "spellDictionaries": ["user:mine"] } }),
    )
    .unwrap();
    assert_eq!(check(&h, &["receive"], "es"), [true]);
    call(&h.main, "spell_remove", json!({ "id": "user:mine" })).unwrap();
    assert!(!folder.exists());
    let settings = call(&h.main, "settings_get", json!({})).unwrap();
    assert_eq!(settings["settings"]["spellDictionaries"], json!([]));
    assert_eq!(
        settings["settings"]["importedDictionaries"],
        json!([{ "id": "user:mine-2", "name": "Mine" }])
    );
    let err = call(&h.main, "spell_remove", json!({ "id": "es" })).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    // A broken import's files deleted by hand: listed, but unavailable.
    std::fs::remove_dir_all(h._config.path().join("dictionaries/user-mine-2")).unwrap();
    let list = call(&h.main, "spell_dictionaries", json!({})).unwrap();
    assert_eq!(list[3]["available"], false);
    // An .aff without its .dic.
    std::fs::remove_file(outside.path().join("Mine.dic")).unwrap();
    let err = call(&h.main, "spell_import", json!({})).unwrap_err();
    assert_eq!(kind(err), "notFound");
    state.set_cover_picker(Some(Arc::new(|| None)));
    assert_eq!(
        call(&h.main, "spell_import", json!({})).unwrap(),
        Value::Null
    );
}

#[test]
fn settings_default_and_patch_spelling_fields() {
    let h = harness();
    let s = call(&h.main, "settings_get", json!({})).unwrap();
    assert_eq!(s["settings"]["spellcheck"], true);
    assert_eq!(s["settings"]["spellDictionaries"], Value::Null);
    assert_eq!(s["settings"]["importedDictionaries"], json!([]));
    let s = call(
        &h.main,
        "settings_set",
        json!({ "patch": { "spellcheck": false, "spellDictionaries": ["es_CO", "en_US"] } }),
    )
    .unwrap();
    assert_eq!(s["spellcheck"], false);
    assert_eq!(s["spellDictionaries"], json!(["es_CO", "en_US"]));
}

/// Round 3b final review #12: a check reads `.nimw/vault.json` only when it
/// changed, and a dictionary that failed to parse isn't re-read until its
/// files change. Round 3b final review #2: no dictionary → nothing flagged.
#[test]
fn spell_review_caches_vault_settings_and_failed_dictionaries() {
    let h = harness();
    let state = h.app.state::<nimw_desktop::state::AppState>();
    let spell = h.app.state::<nimw_desktop::spell_commands::SpellState>();
    let vault = open_fixture(&h, "obsidian-basic");
    // A registered import whose files don't parse.
    let dir = h._config.path().join("dictionaries/user-broken");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.aff"), "not an aff").unwrap();
    std::fs::write(dir.join("index.dic"), "x").unwrap();
    state
        .settings
        .modify(|s| {
            s.imported_dictionaries
                .push(nimw_desktop::settings::ImportedDictionary {
                    id: "user:broken".into(),
                    name: "Broken".into(),
                });
            s.spell_dictionaries = Some(vec!["user:broken".into()]);
        })
        .unwrap();
    // Nothing usable is active: nothing is flagged.
    assert_eq!(check(&h, &["the", "zzqx"], "en"), [true, true]);
    let after_first = spell.counters();
    assert_eq!(check(&h, &["the", "zzqx"], "en"), [true, true]);
    assert_eq!(
        spell.counters(),
        after_first,
        "nothing re-read on the second check"
    );
    // An outside edit to vault.json is seen.
    let json = vault.path().join(".nimw/vault.json");
    std::fs::create_dir_all(json.parent().unwrap()).unwrap();
    std::fs::write(&json, r#"{"spellingWords":["Ioque"]}"#).unwrap();
    call(
        &h.main,
        "settings_set",
        json!({ "patch": { "spellDictionaries": ["en_US"] } }),
    )
    .unwrap();
    assert_eq!(check(&h, &["Ioque", "zzqx"], "en"), [true, false]);
}
