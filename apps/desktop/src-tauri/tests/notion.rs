//! M7 Notion import (spec §9) through the real IPC path: real context and
//! capabilities, mock runtime, temp dirs. The zip and folder dialogs are
//! replaced through `NotionState`.

use nimw_desktop::AppDirs;
use nimw_desktop::notion_commands::NotionState;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::test::MockRuntime;
use tauri::{
    App, Manager, WebviewWindow, WebviewWindowBuilder,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

const COMMANDS: &[&str] = &[
    "notion_pick_zip",
    "notion_pick_parent",
    "notion_preview",
    "notion_import",
    "notion_cancel",
    "notion_open_partial",
    "notion_reveal_partial",
];

const ID: &str = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

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

/// A small export: a page linking a child and an image.
fn export_zip(dir: &Path) -> PathBuf {
    let path = dir.join(format!("Team wiki {ID}.zip"));
    let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    let opts = zip::write::SimpleFileOptions::default();
    for (name, body) in [
        (
            format!("Home {ID}.md"),
            format!("# Home\n\n[Child](Home%20{ID}/Child%20{ID}.md)\n"),
        ),
        (format!("Home {ID}/Child {ID}.md"), "# Child\n".to_string()),
        (format!("Home {ID}/pic.png"), "PNG".to_string()),
    ] {
        w.start_file(name, opts).unwrap();
        w.write_all(body.as_bytes()).unwrap();
    }
    w.finish().unwrap();
    path
}

fn picks(h: &Harness, zip: Option<PathBuf>, parent: Option<PathBuf>) {
    let state = h.app.state::<NotionState>();
    state.set_zip_picker(Some(Arc::new(move || zip.clone())));
    state.set_folder_picker(Some(Arc::new(move || parent.clone())));
}

#[test]
fn m7_notion_commands_are_allowed_from_main_and_denied_elsewhere() {
    let h = harness();
    picks(&h, None, None);
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    for cmd in COMMANDS {
        if let Err(e) = call(&h.main, cmd, json!({ "name": "X" })) {
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
fn m7_nothing_happens_before_the_export_and_place_are_picked() {
    let h = harness();
    picks(&h, None, None);
    let err = call(&h.main, "notion_preview", json!({})).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    let err = call(&h.main, "notion_import", json!({ "name": "Wiki" })).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    assert_eq!(
        call(&h.main, "notion_pick_zip", json!({})).unwrap(),
        Value::Null
    );
}

#[test]
fn m7_preview_then_import_opens_the_new_vault_at_its_report() {
    let h = harness();
    let files = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    picks(
        &h,
        Some(export_zip(files.path())),
        Some(parent.path().to_path_buf()),
    );

    let zip = call(&h.main, "notion_pick_zip", json!({})).unwrap();
    assert_eq!(zip["suggestedName"], "Team wiki");
    let preview = call(&h.main, "notion_preview", json!({})).unwrap();
    assert_eq!(
        (
            &preview["pages"],
            &preview["attachments"],
            &preview["folders"]
        ),
        (&json!(2), &json!(1), &json!(1)),
        "{preview}"
    );
    assert!(
        std::fs::read_dir(parent.path()).unwrap().next().is_none(),
        "the preview writes nothing"
    );

    call(&h.main, "notion_pick_parent", json!({})).unwrap();
    // The name is one plain folder name, and the folder must be new.
    for bad in ["a/b", "../x", ".hidden", "What?", ""] {
        let err = call(&h.main, "notion_import", json!({ "name": bad })).unwrap_err();
        assert_eq!(kind(err), "invalidName", "{bad:?}");
    }
    std::fs::create_dir(parent.path().join("Taken")).unwrap();
    let err = call(&h.main, "notion_import", json!({ "name": "Taken" })).unwrap_err();
    assert_eq!(kind(err), "alreadyExists");

    let done = call(&h.main, "notion_import", json!({ "name": "Wiki" })).unwrap();
    let root = dunce::canonicalize(parent.path().join("Wiki")).unwrap();
    assert_eq!(done["vault"]["root"], json!(root.to_string_lossy()));
    assert_eq!(done["report"], "Notion import report.md");
    assert_eq!(done["cancelled"], false);
    assert_eq!(
        std::fs::read_to_string(root.join("Home/Home.md")).unwrap(),
        "# Home\n\n[[Child]]\n"
    );
    // The new vault is the open one.
    let read = call(&h.main, "page_read", json!({ "path": "Home/Child.md" })).unwrap();
    assert_eq!(read["text"], "# Child\n");
    // The picks are used up.
    let err = call(&h.main, "notion_import", json!({ "name": "Again" })).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}

#[test]
fn b6_review_i7_a_cancelled_re_pick_keeps_the_export_picked() {
    let h = harness();
    let files = tempfile::tempdir().unwrap();
    picks(&h, Some(export_zip(files.path())), None);
    call(&h.main, "notion_pick_zip", json!({})).unwrap();
    // The dialog opened again and cancelled: the export stays picked.
    picks(&h, None, None);
    assert_eq!(
        call(&h.main, "notion_pick_zip", json!({})).unwrap(),
        Value::Null
    );
    let preview = call(&h.main, "notion_preview", json!({})).unwrap();
    assert_eq!(preview["pages"], json!(2));
}

#[test]
fn b6_review_m7_an_existing_vault_is_refused_before_the_export_is_read() {
    let h = harness();
    let files = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    // Not a zip: reading it would fail, so the refusal must come first.
    let broken = files.path().join("broken.zip");
    std::fs::write(&broken, b"not a zip").unwrap();
    picks(&h, Some(broken), Some(parent.path().to_path_buf()));
    call(&h.main, "notion_pick_zip", json!({})).unwrap();
    call(&h.main, "notion_pick_parent", json!({})).unwrap();
    std::fs::create_dir(parent.path().join("Taken")).unwrap();
    let err = call(&h.main, "notion_import", json!({ "name": "Taken" })).unwrap_err();
    assert_eq!(kind(err), "alreadyExists");
}

#[test]
fn b6_review_m8_a_stop_before_the_import_starts_is_honoured() {
    let h = harness();
    let files = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    picks(
        &h,
        Some(export_zip(files.path())),
        Some(parent.path().to_path_buf()),
    );
    call(&h.main, "notion_pick_zip", json!({})).unwrap();
    call(&h.main, "notion_preview", json!({})).unwrap();
    call(&h.main, "notion_pick_parent", json!({})).unwrap();
    call(&h.main, "notion_cancel", json!({})).unwrap();
    call(&h.main, "notion_import", json!({ "name": "Wiki" })).unwrap_err();
    assert!(!parent.path().join("Wiki").exists());
}

#[test]
fn b6_review_i8_nothing_partial_to_open_or_reveal_before_a_failed_import() {
    let h = harness();
    picks(&h, None, None);
    for cmd in ["notion_open_partial", "notion_reveal_partial"] {
        let err = call(&h.main, cmd, json!({})).unwrap_err();
        assert_eq!(kind(err), "notPermitted", "{cmd}");
    }
}
