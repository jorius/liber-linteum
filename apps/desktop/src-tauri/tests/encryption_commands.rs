//! E3 Task 5: the encryption commands (the E3 → E4 contract) through the real
//! IPC path, with tiny Argon2 parameters (`test-params`, enabled by this
//! crate's own dev-dependency). Config, cache and decrypted copies live in
//! temp dirs; header copies are deleted, never sent to the OS trash; the
//! opener is a fake.

use liber_crypto::{Argon2Params, NewSlot, Secret, SlotKind, Unlock, VaultHeader};
use liber_desktop::AppDirs;
use liber_desktop::state::AppState;
use liber_vault::VaultPath;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::{
    App, Listener, Manager, WebviewWindow, WebviewWindowBuilder, ipc::CallbackFn, ipc::InvokeBody,
    webview::InvokeRequest,
};

const PASS: &str = "correct horse battery staple";
const NEW_PASS: &str = "a brand new passphrase";
const TINY: Argon2Params = Argon2Params {
    m_kib: 64,
    t: 1,
    p: 1,
};

struct Harness {
    app: App<MockRuntime>,
    main: WebviewWindow<MockRuntime>,
    config: tempfile::TempDir,
    cache: tempfile::TempDir,
    /// Holds the vaults.
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

impl Harness {
    /// A new encrypted vault `name`, open; its recovery code.
    fn create(&self, name: &str) -> (PathBuf, String) {
        let root = self.disk.path().join(name);
        let out = call(
            &self.main,
            "vault_create_encrypted",
            json!({ "path": root, "passphrase": PASS }),
        )
        .unwrap();
        assert_eq!(out["info"]["encrypted"], true);
        assert_eq!(out["info"]["recoveryVoid"], false);
        (root, out["recovery"].as_str().unwrap().to_string())
    }

    fn unlock(&self, root: &Path, kind: &str, value: &str) -> Result<Value, Value> {
        call(
            &self.main,
            "vault_unlock",
            json!({ "path": root, "secret": { "kind": kind, "value": value } }),
        )
    }

    fn lock(&self) {
        call(&self.main, "vault_lock", json!({})).unwrap();
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// Writes `body` at `path` (its folders made) in the open vault.
    fn write(&self, path: &str, body: &[u8]) {
        let session = self.state().session().unwrap();
        let path = VaultPath::new(path).unwrap();
        session
            .vault()
            .create_dir_all(&path.parent().unwrap())
            .unwrap();
        let mut file = session.vault().create_new(&path).unwrap();
        std::io::Write::write_all(&mut file, body).unwrap();
        file.finish().unwrap();
    }
}

fn header_path(root: &Path) -> PathBuf {
    root.join("liber-vault.json")
}

/// The vault's header, unlocked with `PASS`.
fn header(root: &Path) -> (VaultHeader, liber_crypto::Unlocked) {
    let h = VaultHeader::parse(&std::fs::read(header_path(root)).unwrap()).unwrap();
    let u = h.unlock(Unlock::Passphrase(PASS)).unwrap();
    (h, u)
}

fn recovery_id(h: &VaultHeader) -> [u8; 16] {
    h.slots()
        .iter()
        .find(|s| matches!(s.kind, SlotKind::Recovery))
        .unwrap()
        .id
}

#[test]
fn create_unlock_lock_cycle() {
    let h = harness();
    let (root, code) = h.create("Secret");
    assert_eq!(code.len(), 75, "{code}");
    assert!(code.starts_with("LIBER-"), "{code}");
    call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "", "name": "Diary" }),
    )
    .unwrap();

    let locked: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = locked.clone();
    h.app.listen_any("vault:locked", move |e| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(e.payload()).unwrap())
    });
    h.lock();
    let got = locked.lock().unwrap().clone();
    assert_eq!(got.len(), 1, "{got:?}");
    let canonical = std::fs::canonicalize(&root).unwrap();
    assert_eq!(got[0]["path"], canonical.to_string_lossy().as_ref());
    let err = call(&h.main, "page_get", json!({ "path": "Diary.md" })).unwrap_err();
    assert_eq!(kind(err), "noVault");
    let err = call(&h.main, "vault_lock", json!({})).unwrap_err();
    assert_eq!(kind(err), "noVault");

    let err = call(&h.main, "vault_open", json!({ "path": root })).unwrap_err();
    assert_eq!(kind(err), "locked");

    let info = h.unlock(&root, "passphrase", PASS).unwrap();
    assert_eq!(info["encrypted"], true);
    assert_eq!(info["recoveryVoid"], false);
    let page = call(&h.main, "page_get", json!({ "path": "Diary.md" })).unwrap();
    assert_eq!(page["title"], "Diary");
    h.lock();

    let typed = code.to_lowercase().replace('-', " ");
    h.unlock(&root, "recovery", &typed).unwrap();
    h.lock();

    let err = h
        .unlock(&root, "passphrase", "not the passphrase")
        .unwrap_err();
    assert_eq!(kind(err), "wrongSecret");
    let err = h.unlock(&root, "recovery", "LIBER-0000").unwrap_err();
    assert_eq!(kind(err), "invalidInput");
}

#[test]
fn create_refuses_short_passphrases_and_occupied_folders() {
    let h = harness();
    let root = h.disk.path().join("Short");
    let err = call(
        &h.main,
        "vault_create_encrypted",
        json!({ "path": root, "passphrase": "eleven char" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "invalidInput");
    assert!(!root.exists(), "nothing created for a refused passphrase");

    let busy = h.disk.path().join("Busy");
    std::fs::create_dir(&busy).unwrap();
    std::fs::write(busy.join("note.md"), "# mine").unwrap();
    let err = call(
        &h.main,
        "vault_create_encrypted",
        json!({ "path": busy, "passphrase": PASS }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notEmpty");
}

#[test]
fn rollback_is_refused() {
    let h = harness();
    let (root, _code) = h.create("Rolled");
    h.lock();
    // Step 1: an unlock at epoch 1 (recorded).
    h.unlock(&root, "passphrase", PASS).unwrap();
    h.lock();
    let epoch_1 = std::fs::read(header_path(&root)).unwrap();

    // Step 2: rotate to epoch 2 behind the app's back.
    let (mut hdr, u) = header(&root);
    let (nu, _rc) = hdr.begin_rotation_insecure(&u, PASS, TINY).unwrap();
    hdr.finish_rotation(&nu).unwrap();
    std::fs::write(header_path(&root), hdr.to_bytes(&nu).unwrap()).unwrap();

    // Step 3: the unlock records 2.
    h.unlock(&root, "passphrase", PASS).unwrap();
    h.lock();
    let store: Value =
        serde_json::from_slice(&std::fs::read(h.config.path().join("vault-epochs.json")).unwrap())
            .unwrap();
    let id: String = hdr
        .vault_id()
        .0
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(store[&id], 2, "{store}");

    // Steps 4–5: the epoch-1 header put back is refused.
    std::fs::write(header_path(&root), &epoch_1).unwrap();
    let err = h.unlock(&root, "passphrase", PASS).unwrap_err();
    assert_eq!(kind(err), "rollback");
    assert_eq!(
        std::fs::read(header_path(&root)).unwrap(),
        epoch_1,
        "never written"
    );
    let err = call(&h.main, "page_get", json!({ "path": "x.md" })).unwrap_err();
    assert_eq!(kind(err), "noVault");
}

#[test]
fn header_conflict_copy_is_merged() {
    let h = harness();
    let (root, _code) = h.create("Merged");
    h.lock();
    // Copy B: another device added its slot.
    let (mut b, u) = header(&root);
    let secret = Secret::<32>::random();
    b.add_slot(
        &u,
        NewSlot::Device {
            device_id: "laptop B".into(),
            secret: &secret,
        },
    )
    .unwrap();
    let copy = root.join("liber-vault (conflicted copy).json");
    std::fs::write(&copy, b.to_bytes(&u).unwrap()).unwrap();
    // A copy that isn't this vault's is left alone.
    let stray = root.join("liber-vault 2.json");
    std::fs::write(&stray, "{ not a header").unwrap();

    h.unlock(&root, "passphrase", PASS).unwrap();
    assert!(!copy.exists(), "the merged copy left the root");
    assert!(stray.exists(), "an unmerged copy stays");
    let merged = VaultHeader::parse(&std::fs::read(header_path(&root)).unwrap()).unwrap();
    merged.unlock(Unlock::Device(&secret)).unwrap();
}

#[test]
fn recovery_void_reported() {
    let h = harness();
    let (root, _code) = h.create("Void");
    h.lock();
    // Two devices each replaced the recovery code; the smaller slot id wins.
    let (mut a, u) = header(&root);
    a.new_recovery(&u).unwrap();
    let (mut b, _) = header(&root);
    b.new_recovery(&u).unwrap();
    let (winner, loser) = if recovery_id(&a) < recovery_id(&b) {
        (a, b)
    } else {
        (b, a)
    };
    std::fs::write(header_path(&root), loser.to_bytes(&u).unwrap()).unwrap();
    std::fs::write(
        root.join("liber-vault.sync-conflict-20261020-101010-ABCDEFG.json"),
        winner.to_bytes(&u).unwrap(),
    )
    .unwrap();

    let info = h.unlock(&root, "passphrase", PASS).unwrap();
    assert_eq!(info["recoveryVoid"], true);
    let merged = VaultHeader::parse(&std::fs::read(header_path(&root)).unwrap()).unwrap();
    assert_eq!(recovery_id(&merged), recovery_id(&winner));
}

#[test]
fn change_passphrase_and_new_recovery() {
    let h = harness();
    let (root, old_code) = h.create("Keys");
    let change = |current: &str, next: &str| {
        call(
            &h.main,
            "security_change_passphrase",
            json!({ "current": current, "next": next }),
        )
    };
    assert_eq!(
        kind(change("wrong passphrase", NEW_PASS).unwrap_err()),
        "wrongSecret"
    );
    assert_eq!(kind(change(PASS, "too short").unwrap_err()), "invalidInput");
    change(PASS, NEW_PASS).unwrap();
    h.lock();
    let err = h.unlock(&root, "passphrase", PASS).unwrap_err();
    assert_eq!(kind(err), "wrongSecret");
    h.unlock(&root, "passphrase", NEW_PASS).unwrap();

    let err = call(
        &h.main,
        "security_new_recovery",
        json!({ "passphrase": PASS }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "wrongSecret");
    let code = call(
        &h.main,
        "security_new_recovery",
        json!({ "passphrase": NEW_PASS }),
    )
    .unwrap();
    let code = code.as_str().unwrap();
    assert!(code.starts_with("LIBER-") && code.len() == 75, "{code}");
    h.lock();
    let err = h.unlock(&root, "recovery", &old_code).unwrap_err();
    assert_eq!(kind(err), "wrongSecret");
    h.unlock(&root, "recovery", code).unwrap();
    h.lock();

    // A plain vault has no passphrase to change.
    let plain = h.disk.path().join("Plain");
    call(&h.main, "vault_create", json!({ "path": plain })).unwrap();
    let err = call(
        &h.main,
        "security_new_recovery",
        json!({ "passphrase": NEW_PASS }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    let err = change(NEW_PASS, PASS).unwrap_err();
    assert_eq!(kind(err), "notPermitted");
    // Review M2: nor attachments to decrypt.
    std::fs::write(plain.join("a.pdf"), "%PDF").unwrap();
    let err = call(
        &h.main,
        "attachment_open_decrypted",
        json!({ "path": "a.pdf" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}

/// Review M1: when another device's new recovery code on disk wins the
/// merge (smallest slot id), no code that doesn't open the vault is shown.
#[test]
fn a_new_recovery_code_that_loses_the_merge_is_refused() {
    let h = harness();
    let (root, _code) = h.create("Race");
    let mut conflicts = 0;
    // Each round the disk's code has a tiny id, so ours loses all but ~1/512 of the time.
    for _ in 0..20 {
        let (base, u) = header(&root);
        let disk = loop {
            let mut d = base.clone();
            d.new_recovery(&u).unwrap();
            if recovery_id(&d)[0] == 0 {
                break d;
            }
        };
        std::fs::write(header_path(&root), disk.to_bytes(&u).unwrap()).unwrap();
        match call(
            &h.main,
            "security_new_recovery",
            json!({ "passphrase": PASS }),
        ) {
            Err(e) => {
                assert_eq!(kind(e), "conflict");
                conflicts += 1;
            }
            Ok(code) => {
                // Ours won: it must open the vault.
                let merged =
                    VaultHeader::parse(&std::fs::read(header_path(&root)).unwrap()).unwrap();
                let rc = liber_crypto::RecoveryCode::parse(code.as_str().unwrap()).unwrap();
                merged.unlock(Unlock::Recovery(&rc)).unwrap();
            }
        }
    }
    assert!(conflicts > 0);
}

/// Review I2: a create that fails after the vault was made undoes it, so
/// a retry isn't refused as `notEmpty` (a vault no one has the code for).
#[cfg(unix)]
#[test]
fn a_create_that_fails_after_creating_leaves_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness();
    let root = h.disk.path().join("Half");
    let chmod =
        |m| std::fs::set_permissions(h.config.path(), std::fs::Permissions::from_mode(m)).unwrap();
    // The epoch record can't be written: the step right after the create.
    chmod(0o500);
    let err = call(
        &h.main,
        "vault_create_encrypted",
        json!({ "path": root, "passphrase": PASS }),
    )
    .unwrap_err();
    chmod(0o700);
    assert_eq!(kind(err), "io");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0, "undone");
    let err = call(&h.main, "page_get", json!({ "path": "x.md" })).unwrap_err();
    assert_eq!(kind(err), "noVault");
    call(
        &h.main,
        "vault_create_encrypted",
        json!({ "path": root, "passphrase": PASS }),
    )
    .unwrap();
}

/// Review I4: damaged rollback memory keeps encrypted vaults closed
/// (`damaged`, naming the file) until the user resets it; the damaged file
/// is kept aside, never silently dropped.
#[test]
fn damaged_rollback_memory_fails_closed_until_reset() {
    let h = harness();
    let (root, _code) = h.create("Guarded");
    h.lock();
    let store = h.config.path().join("vault-epochs.json");
    let err = call(&h.main, "security_reset_rollback_memory", json!({})).unwrap_err();
    assert_eq!(kind(err), "notPermitted", "a readable store is never reset");
    std::fs::write(&store, "{ torn").unwrap();
    let err = h.unlock(&root, "passphrase", PASS).unwrap_err();
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains(&store.display().to_string())
    );
    assert_eq!(kind(err), "damaged");
    let fresh = h.disk.path().join("Fresh");
    let err = call(
        &h.main,
        "vault_create_encrypted",
        json!({ "path": fresh, "passphrase": PASS }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "damaged");
    assert!(!fresh.join("liber-vault.json").exists(), "nothing created");

    call(&h.main, "security_reset_rollback_memory", json!({})).unwrap();
    let aside: Vec<_> = std::fs::read_dir(h.config.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("vault-epochs.json.damaged-")
        })
        .collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read(&aside[0]).unwrap(), b"{ torn");
    h.unlock(&root, "passphrase", PASS).unwrap();
}

#[test]
fn decrypted_copy_lives_only_until_lock() {
    let h = harness();
    let (_root, _code) = h.create("Copies");
    h.write("Docs/report.pdf", b"%PDF-1.7 the plaintext");
    let opened: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
    let seen = opened.clone();
    h.state().set_opener(Some(Arc::new(move |p: &Path| {
        seen.lock().unwrap().push(p.to_path_buf());
        Ok(())
    })));

    call(
        &h.main,
        "attachment_open_decrypted",
        json!({ "path": "Docs/report.pdf" }),
    )
    .unwrap();
    let file = opened.lock().unwrap()[0].clone();
    assert_eq!(file.file_name().unwrap(), "report.pdf");
    assert_eq!(std::fs::read(&file).unwrap(), b"%PDF-1.7 the plaintext");
    // `<temp>/liber-<pid>-<random>/…`, the temp root being the test's cache dir.
    let folder = file
        .ancestors()
        .find(|a| a.parent() == Some(h.cache.path()))
        .expect("under the temp root")
        .to_path_buf();
    let name = folder.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with(&format!("liber-{}-", std::process::id())),
        "{name}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&folder).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
    let err = call(
        &h.main,
        "attachment_open_decrypted",
        json!({ "path": "Docs/missing.pdf" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notFound");

    h.lock();
    assert!(!folder.exists(), "wiped on lock");
    let err = call(
        &h.main,
        "attachment_open_decrypted",
        json!({ "path": "Docs/report.pdf" }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "noVault");
}

#[test]
fn recent_list_marks_encrypted() {
    let h = harness();
    let (root, _code) = h.create("Locked one");
    let plain = h.disk.path().join("Plain one");
    call(&h.main, "vault_create", json!({ "path": plain })).unwrap();
    let recent = call(&h.main, "vaults_recent", json!({})).unwrap();
    let find = |p: &Path| {
        let p = std::fs::canonicalize(p).unwrap();
        recent
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["path"] == p.to_string_lossy().as_ref())
            .unwrap()
            .clone()
    };
    let enc = find(&root);
    assert_eq!(enc["encrypted"], true);
    assert!(enc.get("icon").is_none(), "{enc}");
    assert_eq!(find(&plain)["encrypted"], false);
}

#[test]
fn unreadable_entries_are_listed_and_only_they_are_revealed() {
    let h = harness();
    let (root, _code) = h.create("Strays");
    h.lock();
    std::fs::write(root.join("d").join("not-a-name.libere"), b"junk").unwrap();
    h.unlock(&root, "passphrase", PASS).unwrap();
    let list = call(&h.main, "vault_unreadable", json!({})).unwrap();
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 1, "{list:?}");
    assert!(
        list[0]["osPath"]
            .as_str()
            .unwrap()
            .ends_with("not-a-name.libere")
    );
    assert!(!list[0]["reason"].as_str().unwrap().is_empty());
    let err = call(
        &h.main,
        "vault_reveal_unreadable",
        json!({ "osPath": header_path(&root) }),
    )
    .unwrap_err();
    assert_eq!(kind(err), "notPermitted");
}

#[test]
fn asset_range_on_encrypted_vault() {
    let h = harness();
    let (_root, _code) = h.create("Media");
    let wav: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    h.write("a.wav", &wav);
    let state = h.state();
    let r = liber_desktop::asset::serve(&state, "/a.wav", Some("bytes=70000-70099"));
    assert_eq!(r.status, 206);
    assert_eq!(r.body, wav[70_000..70_100]);
    let full = liber_desktop::asset::serve(&state, "/a.wav", None);
    assert_eq!(full.status, 200);
    assert_eq!(full.body.len(), 200_000);
    assert_eq!(full.body, wav);
    let response = full.into_response();
    assert_eq!(response.headers()["Cache-Control"], "no-store");
}

#[test]
fn every_encryption_command_is_main_only() {
    let h = harness();
    let other = WebviewWindowBuilder::new(&h.app, "other", Default::default())
        .build()
        .unwrap();
    for cmd in [
        "vault_create_encrypted",
        "vault_unlock",
        "vault_lock",
        "security_change_passphrase",
        "security_new_recovery",
        "vault_unreadable",
        "vault_reveal_unreadable",
        "attachment_open_decrypted",
        "security_reset_rollback_memory",
    ] {
        if let Err(e) = call(&h.main, cmd, json!({})) {
            assert!(!e.to_string().contains("not allowed"), "{cmd}: {e}");
        }
        let err = call(&other, cmd, json!({})).expect_err(cmd);
        assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
    }
}

// ---- E3 Task 6: recordings in encrypted vaults (spec §4.2) ----

/// Every `.wav` (any case) under `dir`: an encrypted take must never leave one.
fn wavs_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("wav")) {
                out.push(p);
            }
        }
    }
    out
}

impl Harness {
    fn start_take(&self, page: &str, name: &str) -> Value {
        call(
            &self.main,
            "audio_record_start",
            json!({ "page": page, "device": null, "name": name }),
        )
        .unwrap()
    }

    /// The vault file at `path`, decrypted, checked as a valid 16-bit PCM WAV
    /// whose sizes match its length: (channels, samples).
    fn read_wav(&self, path: &str) -> (u16, u32) {
        let session = self.state().session().unwrap();
        let (b, _) = session
            .vault()
            .read(&VaultPath::new(path).unwrap())
            .unwrap();
        let u32_at = |at: usize| u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
        assert_eq!(
            (&b[..4], &b[8..16], &b[36..40]),
            (&b"RIFF"[..], &b"WAVEfmt "[..], &b"data"[..])
        );
        assert_eq!(u32_at(4) as usize, b.len() - 8, "RIFF size");
        assert_eq!(u32_at(40) as usize, b.len() - 44, "data size");
        assert_eq!(u16::from_le_bytes([b[34], b[35]]), 16, "16-bit");
        (u16::from_le_bytes([b[22], b[23]]), u32_at(40) / 2)
    }

    /// What `.liber/recording/` holds in the open vault.
    fn takes_left(&self) -> usize {
        let session = self.state().session().unwrap();
        session
            .vault()
            .children(&VaultPath::new(".liber/recording").unwrap())
            .map_or(0, |c| c.len())
    }
}

#[test]
fn encrypted_take_round_trips() {
    let h = harness();
    h.create("Voice");
    call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "", "name": "Diary" }),
    )
    .unwrap();
    let started = h.start_take("Diary.md", "clip-20261020-101500");
    // About 2 s: more than two 64 KiB chunks, so Stop streams a multi-chunk take.
    std::thread::sleep(std::time::Duration::from_millis(2_000));
    assert_eq!(
        wavs_under(h.cache.path()),
        Vec::<PathBuf>::new(),
        "mid-take"
    );
    assert_eq!(h.takes_left(), 1, "the take is in the vault while it runs");
    let clip = call(
        &h.main,
        "audio_record_stop",
        json!({ "recordingId": started["recordingId"], "page": "Diary.md" }),
    )
    .unwrap();
    let path = clip["path"].as_str().unwrap();
    assert!(path.ends_with("clip-20261020-101500.wav"), "{clip}");
    let (channels, samples) = h.read_wav(path);
    assert_eq!(channels, 1);
    assert!(samples > 65_536, "more than two chunks of sound: {samples}");
    assert_eq!(wavs_under(h.cache.path()), Vec::<PathBuf>::new());
    assert_eq!(
        h.takes_left(),
        0,
        "the take folder goes once the clip is saved"
    );
}

/// Review Focus 5 (spec §6.2): locking mid-take stops it, ends its stream and
/// leaves it in the vault; the next unlock saves it next to its page.
#[test]
fn lock_during_recording_keeps_the_take() {
    let h = harness();
    let (root, _) = h.create("Voice");
    call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "", "name": "Diary" }),
    )
    .unwrap();
    h.start_take("Diary.md", "clip-20261020-101500");
    std::thread::sleep(std::time::Duration::from_millis(500));
    h.lock();
    assert!(
        !h.app
            .state::<liber_desktop::audio_commands::AudioState>()
            .recording()
    );
    assert_eq!(wavs_under(h.cache.path()), Vec::<PathBuf>::new());
    let info = h.unlock(&root, "passphrase", PASS).unwrap();
    let path = "attachments/clip-20261020-101500-recovered.wav";
    assert_eq!(info["recovered"][0]["path"], path, "{info}");
    let (channels, samples) = h.read_wav(path);
    assert_eq!(channels, 1);
    // Lock finishes the stream, so no chunk is lost: about 0.5 s. The
    // real-time fake host's 10 ms sleeps run long, hence 0.4 s at least.
    assert!((19_200..=48_000 * 2).contains(&samples), "{samples}");
    assert_eq!(
        h.takes_left(),
        0,
        "a recovered take leaves the vault's take folder"
    );
    // Indexed like any attachment: a page can link to it.
    let session = h.state().session().unwrap();
    assert!(
        session
            .vault()
            .stat(&VaultPath::new(path).unwrap())
            .unwrap()
            .is_some()
    );
}

/// Carried item (Task 2 M4): the take lives in `.liber/recording/`, so its
/// page's folder can move or go to the archive mid-take and Stop still saves it.
#[test]
fn a_take_survives_its_folder_moving_or_being_archived() {
    let h = harness();
    h.create("Voice");
    call(
        &h.main,
        "entry_create_folder",
        json!({ "parent": "", "name": "Trip" }),
    )
    .unwrap();
    call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "Trip", "name": "Day" }),
    )
    .unwrap();

    // Moved: Stop goes next to where the page is now.
    let started = h.start_take("Trip/Day.md", "clip-20261020-101500");
    std::thread::sleep(std::time::Duration::from_millis(200));
    call(
        &h.main,
        "entry_rename",
        json!({ "from": "Trip", "to": "Journey" }),
    )
    .unwrap();
    let clip = call(
        &h.main,
        "audio_record_stop",
        json!({ "recordingId": started["recordingId"], "page": "Journey/Day.md" }),
    )
    .unwrap();
    assert_eq!(clip["path"], "Journey/attachments/clip-20261020-101500.wav");
    assert!(h.read_wav("Journey/attachments/clip-20261020-101500.wav").1 > 0);

    // Archived, and the UI still names the old page: never lost.
    let started = h.start_take("Journey/Day.md", "clip-20261020-101600");
    std::thread::sleep(std::time::Duration::from_millis(200));
    call(&h.main, "entry_archive", json!({ "path": "Journey" })).unwrap();
    let clip = call(
        &h.main,
        "audio_record_stop",
        json!({ "recordingId": started["recordingId"], "page": "Journey/Day.md" }),
    )
    .unwrap();
    let path = clip["path"].as_str().unwrap();
    assert!(path.ends_with("clip-20261020-101600.wav"), "{clip}");
    assert!(h.read_wav(path).1 > 0);
    assert_eq!(h.takes_left(), 0);
}

/// Spec §4.2 Crash: a take the app died during was never committed — only its
/// hidden temp file holds it. The next unlock salvages its complete chunks
/// into `…-recovered.wav`; at most the last 64 KiB chunk is lost.
#[test]
fn a_crashed_take_is_salvaged_at_unlock() {
    use std::io::Write;
    let h = harness();
    let (root, _) = h.create("Voice");
    call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "", "name": "Diary" }),
    )
    .unwrap();
    let dir = ".liber/recording/clip-20261020-090000-7";
    h.write(
        &format!("{dir}/take.json"),
        json!({ "root": root, "page": "Diary.md" })
            .to_string()
            .as_bytes(),
    );
    let session = h.state().session().unwrap();
    let wav = VaultPath::new(&format!("{dir}/clip-20261020-090000.wav")).unwrap();
    let mut out = session.vault().create_new(&wav).unwrap();
    let stop = std::sync::atomic::AtomicBool::new(false);
    liber_audio::record_stream(
        &liber_audio::SyntheticHost::tone(48_000, 1),
        None,
        &mut out,
        &stop,
        &mut |_, at| {
            if at >= std::time::Duration::from_millis(1_500) {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        },
        liber_audio::MAX_DATA_BYTES,
    )
    .unwrap();
    out.flush().unwrap();
    std::mem::forget(out); // the app dies: never finished
    drop(session);
    h.lock();
    h.unlock(&root, "passphrase", PASS).unwrap();
    // 1.5 s is 144 044 bytes: two whole 64 KiB chunks made it to disk.
    let (_, samples) = h.read_wav("attachments/clip-20261020-090000-recovered.wav");
    assert_eq!(samples, (2 * 65_536 - 44) / 2);
    assert_eq!(h.takes_left(), 0);
}

/// Review I1: a take whose writes fail (a full disk) keeps what reached the
/// disk: Stop can't read it and says it's kept; the next unlock salvages it up
/// to its last complete chunk.
#[test]
fn a_take_whose_writes_fail_is_kept_and_recovered() {
    let h = harness();
    let (root, _) = h.create("Voice");
    call(
        &h.main,
        "entry_create_page",
        json!({ "dir": "", "name": "Diary" }),
    )
    .unwrap();
    let dir = ".liber/recording/clip-20261020-090000-7";
    h.write(
        &format!("{dir}/take.json"),
        json!({ "root": root, "page": "Diary.md" })
            .to_string()
            .as_bytes(),
    );
    let session = h.state().session().unwrap();
    let wav = VaultPath::new(&format!("{dir}/clip-20261020-090000.wav")).unwrap();
    // The disk fills after the header and two chunks.
    let out = session
        .vault()
        .encrypted()
        .unwrap()
        .create_new_failing(&wav, 48 + 2 * (65_536 + 16))
        .unwrap();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let take = liber_desktop::audio_commands::record_into_vault(
        &liber_audio::SyntheticHost::tone(48_000, 1),
        None,
        out,
        &stop,
        &mut |_, at| {
            if at >= std::time::Duration::from_secs(5) {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        },
    )
    .unwrap();
    assert_eq!(take.ended, liber_audio::Ended::WriteFailed);
    drop(session);
    h.lock();
    let info = h.unlock(&root, "passphrase", PASS).unwrap();
    let path = "attachments/clip-20261020-090000-recovered.wav";
    assert_eq!(info["recovered"][0]["path"], path, "{info}");
    assert_eq!(h.read_wav(path).1, (2 * 65_536 - 44) / 2);
    assert_eq!(h.takes_left(), 0);
}
