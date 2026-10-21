//! Encrypt in place (encryption UX spec §4.3, §8): the commands through the
//! real IPC path, with tiny Argon2 parameters (`test-params`). Config, cache
//! and vaults live in temp dirs; the trash is `AppState::for_tests`' fake
//! (`<cache>/test-trash`), never the OS trash.

use liber_desktop::AppDirs;
use liber_desktop::state::AppState;
use liber_vault::EncryptedStorage;
use liber_vault::convert::{self, CrashPoint};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::{
    App, Listener, Manager, WebviewWindow, WebviewWindowBuilder, ipc::CallbackFn, ipc::InvokeBody,
    webview::InvokeRequest,
};

const PASS: &str = "correct horse battery staple";
const TINY: liber_crypto::Argon2Params = liber_crypto::Argon2Params {
    m_kib: 64,
    t: 1,
    p: 1,
};

struct Harness {
    app: App<MockRuntime>,
    main: WebviewWindow<MockRuntime>,
    config: tempfile::TempDir,
    cache: tempfile::TempDir,
    disk: tempfile::TempDir,
}

fn harness() -> Harness {
    let config = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
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
    Harness {
        app,
        main,
        config,
        cache,
        disk: tempfile::tempdir().unwrap(),
    }
}

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

fn kind(err: Value) -> String {
    err["kind"].as_str().unwrap_or_default().to_string()
}

/// Every entry under `dir` with its bytes (`None` for a folder).
fn snapshot(dir: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Option<Vec<u8>>>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let rel = p
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if p.is_dir() {
                out.insert(rel, None);
                walk(base, &p, out);
            } else {
                out.insert(rel, Some(std::fs::read(&p).unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

impl Harness {
    /// A plain vault `name` with four files, canonical.
    fn plain(&self, name: &str) -> PathBuf {
        let root = self.disk.path().join(name);
        for (rel, body) in [
            ("Notes.md", "# Notes\n\nhello"),
            ("Sub/Deep.md", "deep"),
            (".obsidian/app.json", "{}"),
            ("files/a.bin", "binary-ish"),
        ] {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        dunce::canonicalize(root).unwrap()
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    fn install_id(&self) -> String {
        liber_desktop::epochs::install_id(self.config.path()).unwrap()
    }

    fn bin(&self) -> PathBuf {
        self.cache.path().join("test-trash")
    }

    /// Payloads of `event` from now on.
    fn events(&self, event: &str) -> Arc<Mutex<Vec<Value>>> {
        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = got.clone();
        self.app.listen_any(event, move |e| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(e.payload()).unwrap())
        });
        got
    }

    fn unlock(&self, root: &Path, kind: &str, value: &str) -> Result<Value, Value> {
        call(
            &self.main,
            "vault_unlock",
            json!({ "path": root, "secret": { "kind": kind, "value": value } }),
        )
    }

    /// A conversion of `root` by `install` that stops at `at`, as if the app died.
    fn crash(&self, root: &Path, install: &str, at: CrashPoint) {
        convert::crash_at(Some(at));
        let run = (|| -> convert::Result<()> {
            let (mut c, _) = convert::begin(root, &[], install, |p| {
                EncryptedStorage::create_insecure(p, PASS, TINY)
            })?;
            convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false))?;
            convert::stage_and_commit(c)?;
            let trash = |_: &Path| -> std::io::Result<()> { unreachable!() };
            convert::finish(root, &trash, &|| Ok(()))?;
            Ok(())
        })();
        convert::crash_at(None);
        assert!(run.is_err(), "{at:?}");
    }
}

#[test]
fn encrypts_a_plain_vault_in_place_end_to_end() {
    let h = harness();
    let root = h.plain("Smartjob");
    // Open plain first: its index lands in the cache.
    call(&h.main, "vault_open", json!({ "path": root })).unwrap();
    let index_dir = liber_session::index_db_path(h.cache.path(), &root)
        .parent()
        .unwrap()
        .to_path_buf();
    assert!(index_dir.exists());

    let pre = call(&h.main, "vault_encrypt_preflight", json!({ "path": root })).unwrap();
    assert_eq!(pre["files"], 4);
    assert_eq!(pre["blocked"], json!([]));
    assert!(pre["bytes"].as_u64().unwrap() > 0);

    let begun = call(
        &h.main,
        "vault_encrypt_begin",
        json!({ "path": root, "passphrase": PASS }),
    )
    .unwrap();
    let code = begun["recovery"].as_str().unwrap().to_string();
    assert!(code.starts_with("LIBER-"), "{code}");
    // The plain session for that folder is closed.
    let err = call(&h.main, "vault_tree", json!({})).unwrap_err();
    assert_eq!(kind(err), "noVault");

    let progress = h.events("vault:encrypt-progress");
    let info = call(&h.main, "vault_encrypt_run", json!({})).unwrap();
    assert_eq!(info["encrypted"], true);
    assert_eq!(info["originalsPending"], false);
    assert_eq!(info["name"], "Smartjob");
    let progress = progress.lock().unwrap().clone();
    assert_eq!(progress.last(), Some(&json!({ "done": 4, "total": 4 })));
    assert!(progress.len() >= 4, "{progress:?}");

    // The vault is open and unlocked, its pages readable.
    let page = call(&h.main, "page_read", json!({ "path": "Notes.md" })).unwrap();
    assert_eq!(page["text"], "# Notes\n\nhello");
    // The plaintext index is gone; the epoch is recorded.
    assert!(!index_dir.exists(), "the old plaintext index is deleted");
    let epochs: Value =
        serde_json::from_slice(&std::fs::read(h.config.path().join("vault-epochs.json")).unwrap())
            .unwrap();
    assert_eq!(epochs.as_object().unwrap().len(), 1, "{epochs}");
    // The originals went to the (fake) trash, visibly named.
    let trashed = h.bin().join("Smartjob (unencrypted originals)");
    assert_eq!(std::fs::read(trashed.join("Sub/Deep.md")).unwrap(), b"deep");
    assert!(convert::read_journal(&root).unwrap().is_none());
    // The code shown at begin opens it.
    call(&h.main, "vault_lock", json!({})).unwrap();
    h.unlock(&root, "recovery", &code).unwrap();
}

#[test]
fn stop_and_undo_restores_the_vault_before_and_during_the_run() {
    let h = harness();
    let root = h.plain("V");
    let before = snapshot(&root);
    call(
        &h.main,
        "vault_encrypt_begin",
        json!({ "path": root, "passphrase": PASS }),
    )
    .unwrap();
    call(&h.main, "vault_encrypt_cancel", json!({})).unwrap();
    assert_eq!(
        snapshot(&root),
        before,
        "cancelled at the recovery key step"
    );
    let err = call(&h.main, "vault_encrypt_run", json!({})).unwrap_err();
    assert_eq!(kind(err), "notPermitted", "nothing to run any more");

    call(
        &h.main,
        "vault_encrypt_begin",
        json!({ "path": root, "passphrase": PASS }),
    )
    .unwrap();
    let handle = h.app.handle().clone();
    h.app.listen_any("vault:encrypt-progress", move |e| {
        let p: Value = serde_json::from_str(e.payload()).unwrap();
        if p["done"] == 1 {
            liber_desktop::convert_commands::vault_encrypt_cancel_impl(&handle).unwrap();
        }
    });
    let err = call(&h.main, "vault_encrypt_run", json!({})).unwrap_err();
    assert_eq!(kind(err), "cancelled");
    assert_eq!(snapshot(&root), before, "stopped mid-copy and undone");
}

#[test]
fn recovery_on_open_rolls_back_or_finishes_this_devices_conversion() {
    let h = harness();
    let me = h.install_id();
    let recovered = h.events("vault:encrypt-recovered");

    // Interrupted before `staged`: back as it was, and open.
    let root = h.plain("A");
    let before = snapshot(&root);
    h.crash(&root, &me, CrashPoint::Staging(1));
    let info = call(&h.main, "vault_open", json!({ "path": root })).unwrap();
    assert_eq!(info["encrypted"], false);
    assert_eq!(snapshot(&root), before);

    // Interrupted after `staged`: finished, so the folder unlocks.
    let root = h.plain("B");
    h.crash(&root, &me, CrashPoint::AfterStaged);
    let err = call(&h.main, "vault_open", json!({ "path": root })).unwrap_err();
    assert_eq!(kind(err), "locked");
    let info = h.unlock(&root, "passphrase", PASS).unwrap();
    assert_eq!(info["originalsPending"], false);
    assert!(h.bin().join("B (unencrypted originals)/Notes.md").exists());

    let got = recovered.lock().unwrap().clone();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    assert_eq!(
        got,
        vec![
            json!({ "path": path(&h.disk.path().join("A").canonicalize().unwrap()), "outcome": "rolledBack" }),
            json!({ "path": path(&h.disk.path().join("B").canonicalize().unwrap()), "outcome": "finished" }),
        ]
    );
}

#[test]
fn originals_the_trash_refused_are_reported_and_can_be_trashed_later() {
    let h = harness();
    let me = h.install_id();
    let root = h.plain("C");
    h.crash(&root, &me, CrashPoint::AfterCommitted);
    h.state()
        .set_trasher(Arc::new(|_: &Path| Err(std::io::Error::other("no trash"))));
    let info = h.unlock(&root, "passphrase", PASS).unwrap();
    assert_eq!(info["originalsPending"], true);
    assert!(root.join(convert::ORIGINALS).join("Notes.md").exists());
    // Still refused: still pending.
    let err = call(&h.main, "vault_trash_originals", json!({})).unwrap_err();
    assert_eq!(kind(err), "io");
    let bin = h.bin();
    h.state().set_trasher(Arc::new(move |p: &Path| {
        std::fs::create_dir_all(&bin)?;
        std::fs::rename(p, bin.join(p.file_name().unwrap()))
    }));
    call(&h.main, "vault_trash_originals", json!({})).unwrap();
    assert!(h.bin().join("C (unencrypted originals)/Notes.md").exists());
    assert!(convert::read_journal(&root).unwrap().is_none());
    call(&h.main, "vault_lock", json!({})).unwrap();
    let info = h.unlock(&root, "passphrase", PASS).unwrap();
    assert_eq!(info["originalsPending"], false);
}

#[test]
fn another_devices_conversion_refuses_to_open_and_touches_nothing() {
    let h = harness();
    for at in [CrashPoint::Staging(1), CrashPoint::AfterData] {
        let root = h.plain(&format!("{at:?}"));
        h.crash(&root, "another-install", at);
        let before = snapshot(&root);
        let err = call(&h.main, "vault_open", json!({ "path": root })).unwrap_err();
        assert_eq!(kind(err.clone()), "convertingElsewhere", "{err}");
        let err = h.unlock(&root, "passphrase", PASS).unwrap_err();
        assert_eq!(kind(err), "convertingElsewhere");
        assert_eq!(snapshot(&root), before);
    }
}

#[test]
fn the_scratchpad_blocked_folders_and_short_passphrases_are_refused() {
    let h = harness();
    let root = h.plain("Scratch");
    let before = snapshot(&root);
    h.state()
        .settings
        .set_scratchpad_path(Some(root.to_string_lossy().into_owned()))
        .unwrap();
    for cmd in ["vault_encrypt_preflight", "vault_encrypt_begin"] {
        let err = call(&h.main, cmd, json!({ "path": root, "passphrase": PASS })).unwrap_err();
        assert_eq!(kind(err), "notPermitted", "{cmd}");
    }
    assert_eq!(snapshot(&root), before);

    let root = h.plain("Repo");
    std::fs::create_dir(root.join(".git")).unwrap();
    let before = snapshot(&root);
    let pre = call(&h.main, "vault_encrypt_preflight", json!({ "path": root })).unwrap();
    assert_eq!(pre["blocked"], json!([{ "path": ".git", "reason": "git" }]));
    let err = call(
        &h.main,
        "vault_encrypt_begin",
        json!({ "path": root, "passphrase": PASS }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    assert_eq!(snapshot(&root), before);

    let root = h.plain("Short");
    let err = call(
        &h.main,
        "vault_encrypt_begin",
        json!({ "path": root, "passphrase": "short" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "invalidInput");
    // An encrypted vault isn't converted again.
    let enc = h.disk.path().join("Enc");
    call(
        &h.main,
        "vault_create_encrypted",
        json!({ "path": enc, "passphrase": PASS }),
    )
    .unwrap();
    let err = call(&h.main, "vault_encrypt_preflight", json!({ "path": enc })).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}

/// The New vault dialog's `folder_kind` recovers this device's interrupted
/// conversion first: mid-commit the root has `d/` and no header, which
/// would otherwise read as damaged. It also names the folders never
/// encrypted in place (§8.10), so the dialog doesn't offer it.
#[test]
fn folder_kind_recovers_an_interrupted_conversion_and_names_refused_folders() {
    let h = harness();
    let me = h.install_id();
    let recovered = h.events("vault:encrypt-recovered");
    let ask = |p: &Path| call(&h.main, "folder_kind", json!({ "path": p }));

    let root = h.plain("Mid");
    h.crash(&root, &me, CrashPoint::AfterData);
    assert_eq!(ask(&root).unwrap(), "encrypted");
    assert!(convert::read_journal(&root).unwrap().is_none());

    let root = h.plain("Early");
    let before = snapshot(&root);
    h.crash(&root, &me, CrashPoint::Staging(1));
    assert_eq!(ask(&root).unwrap(), "plain");
    assert_eq!(snapshot(&root), before);
    let outcomes: Vec<Value> = recovered
        .lock()
        .unwrap()
        .iter()
        .map(|e| e["outcome"].clone())
        .collect();
    assert_eq!(outcomes, vec![json!("finished"), json!("rolledBack")]);

    let root = h.plain("Elsewhere");
    h.crash(&root, "another-install", CrashPoint::AfterData);
    assert_eq!(kind(ask(&root).unwrap_err()), "convertingElsewhere");

    let root = h.plain("Scratch");
    h.state()
        .settings
        .set_scratchpad_path(Some(root.to_string_lossy().into_owned()))
        .unwrap();
    assert_eq!(ask(&root).unwrap(), "refused");
    assert_eq!(ask(Path::new("/")).unwrap(), "refused", "a volume root");
}

// ---- Review fix round ----

fn begin(h: &Harness, root: &Path) -> Result<Value, Value> {
    call(
        &h.main,
        "vault_encrypt_begin",
        json!({ "path": root, "passphrase": PASS }),
    )
}

/// Review I1: a single-file window on a note in the folder refuses begin
/// (its own plain vault would later write plaintext into the encrypted root).
#[test]
fn a_file_window_inside_the_folder_refuses_begin() {
    let h = harness();
    let root = h.plain("Win");
    let before = snapshot(&root);
    liber_desktop::file_windows::open_file_window(h.app.handle(), &root.join("Sub/Deep.md"))
        .expect("file window opens");
    let err = begin(&h, &root).unwrap_err();
    assert_eq!(kind(err.clone()), "notPermitted", "{err}");
    assert!(
        err["message"].as_str().unwrap().contains("windows"),
        "{err}"
    );
    assert_eq!(snapshot(&root), before);
}

/// Review I2: a take in progress in the plain vault is stopped and kept in
/// it before the conversion, so it ends up encrypted too.
#[test]
fn a_take_in_progress_is_kept_and_encrypted() {
    let h = harness();
    let root = h.plain("Rec");
    call(&h.main, "vault_open", json!({ "path": root })).unwrap();
    let started = call(
        &h.main,
        "audio_record_start",
        json!({ "page": "Notes.md", "device": null, "name": "clip-20261021-120000" }),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(250));
    begin(&h, &root).unwrap();
    let id = started["recordingId"].clone();
    let err = call(&h.main, "audio_record_stop", json!({ "recordingId": id })).unwrap_err();
    assert_eq!(kind(err), "notFound", "the take already ended");
    call(&h.main, "vault_encrypt_run", json!({})).unwrap();
    let tree = call(&h.main, "vault_tree", json!({})).unwrap();
    assert!(
        tree.as_array().unwrap().iter().any(|n| n["path"]
            .as_str()
            .unwrap()
            .ends_with("clip-20261021-120000.wav")),
        "{tree}"
    );
    let plain_wavs: Vec<_> = snapshot(&root)
        .into_keys()
        .filter(|k| k.ends_with(".wav"))
        .collect();
    assert!(
        plain_wavs.is_empty(),
        "no plaintext clip at the root: {plain_wavs:?}"
    );
}

/// Review I3: the open vault closes when it is inside the folder (its
/// plaintext index goes too) or holds it.
#[test]
fn an_open_vault_inside_or_around_the_folder_is_closed() {
    let h = harness();
    let root = h.plain("Outer");
    let inner = root.join("Sub");
    call(&h.main, "vault_open", json!({ "path": inner })).unwrap();
    let index = liber_session::index_db_path(h.cache.path(), &inner);
    assert!(index.parent().unwrap().exists());
    begin(&h, &root).unwrap();
    assert_eq!(
        kind(call(&h.main, "vault_tree", json!({})).unwrap_err()),
        "noVault"
    );
    assert!(
        !index.parent().unwrap().exists(),
        "the inner vault's index is gone"
    );
    call(&h.main, "vault_encrypt_cancel", json!({})).unwrap();

    let parent = h.disk.path().canonicalize().unwrap();
    call(&h.main, "vault_open", json!({ "path": parent })).unwrap();
    begin(&h, &root).unwrap();
    assert_eq!(
        kind(call(&h.main, "vault_tree", json!({})).unwrap_err()),
        "noVault"
    );
    call(&h.main, "vault_encrypt_cancel", json!({})).unwrap();
}

/// Review I4: when undoing a failed run fails too, the run says so (never
/// "back as it was"), the folder isn't left marked as running, and the next
/// open finishes the undo.
#[test]
fn a_failed_undo_is_reported_and_retried_on_open() {
    let h = harness();
    let root = h.plain("Undo");
    let before = snapshot(&root);
    begin(&h, &root).unwrap();
    convert::crash_when(Some(Box::new(|p| {
        matches!(p, CrashPoint::Staging(1) | CrashPoint::Unstaging(0))
    })));
    let err = liber_desktop::convert_commands::vault_encrypt_run_impl(h.app.handle()).unwrap_err();
    convert::crash_when(None);
    assert!(err.message.contains("undoing it failed too"), "{err:?}");
    assert!(err.message.contains("Unstaging"), "{err:?}");
    call(&h.main, "vault_open", json!({ "path": root })).unwrap();
    assert_eq!(snapshot(&root), before);
}

/// Review M4, M5: a run in progress can't be replaced; a begin never run is
/// undone by the next begin, the same folder's included.
#[test]
fn one_conversion_at_a_time_and_a_new_begin_replaces_an_unrun_one() {
    let h = harness();
    let root = h.plain("Again");
    let before = snapshot(&root);
    let first = begin(&h, &root).unwrap();
    let second = begin(&h, &root).unwrap();
    assert_ne!(first["recovery"], second["recovery"]);
    call(&h.main, "vault_encrypt_cancel", json!({})).unwrap();
    assert_eq!(snapshot(&root), before);

    let other = h.plain("Other");
    begin(&h, &root).unwrap();
    let w = h.main.clone();
    let refused: Arc<Mutex<Option<Value>>> = Arc::default();
    let sink = refused.clone();
    h.app.listen_any("vault:encrypt-progress", move |e| {
        let p: Value = serde_json::from_str(e.payload()).unwrap();
        if p["done"] == 1 {
            let r = call(
                &w,
                "vault_encrypt_begin",
                json!({ "path": other, "passphrase": PASS }),
            );
            *sink.lock().unwrap() = Some(r.unwrap_err());
        }
    });
    call(&h.main, "vault_encrypt_run", json!({})).unwrap();
    let refused = refused.lock().unwrap().clone().unwrap();
    assert_eq!(kind(refused), "notPermitted");
}

/// Final round N3: "Move to Trash" only for originals the Trash refused
/// (`trashPending`). Another device's committed conversion opens here, but
/// its finish belongs to that device.
#[test]
fn trash_originals_needs_a_pending_trash() {
    let h = harness();
    let root = h.plain("Theirs");
    h.crash(&root, "another-install", CrashPoint::AfterCommitted);
    h.unlock(&root, "passphrase", PASS).unwrap();
    let err = call(&h.main, "vault_trash_originals", json!({})).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    assert!(root.join(convert::ORIGINALS).join("Notes.md").exists());
    let journal = convert::read_journal(&root).unwrap().unwrap();
    assert_eq!(journal.phase, convert::Phase::Committed);
}

/// Final round: plaintext must not linger in search indexes. Begin drops the
/// index of every recent vault inside or around the folder; an unlock drops
/// any plaintext index left for that path (another device converted it).
#[test]
fn plaintext_indexes_are_swept_at_begin_and_at_unlock() {
    let h = harness();
    let root = h.plain("Swept");
    let index = |p: &Path| {
        liber_session::index_db_path(h.cache.path(), p)
            .parent()
            .unwrap()
            .to_path_buf()
    };
    let inner = root.join("Sub");
    let parent = h.disk.path().canonicalize().unwrap();
    let elsewhere = h.plain("Elsewhere");
    for v in [&inner, &parent, &elsewhere] {
        call(&h.main, "vault_open", json!({ "path": v })).unwrap();
        assert!(index(v).exists());
    }
    // Only the last one is open: the others are on the recent list.
    begin(&h, &root).unwrap();
    assert!(!index(&inner).exists(), "a vault inside the folder");
    assert!(!index(&parent).exists(), "a vault around the folder");
    assert!(
        index(&elsewhere).exists(),
        "an unrelated vault keeps its index"
    );
    call(&h.main, "vault_encrypt_cancel", json!({})).unwrap();

    let enc = h.disk.path().join("Enc");
    call(
        &h.main,
        "vault_create_encrypted",
        json!({ "path": enc, "passphrase": PASS }),
    )
    .unwrap();
    let enc = enc.canonicalize().unwrap();
    call(&h.main, "vault_lock", json!({})).unwrap();
    std::fs::create_dir_all(index(&enc)).unwrap();
    std::fs::write(index(&enc).join("index.sqlite"), b"plain text").unwrap();
    h.unlock(&enc, "passphrase", PASS).unwrap();
    assert!(!index(&enc).exists(), "the old plaintext index is gone");
}

/// Final round: preflight tells the UI whether begin will close the open
/// vault (this folder under any spelling, inside it or around it).
#[test]
fn preflight_says_whether_begin_closes_the_open_vault() {
    let h = harness();
    let root = h.plain("Closes");
    let closes = |p: &Path| {
        call(&h.main, "vault_encrypt_preflight", json!({ "path": p })).unwrap()["closesOpen"]
            .clone()
    };
    assert_eq!(closes(&root), json!(false), "nothing open");
    call(&h.main, "vault_open", json!({ "path": root.join("Sub") })).unwrap();
    assert_eq!(closes(&root), json!(true), "a vault inside");
    call(&h.main, "vault_open", json!({ "path": root })).unwrap();
    assert_eq!(
        closes(&root.join("Sub/..")),
        json!(true),
        "another spelling"
    );
    let other = h.plain("Other");
    call(&h.main, "vault_open", json!({ "path": other })).unwrap();
    assert_eq!(closes(&root), json!(false), "an unrelated vault");
}
