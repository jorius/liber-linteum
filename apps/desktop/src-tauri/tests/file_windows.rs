//! M4c §3–§4: single-file windows through the real IPC path (real
//! `generate_context!()` with the capability files, real command
//! registration, mock runtime, temp config/cache dirs).

use nimw_desktop::AppDirs;
use nimw_desktop::file_windows::{FileWindows, open_file_window};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::test::MockRuntime;
use tauri::{
    App, Listener, Manager, WebviewWindow, WebviewWindowBuilder,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

/// Every command a single-file window has (spec §4), besides the settings,
/// fonts, `url_open` and `app_info` it shares with the main window.
const FILE_COMMANDS: &[&str] = &[
    "file_info",
    "file_read",
    "file_write",
    "file_conflict_copy",
    "file_recreate",
    "file_rename",
    "file_links_resolve",
    "file_note_read",
    "file_follow",
    "file_open_in_vault",
    "file_open_dialog",
];

/// Commands both kinds of window have.
const SHARED: &[&str] = &[
    "app_info",
    "settings_get",
    "settings_set",
    "fonts_list",
    "url_open",
    "file_open_dialog",
];

/// The main window's commands (as `build.rs` lists them).
const VAULT_COMMANDS: &[&str] = &[
    "vault_open",
    // M4c §2: quick notes are taken in the main window only.
    "scratchpad_default",
    "scratchpad_choose",
    "scratchpad_set",
    "scratchpad_open",
    "quick_note_create",
    "quick_note_autoname",
    "quick_notes_state",
    "scratch_folder_set",
    // M5: search is the main window's.
    "search",
    // M5b §11.8: the main window's title; file windows keep their own.
    "window_title_set",
    "vault_create",
    "vault_close",
    "vault_tree",
    "page_get",
    "backlink_count",
    "entry_create_page",
    "entry_create_folder",
    "entry_rename",
    "entry_trash",
    "vaults_recent",
    "vaults_forget",
    "page_read",
    "page_write",
    "page_create_conflict_copy",
    "links_resolve",
    "file_open_external",
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
    "folder_icon_set",
    "vault_icon_set",
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

/// Opens `path` in a file window as the OS would (Finder, ⌘⇧O, a command line).
fn open(h: &Harness, path: &Path) -> WebviewWindow<MockRuntime> {
    let label = open_file_window(h.app.handle(), path).expect("file window opens");
    h.app.get_webview_window(&label).expect("the window exists")
}

/// A folder holding `note.md` (and whatever `files` adds).
fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("note.md"), "# Note\n\nHello\n").unwrap();
    for (name, text) in files {
        let path = dir.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    dir
}

#[test]
fn a_file_opens_in_one_window_of_its_own() {
    let h = harness();
    let dir = folder(&[]);
    let w = open(&h, &dir.path().join("note.md"));
    assert_eq!(w.label(), "file-1");
    // Opened again (Finder twice, another spelling of the path): the same window.
    let again = open_file_window(h.app.handle(), &dir.path().join("./note.md")).unwrap();
    assert_eq!(again, "file-1");
    let labels: Vec<String> = h.app.webview_windows().into_keys().collect();
    assert_eq!(labels.iter().filter(|l| l.starts_with("file-")).count(), 1);
    // Images, folders and missing files never get a window.
    std::fs::write(dir.path().join("a.png"), [0u8; 8]).unwrap();
    assert!(open_file_window(h.app.handle(), &dir.path().join("a.png")).is_err());
    assert!(open_file_window(h.app.handle(), dir.path()).is_err());
    assert_eq!(h.app.webview_windows().len(), 2);
    // The grant goes with its window (`WindowEvent::Destroyed`, which the
    // mock runtime never sends: checked in the real window).
}

#[test]
fn the_window_reads_and_writes_its_file_with_compare_and_swap() {
    let h = harness();
    let dir = folder(&[]);
    let w = open(&h, &dir.path().join("note.md"));
    let read = call(&w, "file_read", json!({})).unwrap();
    assert_eq!(read["text"], "# Note\n\nHello\n");
    let hash = read["hash"].as_str().unwrap().to_string();
    let written = call(
        &w,
        "file_write",
        json!({ "text": "# Note\n\nHello there\n", "expectedHash": hash }),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("note.md")).unwrap(),
        "# Note\n\nHello there\n"
    );
    // Changed outside since: a conflict carrying what is on disk now.
    std::fs::write(dir.path().join("note.md"), "outside\n").unwrap();
    let err = call(
        &w,
        "file_write",
        json!({ "text": "mine\n", "expectedHash": written["hash"] }),
    )
    .unwrap_err();
    assert_eq!(kind(err.clone()), "conflict");
    assert_eq!(err["currentText"], "outside\n");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("note.md")).unwrap(),
        "outside\n"
    );
}

#[test]
fn a_text_file_takes_only_text() {
    let h = harness();
    let dir = folder(&[("log.txt", "one\n")]);
    let w = open(&h, &dir.path().join("log.txt"));
    let hash = call(&w, "file_read", json!({})).unwrap()["hash"].clone();
    let err = call(
        &w,
        "file_write",
        json!({ "text": "a\u{0}b", "expectedHash": hash }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notAText");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("log.txt")).unwrap(),
        "one\n"
    );
    // Rewritten outside as something that isn't text: never read as text.
    std::fs::write(dir.path().join("log.txt"), [0xffu8, 0, 1]).unwrap();
    assert_eq!(
        kind(call(&w, "file_read", json!({})).unwrap_err()),
        "notAText"
    );
}

#[test]
fn file_info_says_what_the_window_shows_and_which_vault_holds_it() {
    let h = harness();
    let vault = folder(&[("Sub/inner.md", "# Inner\n")]);
    call(
        &h.main,
        "vault_open",
        json!({ "path": vault.path().to_str().unwrap() }),
    )
    .unwrap();
    let w = open(&h, &vault.path().join("Sub/inner.md"));
    let info = call(&w, "file_info", json!({})).unwrap();
    assert_eq!(info["name"], "inner.md");
    assert_eq!(info["kind"], "page");
    let root = dunce::canonicalize(vault.path()).unwrap();
    assert_eq!(info["folder"], root.join("Sub").to_str().unwrap());
    assert_eq!(info["vault"]["root"], root.to_str().unwrap());
    assert_eq!(info["vault"]["page"], "Sub/inner.md");

    let elsewhere = folder(&[("t.txt", "x")]);
    let w2 = open(&h, &elsewhere.path().join("t.txt"));
    let info = call(&w2, "file_info", json!({})).unwrap();
    assert_eq!(info["kind"], "text");
    assert!(info["vault"].is_null());
}

#[test]
fn renaming_keeps_the_folder_and_the_extension() {
    let h = harness();
    let dir = folder(&[("taken.md", "")]);
    let w = open(&h, &dir.path().join("note.md"));
    for bad in [
        "",
        "a/b.md",
        "../up.md",
        ".hidden.md",
        "x.txt",
        "q?.md",
        "taken.md",
    ] {
        let err = call(&w, "file_rename", json!({ "newName": bad })).unwrap_err();
        assert!(
            ["invalidName", "alreadyExists"].contains(&kind(err.clone()).as_str()),
            "{bad}: {err}"
        );
    }
    assert!(dir.path().join("note.md").exists());
    let renamed = call(&w, "file_rename", json!({ "newName": "Better.md" })).unwrap();
    assert_eq!(renamed, "Better.md");
    assert!(dir.path().join("Better.md").exists());
    assert!(!dir.path().join("note.md").exists());
    // The window keeps its file under the new name.
    assert_eq!(
        call(&w, "file_read", json!({})).unwrap()["text"],
        "# Note\n\nHello\n"
    );
    assert_eq!(
        call(&w, "file_info", json!({})).unwrap()["name"],
        "Better.md"
    );
}

#[test]
fn the_window_reads_other_notes_in_its_folder_and_nothing_else() {
    let h = harness();
    let outer = folder(&[("secret.md", "s"), ("in/x.md", "")]);
    let dir = outer.path().join("in");
    std::fs::write(dir.join("note.md"), "n").unwrap();
    std::fs::write(dir.join("Other.md"), "# Other\n").unwrap();
    std::fs::create_dir_all(dir.join("deep")).unwrap();
    std::fs::write(dir.join("deep/code.rs"), "fn main() {}\n").unwrap();
    std::fs::write(dir.join(".hidden.md"), "h").unwrap();
    std::fs::write(dir.join("pic.png"), [0u8; 4]).unwrap();
    let w = open(&h, &dir.join("note.md"));
    let other = call(&w, "file_note_read", json!({ "path": "Other.md" })).unwrap();
    assert_eq!(other["text"], "# Other\n");
    assert_eq!(
        call(&w, "file_note_read", json!({ "path": "deep/code.rs" })).unwrap()["text"],
        "fn main() {}\n"
    );
    for path in [
        "../secret.md",
        "/etc/hosts",
        ".hidden.md",
        "pic.png",
        outer.path().join("secret.md").to_str().unwrap(),
    ] {
        assert!(
            call(&w, "file_note_read", json!({ "path": path })).is_err(),
            "{path}"
        );
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outer.path().join("secret.md"), dir.join("link.md")).unwrap();
        assert!(call(&w, "file_note_read", json!({ "path": "link.md" })).is_err());
    }
}

#[test]
fn links_resolve_inside_the_folder_three_levels_down() {
    let h = harness();
    let dir = folder(&[
        ("a/b/c/Deep.md", ""),
        ("a/b/c/d/Deeper.md", ""),
        ("img/pic.png", ""),
        ("Sibling.md", ""),
    ]);
    let w = open(&h, &dir.path().join("note.md"));
    let got = call(
        &w,
        "file_links_resolve",
        json!({ "targets": [
            { "kind": "wiki", "target": "Deep" },
            { "kind": "wiki", "target": "Deeper" },
            { "kind": "wiki", "target": "Sibling" },
            { "kind": "markdown_image", "target": "img/pic.png" },
            { "kind": "markdown", "target": "../note.md" },
            { "kind": "embed", "target": "Nowhere" },
        ] }),
    )
    .unwrap();
    assert_eq!(
        got,
        json!([
            "a/b/c/Deep.md",
            null,
            "Sibling.md",
            "img/pic.png",
            null,
            null
        ])
    );
}

#[test]
fn conflict_copies_and_recreating_never_overwrite() {
    let h = harness();
    let dir = folder(&[("note (conflict).md", "older copy")]);
    let w = open(&h, &dir.path().join("note.md"));
    let copy = call(&w, "file_conflict_copy", json!({ "text": "theirs" })).unwrap();
    assert_eq!(copy, "note (conflict 2).md");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("note (conflict 2).md")).unwrap(),
        "theirs"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("note (conflict).md")).unwrap(),
        "older copy"
    );
    // "Save again" after the file was deleted outside: only while it is gone.
    assert_eq!(
        kind(call(&w, "file_recreate", json!({})).unwrap_err()),
        "alreadyExists"
    );
    std::fs::remove_file(dir.path().join("note.md")).unwrap();
    assert_eq!(call(&w, "file_recreate", json!({})).unwrap(), "note.md");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("note.md")).unwrap(),
        ""
    );
}

#[test]
fn following_a_link_opens_notes_in_their_own_window() {
    let h = harness();
    let dir = folder(&[("Other.md", "# o"), ("run.sh", "echo"), ("data.bin", "x")]);
    let w = open(&h, &dir.path().join("note.md"));
    assert_eq!(
        call(&w, "file_follow", json!({ "path": "Other.md" })).unwrap(),
        "window"
    );
    assert!(h.app.get_webview_window("file-2").is_some());
    // Outside the folder, hidden, missing, or neither a note nor a document.
    for path in ["../x.md", ".h.md", "missing.md", "data.bin"] {
        assert!(
            call(&w, "file_follow", json!({ "path": path })).is_err(),
            "{path}"
        );
    }
}

#[test]
fn open_in_vault_hands_the_page_to_the_main_window() {
    let h = harness();
    let vault = folder(&[]);
    call(
        &h.main,
        "vault_open",
        json!({ "path": vault.path().to_str().unwrap() }),
    )
    .unwrap();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = seen.clone();
    h.main.listen("file:open-in-vault", move |e| {
        sink.lock().unwrap().push(e.payload().to_string())
    });
    let w = open(&h, &vault.path().join("note.md"));
    call(&w, "file_open_in_vault", json!({})).unwrap();
    let root = dunce::canonicalize(vault.path()).unwrap();
    let payload: Value = serde_json::from_str(&seen.lock().unwrap()[0]).unwrap();
    assert_eq!(payload["root"], root.to_str().unwrap());
    assert_eq!(payload["page"], "note.md");
    // A file in no recent vault has none to open.
    let elsewhere = folder(&[]);
    let w2 = open(&h, &elsewhere.path().join("note.md"));
    assert!(call(&w2, "file_open_in_vault", json!({})).is_err());
}

#[test]
fn open_file_opens_the_picked_notes_and_names_the_others() {
    let h = harness();
    let dir = folder(&[("b.txt", "b"), ("c.png", "")]);
    let picks: Vec<PathBuf> = ["note.md", "b.txt", "c.png"]
        .iter()
        .map(|n| dir.path().join(n))
        .collect();
    h.app
        .state::<FileWindows>()
        .set_picker(Some(Arc::new(move || picks.clone())));
    let refused = call(&h.main, "file_open_dialog", json!({})).unwrap();
    assert_eq!(refused, json!(["c.png"]));
    assert!(h.app.get_webview_window("file-1").is_some());
    assert!(h.app.get_webview_window("file-2").is_some());
    assert!(h.app.get_webview_window("file-3").is_none());
}

#[test]
fn file_windows_have_their_commands_and_no_vault_commands() {
    let h = harness();
    let dir = folder(&[]);
    let w = open(&h, &dir.path().join("note.md"));
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    let denied = |r: Result<Value, Value>| r.is_err_and(|e| e.to_string().contains("not allowed"));
    for cmd in FILE_COMMANDS.iter().chain(SHARED) {
        if *cmd == "file_open_dialog" {
            continue; // would open the OS dialog; allowed in both (below)
        }
        assert!(
            !denied(call(&w, cmd, json!({}))),
            "{cmd} must be allowed in file-1"
        );
        assert!(
            denied(call(&other, cmd, json!({}))),
            "{cmd} must be denied in other"
        );
        if !SHARED.contains(cmd) {
            assert!(
                denied(call(&h.main, cmd, json!({}))),
                "{cmd} must be denied in main"
            );
        }
    }
    for cmd in VAULT_COMMANDS {
        assert!(
            denied(call(&w, cmd, json!({}))),
            "{cmd} must be denied in file-1"
        );
    }
}

#[test]
fn a_window_without_a_grant_reaches_no_file() {
    let h = harness();
    // A file-* window the app didn't open for a file (no grant).
    let stray = WebviewWindowBuilder::new(&h.app, "file-99", Default::default())
        .build()
        .unwrap();
    assert_eq!(
        kind(call(&stray, "file_read", json!({})).unwrap_err()),
        "notPermitted"
    );
}

#[test]
fn a_file_windows_assets_come_from_its_folder_only() {
    use nimw_desktop::asset::serve_window;
    use nimw_desktop::state::AppState;
    let h = harness();
    let outer = folder(&[("secret.png", "s")]);
    let dir = outer.path().join("in");
    for (name, bytes) in [
        ("note.md", "n"),
        ("img/a.png", "0123456789"),
        (".hidden/h.png", "h"),
    ] {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    let w = open(&h, &dir.join("note.md"));
    let state = h.app.state::<AppState>();
    let files = h.app.state::<FileWindows>();
    let get = |label: &str, path: &str, range: Option<&str>| {
        serve_window(&state, &files, label, path, range)
    };
    let ok = get(w.label(), "/img/a.png", None);
    assert_eq!((ok.status, ok.body.as_slice()), (200, &b"0123456789"[..]));
    assert_eq!(get(w.label(), "/img/a.png", Some("bytes=2-4")).status, 206);
    for path in [
        "/../secret.png",
        "/%2E%2E/secret.png",
        "/.hidden/h.png",
        "/.external/%2Fetc%2Fhosts",
    ] {
        assert_eq!(get(w.label(), path, None).status, 403, "{path}");
    }
    assert_eq!(get(w.label(), "/missing.png", None).status, 404);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outer.path().join("secret.png"), dir.join("out.png")).unwrap();
        assert_eq!(get(w.label(), "/out.png", None).status, 404);
    }
    // A file-* label with no grant, and the main window with no vault open.
    assert_eq!(get("file-99", "/img/a.png", None).status, 404);
    assert_eq!(get("main", "/img/a.png", None).status, 404);
}

#[test]
fn a_setting_changed_in_one_window_reaches_every_window() {
    let h = harness();
    let dir = folder(&[]);
    let w = open(&h, &dir.path().join("note.md"));
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = seen.clone();
    h.main.listen("settings:changed", move |e| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(e.payload()).unwrap())
    });
    call(&w, "settings_set", json!({ "patch": { "toolbar": false } })).unwrap();
    let got = seen.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["toolbar"], false);
}

#[test]
fn the_window_hears_when_its_file_changes_and_only_its_file() {
    use std::time::Duration;
    let h = harness();
    let dir = folder(&[("other.md", "o")]);
    let w = open(&h, &dir.path().join("note.md"));
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = seen.clone();
    w.listen("file:changed", move |e| {
        sink.lock().unwrap().push(e.payload().to_string())
    });
    std::thread::sleep(Duration::from_millis(300)); // let the backend arm
    std::fs::write(dir.path().join("other.md"), "changed").unwrap();
    std::thread::sleep(Duration::from_millis(600));
    assert!(
        seen.lock().unwrap().is_empty(),
        "{:?}",
        seen.lock().unwrap()
    );
    std::fs::write(dir.path().join("note.md"), "changed outside").unwrap();
    let wait = Duration::from_secs(5);
    assert!(nimw_testkit::wait_until(wait, || seen
        .lock()
        .unwrap()
        .contains(&r#"{"removed":false}"#.to_string())));
    // Renamed in the app: the window follows its file under the new name.
    call(&w, "file_rename", json!({ "newName": "Renamed.md" })).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    seen.lock().unwrap().clear();
    std::fs::remove_file(dir.path().join("Renamed.md")).unwrap();
    assert!(nimw_testkit::wait_until(wait, || seen
        .lock()
        .unwrap()
        .contains(&r#"{"removed":true}"#.to_string())));
}

#[test]
fn m4c_review_i2_a_window_closes_itself_and_no_other() {
    let h = harness();
    let dir = folder(&[]);
    let w = open(&h, &dir.path().join("note.md"));
    let denied = |r: Result<Value, Value>| r.is_err_and(|e| e.to_string().contains("not allowed"));
    // The window plugin takes any label: neither window may use it.
    assert!(denied(call(
        &w,
        "plugin:window|destroy",
        json!({ "label": "main" })
    )));
    assert!(denied(call(
        &h.main,
        "plugin:window|destroy",
        json!({ "label": "file-1" })
    )));
    assert!(h.app.get_webview_window("main").is_some());
    // Its own close: the command acts on the calling window, whatever the
    // page sends (the mock runtime doesn't carry the destroy out).
    call(&w, "window_close_self", json!({ "label": "main" })).unwrap();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    assert!(denied(call(&other, "window_close_self", json!({}))));
}

#[test]
fn m4c_review_m2_a_file_grown_too_large_is_not_read() {
    let h = harness();
    let dir = folder(&[]);
    let w = open(&h, &dir.path().join("note.md"));
    std::fs::File::options()
        .write(true)
        .open(dir.path().join("note.md"))
        .unwrap()
        .set_len(nimw_desktop::file_windows::PAGE_MAX_BYTES + 1)
        .unwrap();
    assert_eq!(
        kind(call(&w, "file_read", json!({})).unwrap_err()),
        "tooLarge"
    );
}

/// M4c review I4: no visible name reaches a hidden file (a symlink; on
/// Windows an 8.3 name such as `SSH~1`), in a file window or the vault, and
/// a file window is served media and documents only.
#[test]
fn m4c_review_i4_assets_never_resolve_into_hidden_files() {
    use nimw_desktop::asset::serve_window;
    use nimw_desktop::state::AppState;
    let h = harness();
    let dir = folder(&[(".ssh/id.png", "key"), ("notes.txt", "t"), ("a.png", "a")]);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join(".ssh/id.png"), dir.path().join("pic.png"))
            .unwrap();
        std::os::unix::fs::symlink(dir.path().join(".ssh"), dir.path().join("keys")).unwrap();
    }
    let w = open(&h, &dir.path().join("note.md"));
    call(
        &h.main,
        "vault_open",
        json!({ "path": dir.path().to_str().unwrap() }),
    )
    .unwrap();
    let state = h.app.state::<AppState>();
    let files = h.app.state::<FileWindows>();
    for label in [w.label(), "main"] {
        let get = |path: &str| serve_window(&state, &files, label, path, None).status;
        assert_eq!(get("/a.png"), 200, "{label}");
        #[cfg(unix)]
        for path in ["/pic.png", "/keys/id.png"] {
            assert_ne!(get(path), 200, "{label} {path}");
        }
    }
    let get = |path: &str| serve_window(&state, &files, w.label(), path, None).status;
    assert_ne!(
        get("/notes.txt"),
        200,
        "a file window gets media and documents only"
    );
    assert_eq!(
        serve_window(&state, &files, "main", "/notes.txt", None).status,
        200
    );
}
