//! E3 Task 8 (spec §10, the canary leak test): an encrypted vault holding a
//! unique string in a page's name and body, a folder name, an attachment and a
//! recording's page is used (indexed, searched, recorded into, an attachment
//! opened decrypted) and then locked. After the lock no file under the vault,
//! the config dir or the cache dir (which is also the decrypted copies' temp
//! root in tests) holds the string, in its bytes or its name.
//!
//! Real IPC path, tiny Argon2 parameters (`test-params`), the fake audio host
//! `configure` installs whenever it is given dirs, and a fake opener. The
//! WebView's own data dirs aren't covered: the mock runtime has none.

use liber_desktop::AppDirs;
use liber_desktop::state::AppState;
use liber_vault::VaultPath;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::{
    Manager, WebviewWindow, WebviewWindowBuilder, ipc::CallbackFn, ipc::InvokeBody,
    webview::InvokeRequest,
};

const CANARY: &str = "canary-7f3a";

fn call(w: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(w, request).map(|r| r.deserialize::<Value>().unwrap())
}

/// A file's bytes. Windows' byte-range locks are mandatory: the decrypted
/// copies' `.lock`, held while a copy exists, can't be read, but it is empty.
fn read(path: &Path) -> Vec<u8> {
    match std::fs::read(path) {
        Err(e) if cfg!(windows) && e.raw_os_error() == Some(33) => {
            assert_eq!(
                std::fs::metadata(path).unwrap().len(),
                0,
                "{}",
                path.display()
            );
            Vec::new()
        }
        r => r.unwrap(),
    }
}

/// Every file and folder under `root` whose name or bytes hold the canary,
/// ASCII case-insensitively. Links are listed, never followed.
fn canary_hits(root: &Path) -> Vec<PathBuf> {
    let has = |b: &[u8]| {
        b.to_ascii_lowercase()
            .windows(CANARY.len())
            .any(|w| w == CANARY.as_bytes())
    };
    let mut hits = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap() {
            let e = e.unwrap();
            let path = e.path();
            let kind = e.file_type().unwrap();
            if has(e.file_name().as_encoded_bytes()) {
                hits.push(path.clone());
            }
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() && has(&read(&path)) {
                hits.push(path);
            }
        }
    }
    hits
}

#[test]
fn encrypted_canary() {
    let config = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let disk = tempfile::tempdir().unwrap();
    let dirs = AppDirs {
        config: config.path().to_path_buf(),
        cache: cache.path().to_path_buf(),
    };
    let app = liber_desktop::configure(mock_builder(), Some(dirs))
        .build(tauri::generate_context!())
        .expect("app builds with the real context");
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let state = app.state::<AppState>();

    // 1. An encrypted vault.
    let root = disk.path().join("Vault");
    call(
        &main,
        "vault_create_encrypted",
        json!({ "path": root, "passphrase": "correct horse battery staple" }),
    )
    .unwrap();

    // 2. The canary in a page's name and body, a folder's name and an attachment.
    let page = call(
        &main,
        "entry_create_page",
        json!({ "dir": "", "name": "Canary-7f3a" }),
    )
    .unwrap();
    let page = page.as_str().unwrap().to_string();
    assert_eq!(page, "Canary-7f3a.md");
    let read = call(&main, "page_read", json!({ "path": page })).unwrap();
    call(
        &main,
        "page_write",
        json!({
            "path": page,
            "text": format!("# Canary\n\nThe word is {CANARY}.\n"),
            "expectedHash": read["hash"],
        }),
    )
    .unwrap();
    call(
        &main,
        "entry_create_folder",
        json!({ "parent": "", "name": CANARY }),
    )
    .unwrap();
    let attachment = format!("{CANARY}/{CANARY}.pdf");
    {
        let session = state.session().unwrap();
        let mut file = session
            .vault()
            .create_new(&VaultPath::new(&attachment).unwrap())
            .unwrap();
        std::io::Write::write_all(&mut file, format!("%PDF-1.7 {CANARY}").as_bytes()).unwrap();
        file.finish().unwrap();
    }

    // 3. Use it: search, a 0.5 s take into the page, a decrypted copy.
    let found = call(&main, "search", json!({ "query": { "text": CANARY } })).unwrap();
    assert_eq!(found["results"][0]["path"], page.as_str(), "{found}");

    let started = call(
        &main,
        "audio_record_start",
        json!({ "page": page, "device": null, "name": "clip-20261020-101500" }),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(500));
    call(
        &main,
        "audio_record_stop",
        json!({ "recordingId": started["recordingId"], "page": page }),
    )
    .unwrap();

    let opened: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
    let seen = opened.clone();
    state.set_opener(Some(Arc::new(move |p: &Path| {
        seen.lock().unwrap().push(p.to_path_buf());
        Ok(())
    })));
    call(
        &main,
        "attachment_open_decrypted",
        json!({ "path": attachment }),
    )
    .unwrap();
    let copy = opened.lock().unwrap()[0].clone();
    assert!(copy.starts_with(cache.path()), "{}", copy.display());
    // The scan sees a leak while one exists: the copy is plaintext until the lock.
    assert!(
        canary_hits(cache.path()).contains(&copy),
        "the scan finds the decrypted copy before the lock"
    );

    call(&main, "vault_lock", json!({})).unwrap();

    // 4. Nothing left anywhere we can look.
    for dir in [root.as_path(), config.path(), cache.path()] {
        assert_eq!(canary_hits(dir), Vec::<PathBuf>::new(), "{}", dir.display());
    }
}
