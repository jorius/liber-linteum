//! Decrypting an encrypted vault in place (encryption UX spec §10): the round
//! trip encrypt → decrypt is the original tree byte for byte, a crash at every
//! phase boundary recovers, wrong secrets are refused (each on its own),
//! nothing of the keys stays, preflight refusals, sync changes, and encrypting
//! again makes a new vault. Temp dirs only; the trash is a fake folder.

use liber_crypto::{Argon2Params, RecoveryCode, Unlock};
use liber_vault::convert::{self, ConvertError, Reason};
use liber_vault::decrypt::{self, CrashPoint, Phase, RecoverOutcome};
use liber_vault::{EncryptedStorage, HEADER_FILE, Storage, VaultKind, VaultPath, vault_kind};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

const PASS: &str = "correct horse battery staple";
const ME: &str = "install-me";
const TINY: Argon2Params = Argon2Params {
    m_kib: 64,
    t: 1,
    p: 1,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Dir,
    File(Vec<u8>, SystemTime),
}

/// Every entry under `dir`, hidden ones included, with bytes and mtimes.
fn snapshot(dir: &Path) -> BTreeMap<String, Node> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Node>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let rel = e
                .path()
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let m = e.path().symlink_metadata().unwrap();
            if m.is_dir() {
                out.insert(rel, Node::Dir);
                walk(base, &e.path(), out);
            } else {
                let bytes = std::fs::read(e.path()).unwrap_or_default();
                out.insert(rel, Node::File(bytes, m.modified().unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn put(root: &Path, rel: &str, body: &[u8], secs: u64) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, body).unwrap();
    let f = std::fs::File::options().write(true).open(&p).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
        .unwrap();
}

/// A realistic vault with no OS junk (encrypt in place doesn't keep junk):
/// nested folders, long names, dot-folders, a large attachment, an empty
/// folder, an NFD name, and a kept sync folder at the root.
fn realistic(root: &Path) {
    let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    put(root, "Notes.md", b"# Notes\n\nhello\n", 1_000_000_000);
    put(
        root,
        "Projects/R\u{e9}sum\u{e9}/Plan.md",
        b"nested",
        1_000_000_100,
    );
    put(
        root,
        &format!("{}.md", "L".repeat(220)),
        b"long name",
        1_000_000_200,
    );
    put(
        root,
        &format!("{}/inside.md", "F".repeat(210)),
        b"in long",
        1_000_000_300,
    );
    put(
        root,
        ".liber/vault.json",
        b"{\"icon\":\"x\"}",
        1_000_000_400,
    );
    put(root, ".obsidian/app.json", b"{}", 1_000_000_500);
    put(root, ".trash/old.md", b"old", 1_000_000_600);
    put(root, ".archive/a.md", b"archived", 1_000_000_700);
    put(root, "attachments/big.bin", &big, 1_000_000_800);
    put(root, "Cafe\u{301}.md", b"nfd", 1_000_000_900);
    put(root, "empty.md", b"", 1_000_000_950);
    std::fs::create_dir_all(root.join("Empty")).unwrap();
    put(root, ".stfolder/marker", b"syncthing", 1_000_001_200);
}

fn make(p: &Path) -> liber_vault::Result<(EncryptedStorage, RecoveryCode)> {
    EncryptedStorage::create_insecure(p, PASS, TINY)
}

fn fake_trash(bin: &Path) -> impl Fn(&Path) -> std::io::Result<()> + use<> {
    let bin = bin.to_path_buf();
    move |p: &Path| {
        std::fs::create_dir_all(&bin)?;
        std::fs::rename(p, bin.join(p.file_name().unwrap()))
    }
}

/// Encrypts `root` in place; its recovery code.
fn encrypt(root: &Path, bin: &Path) -> RecoveryCode {
    let (mut c, code) = convert::begin(root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    convert::stage_and_commit(c).unwrap();
    convert::finish(root, &fake_trash(bin), &|| Ok(())).unwrap();
    code
}

struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
    /// The plain tree before encrypting.
    plain: BTreeMap<String, Node>,
    /// The encrypted tree, as decrypting found it.
    encrypted: BTreeMap<String, Node>,
    code: RecoveryCode,
    vault_id: String,
}

/// A realistic plain vault, encrypted in place.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Vault");
    std::fs::create_dir(&root).unwrap();
    realistic(&root);
    let root = dunce::canonicalize(&root).unwrap();
    // Names come back in NFC: the encrypted format stores them so (E3).
    let plain = snapshot(&root)
        .into_iter()
        .map(|(k, v)| (k.nfc().collect(), v))
        .collect();
    let code = encrypt(&root, &dir.path().join("bin"));
    assert_eq!(vault_kind(&root), VaultKind::Encrypted);
    let (s, _) = EncryptedStorage::unlock(&root, Unlock::Passphrase(PASS)).unwrap();
    let vault_id = hex(&s.vault_id());
    Fixture {
        encrypted: snapshot(&root),
        dir,
        root,
        plain,
        code,
        vault_id,
    }
}

/// `a == b`, saying which entries differ (bytes are too long to print).
#[track_caller]
fn same_tree(a: &BTreeMap<String, Node>, b: &BTreeMap<String, Node>, what: &str) {
    let diff: Vec<_> = a
        .keys()
        .chain(b.keys())
        .filter(|k| a.get(*k) != b.get(*k))
        .map(|k| {
            let show = |n: Option<&Node>| match n {
                None => "missing".to_string(),
                Some(Node::Dir) => "dir".to_string(),
                Some(Node::File(bytes, t)) => format!("{} bytes at {t:?}", bytes.len()),
            };
            format!("{k:?}: {} vs {}", show(a.get(k)), show(b.get(k)))
        })
        .collect();
    assert!(diff.is_empty(), "{what}: {diff:#?}");
}

fn hex(id: &[u8]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

fn storage(f: &Fixture) -> EncryptedStorage {
    decrypt::open_with_both(&f.root, PASS, Some(&f.code)).unwrap()
}

/// Records each id the finish forgets.
type Forgotten = std::sync::Arc<Mutex<Vec<String>>>;

fn forgetter() -> (Forgotten, impl Fn(&str) -> std::io::Result<()>) {
    let got: Forgotten = Default::default();
    let sink = got.clone();
    (got, move |id: &str| {
        sink.lock().unwrap().push(id.to_string());
        Ok(())
    })
}

fn full_run(f: &Fixture, forget: decrypt::Forget<'_>) {
    let mut d = decrypt::begin(storage(f), &[], ME).unwrap();
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    decrypt::stage_and_commit(d).unwrap();
    decrypt::finish(&f.root, forget).unwrap();
}

/// Nothing of the encrypted vault or of the run is left in the folder.
fn assert_no_keys_left(root: &Path) {
    for name in [
        HEADER_FILE,
        "d",
        "README.txt",
        "liber-vault 2.json",
        decrypt::JOURNAL,
        decrypt::STAGING,
        decrypt::RETIRED,
    ] {
        assert!(!root.join(name).exists(), "{name} left behind");
    }
    assert_eq!(vault_kind(root), VaultKind::Plain);
}

#[test]
fn encrypt_then_decrypt_is_the_original_tree_byte_for_byte() {
    let f = fixture();
    // A sync service's copy of the header: it holds the slots too.
    std::fs::copy(f.root.join(HEADER_FILE), f.root.join("liber-vault 2.json")).unwrap();
    let s = storage(&f);
    let pre = decrypt::preflight(&s, &[]).unwrap();
    assert!(pre.blocked.is_empty(), "{:?}", pre.blocked);
    let files = f
        .plain
        .iter()
        .filter(|(k, n)| matches!(n, Node::File(..)) && !k.starts_with(".stfolder"))
        .count() as u64;
    assert_eq!(pre.files, files);
    let mut d = decrypt::begin(s, &[], ME).unwrap();
    let journal = decrypt::read_journal(&f.root).unwrap().unwrap();
    assert_eq!(journal.phase, Phase::Copying);
    assert_eq!(journal.install_id, ME);
    assert_eq!(journal.vault_id, f.vault_id);
    let mut seen = Vec::new();
    decrypt::copy(&mut d, |a, b| seen.push((a, b)), &AtomicBool::new(false)).unwrap();
    assert_eq!(
        seen.last(),
        Some(&(files, files)),
        "progress ends at the total"
    );
    decrypt::stage_and_commit(d).unwrap();
    let (forgotten, forget) = forgetter();
    decrypt::finish(&f.root, &forget).unwrap();
    same_tree(
        &snapshot(&f.root),
        &f.plain,
        "the tree as it was before encrypting",
    );
    assert_no_keys_left(&f.root);
    assert_eq!(*forgotten.lock().unwrap(), vec![f.vault_id.clone()]);
    // Neither secret opens anything any more: there is no header.
    let err = EncryptedStorage::unlock(&f.root, Unlock::Recovery(&f.code)).unwrap_err();
    assert!(
        !matches!(err, liber_vault::VaultError::WrongSecret),
        "{err:?}"
    );
}

#[test]
fn each_secret_is_checked_on_its_own() {
    let f = fixture();
    let other = RecoveryCode::generate();
    let wrong = |pass: &str, code: Option<&RecoveryCode>| match decrypt::open_with_both(
        &f.root, pass, code,
    )
    .err()
    .unwrap()
    {
        ConvertError::WrongSecrets {
            passphrase,
            recovery,
        } => (passphrase, recovery),
        e => panic!("{e:?}"),
    };
    assert_eq!(wrong("not the passphrase", Some(&f.code)), (true, false));
    assert_eq!(wrong(PASS, Some(&other)), (false, true));
    assert_eq!(wrong(PASS, None), (false, true), "a code that didn't parse");
    assert_eq!(wrong("nope", Some(&other)), (true, true));
    same_tree(&snapshot(&f.root), &f.encrypted, "nothing changed");
    decrypt::open_with_both(&f.root, PASS, Some(&f.code)).unwrap();
}

/// Runs a decryption that stops at `at` (as if the app died there), then
/// recovers it as the next open would.
fn crash_then_recover(f: &Fixture, at: CrashPoint) -> RecoverOutcome {
    decrypt::crash_at(Some(at));
    let run = (|| -> convert::Result<()> {
        let mut d = decrypt::begin(storage(f), &[], ME)?;
        decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false))?;
        decrypt::stage_and_commit(d)?;
        decrypt::finish(&f.root, &|_| Ok(()))?;
        Ok(())
    })();
    decrypt::crash_at(None);
    assert!(run.is_err(), "{at:?} should have stopped the run");
    decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap()
}

#[test]
fn a_crash_before_staged_rolls_back_to_the_encrypted_vault() {
    for at in [
        CrashPoint::AfterJournal,
        CrashPoint::AfterStagingDir,
        CrashPoint::Copied(1),
        CrashPoint::Copied(5),
        CrashPoint::Retiring(1),
        CrashPoint::Retiring(2),
        CrashPoint::AllRetired,
    ] {
        let f = fixture();
        assert_eq!(
            crash_then_recover(&f, at),
            RecoverOutcome::RolledBack,
            "{at:?}"
        );
        same_tree(
            &snapshot(&f.root),
            &f.encrypted,
            &format!("{at:?}: byte for byte as it was"),
        );
        // And it still opens with both secrets.
        decrypt::open_with_both(&f.root, PASS, Some(&f.code)).unwrap();
    }
}

#[test]
fn a_crash_from_staged_on_finishes() {
    for at in [
        CrashPoint::AfterStaged,
        CrashPoint::AfterCommitting,
        CrashPoint::Committing(1),
        CrashPoint::Committing(3),
        CrashPoint::AfterCommitted,
        CrashPoint::AfterKeys,
        CrashPoint::AfterCiphertext,
        CrashPoint::AfterEpoch,
        CrashPoint::AfterStagingRemoved,
    ] {
        let f = fixture();
        assert_eq!(
            crash_then_recover(&f, at),
            RecoverOutcome::Finished,
            "{at:?}"
        );
        same_tree(&snapshot(&f.root), &f.plain, &format!("{at:?}"));
        assert_no_keys_left(&f.root);
    }
}

#[test]
fn a_crash_during_the_rollback_is_rolled_back_next_time() {
    let f = fixture();
    decrypt::crash_when(Some(Box::new(|p| {
        matches!(p, CrashPoint::AllRetired | CrashPoint::Unretiring(2))
    })));
    let run = (|| -> convert::Result<()> {
        let mut d = decrypt::begin(storage(&f), &[], ME)?;
        decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false))?;
        decrypt::stage_and_commit(d)
    })();
    assert!(run.is_err());
    assert!(
        decrypt::recover(&f.root, ME, &|_| Ok(())).is_err(),
        "died mid-undo"
    );
    decrypt::crash_at(None);
    assert_eq!(
        decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap(),
        RecoverOutcome::RolledBack
    );
    same_tree(&snapshot(&f.root), &f.encrypted, "as it was");
}

#[test]
fn stop_and_undo_mid_copy_restores_the_encrypted_vault() {
    let f = fixture();
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    let cancel = AtomicBool::new(false);
    let err = decrypt::copy(
        &mut d,
        |done, _| {
            if done == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
        &cancel,
    )
    .err()
    .unwrap();
    assert!(matches!(err, ConvertError::Cancelled), "{err:?}");
    drop(d);
    decrypt::rollback(&f.root).unwrap();
    same_tree(&snapshot(&f.root), &f.encrypted, "as it was");
}

#[test]
fn a_sync_change_mid_copy_rolls_back() {
    let f = fixture();
    // The header, touched as a sync would.
    let victim = f.root.join(HEADER_FILE);
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::copy(
        &mut d,
        |done, _| {
            if done == 1 {
                let f = std::fs::File::options().write(true).open(&victim).unwrap();
                f.set_modified(UNIX_EPOCH + Duration::from_secs(77))
                    .unwrap();
            }
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    let err = decrypt::stage_and_commit(d).err().unwrap();
    assert!(matches!(err, ConvertError::Changed(_)), "{err:?}");
    assert_eq!(
        decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap(),
        RecoverOutcome::RolledBack
    );
    assert!(
        !f.root.join(decrypt::STAGING).exists(),
        "the readable copy is gone"
    );
    assert_eq!(vault_kind(&f.root), VaultKind::Encrypted);
}

#[test]
fn a_newcomer_at_the_root_rolls_back() {
    let f = fixture();
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    put(&f.root, "from-sync.md", b"new", 9);
    let err = decrypt::stage_and_commit(d).err().unwrap();
    assert!(
        matches!(err, ConvertError::Changed(ref n) if n == "from-sync.md"),
        "{err:?}"
    );
    decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap();
    std::fs::remove_file(f.root.join("from-sync.md")).unwrap();
    same_tree(&snapshot(&f.root), &f.encrypted, "as it was");
}

#[test]
fn rollback_never_overwrites_a_colliding_entry() {
    let f = fixture();
    // `README.txt`, then `d/`, moved.
    decrypt::crash_at(Some(CrashPoint::Retiring(2)));
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(decrypt::stage_and_commit(d).is_err());
    decrypt::crash_at(None);
    // A sync puts something under a moved name.
    std::fs::create_dir(f.root.join("d")).unwrap();
    let err = decrypt::recover(&f.root, ME, &|_| Ok(())).err().unwrap();
    assert!(matches!(err, ConvertError::Collision(_)), "{err:?}");
    assert!(
        f.root.join(decrypt::RETIRED).join("d").exists(),
        "nothing moved back"
    );
    assert!(
        decrypt::read_journal(&f.root).unwrap().is_some(),
        "journal kept"
    );
}

#[test]
fn another_devices_journal_is_never_touched() {
    for at in [CrashPoint::Copied(2), CrashPoint::Committing(1)] {
        let f = fixture();
        decrypt::crash_at(Some(at));
        let mut d = decrypt::begin(storage(&f), &[], "install-other").unwrap();
        let run = decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false))
            .and_then(|()| decrypt::stage_and_commit(d));
        decrypt::crash_at(None);
        assert!(run.is_err());
        let before = snapshot(&f.root);
        let out = decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap();
        assert_eq!(out, RecoverOutcome::OtherDevice, "{at:?}");
        assert_eq!(snapshot(&f.root), before, "{at:?}: nothing touched");
        decrypt::recover(&f.root, "install-other", &|_| Ok(())).unwrap();
    }
}

#[test]
fn preflight_blocks_what_decrypting_would_lose_or_break() {
    let f = fixture();
    let s = storage(&f);
    // A folder that would read as an encrypted vault once readable.
    let header = std::fs::read(f.root.join(HEADER_FILE)).unwrap();
    s.create_dir(&VaultPath::new("Inner").unwrap()).unwrap();
    s.replace_atomic(
        &VaultPath::new("Inner/liber-vault.json").unwrap(),
        &mut &header[..],
        liber_vault::Replace::Overwrite,
    )
    .unwrap();
    // A readable file beside the vault with a name the vault has too.
    put(&f.root, "Notes.md", b"beside", 3);
    // A leftover under decrypt's own name.
    std::fs::create_dir(f.root.join(decrypt::STAGING)).unwrap();
    // A name that can't be decrypted.
    put(&f.root, "d/garbage-name.libere", b"LIBER", 4);
    let blocked = decrypt::preflight(&s, &[]).unwrap().blocked;
    let has = |path: &str, reason| {
        blocked
            .iter()
            .any(|b| b.reason == reason && b.path.ends_with(path))
    };
    assert!(has("Inner", Reason::Vault), "{blocked:?}");
    assert!(has("Notes.md", Reason::Taken), "{blocked:?}");
    assert!(has(decrypt::STAGING, Reason::Reserved), "{blocked:?}");
    assert!(
        has("garbage-name.libere", Reason::Unreadable),
        "{blocked:?}"
    );
    let before = snapshot(&f.root);
    let err = decrypt::begin(s, &[], ME).err().unwrap();
    assert!(matches!(err, ConvertError::Blocked(_)), "{err:?}");
    assert_eq!(snapshot(&f.root), before, "nothing changed");
}

#[test]
fn preflight_refuses_whole_folders() {
    let f = fixture();
    let s = storage(&f);
    // A refused folder (home, Desktop, …).
    let err = decrypt::preflight(&s, std::slice::from_ref(&f.root))
        .err()
        .unwrap();
    assert!(matches!(err, ConvertError::Folder(_)), "{err:?}");
    // Part-way through a conversion either way.
    std::fs::write(f.root.join(convert::JOURNAL), b"{}").unwrap();
    assert!(decrypt::preflight(&s, &[]).is_err());
    std::fs::remove_file(f.root.join(convert::JOURNAL)).unwrap();
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    let err = decrypt::preflight(&s, &[]).err().unwrap();
    assert!(matches!(err, ConvertError::Pending), "{err:?}");
    drop(d);
    decrypt::rollback(&f.root).unwrap();
}

#[test]
fn encrypting_refuses_a_folder_part_way_through_decrypting() {
    let f = fixture();
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::crash_at(Some(CrashPoint::AfterStaged));
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(decrypt::stage_and_commit(d).is_err());
    decrypt::crash_at(None);
    // The root reads plain now, but the decryption isn't finished.
    assert_eq!(vault_kind(&f.root), VaultKind::Plain);
    let err = convert::preflight(&f.root, &[]).err().unwrap();
    assert!(matches!(err, ConvertError::Pending), "{err:?}");
    decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap();
    assert!(convert::preflight(&f.root, &[]).unwrap().blocked.is_empty());
}

#[test]
fn encrypting_again_makes_a_new_vault_with_new_keys() {
    let f = fixture();
    full_run(&f, &|_| Ok(()));
    let code = encrypt(&f.root, &f.dir.path().join("bin2"));
    let (s, _) = EncryptedStorage::unlock(&f.root, Unlock::Recovery(&code)).unwrap();
    assert_ne!(hex(&s.vault_id()), f.vault_id, "a new vault id");
    let err = EncryptedStorage::unlock(&f.root, Unlock::Recovery(&f.code)).unwrap_err();
    assert!(
        matches!(err, liber_vault::VaultError::WrongSecret),
        "the old recovery key opens nothing: {err:?}"
    );
    assert_ne!(code.to_display().as_str(), f.code.to_display().as_str());
}

// ---- Review fixes ----

/// Writes `late.md` into the encrypted vault through a second handle, as a
/// sync delivering a new encrypted file would.
fn deliver_late(root: &Path) {
    let (s, _) = EncryptedStorage::unlock(root, Unlock::Passphrase(PASS)).unwrap();
    s.replace_atomic(
        &VaultPath::new("late.md").unwrap(),
        &mut &b"late"[..],
        liber_vault::Replace::CreateOnly,
    )
    .unwrap();
}

/// Review H1: an encrypted file a sync delivers while decrypting is never
/// deleted uncopied, whether it comes before the walk or during the copy.
#[test]
fn a_file_a_sync_delivers_mid_run_is_never_lost() {
    for at in [CrashPoint::AfterRecord, CrashPoint::Copied(1)] {
        let f = fixture();
        let root = f.root.clone();
        let mut once = true;
        decrypt::crash_when(Some(Box::new(move |p| {
            if p == at && once {
                once = false;
                deliver_late(&root);
            }
            false
        })));
        let run = (|| -> convert::Result<()> {
            let mut d = decrypt::begin(storage(&f), &[], ME)?;
            decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false))?;
            decrypt::stage_and_commit(d)
        })();
        decrypt::crash_at(None);
        let err = run
            .err()
            .unwrap_or_else(|| panic!("{at:?}: the run went on"));
        assert!(matches!(err, ConvertError::Changed(_)), "{at:?}: {err:?}");
        assert_eq!(
            decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap(),
            RecoverOutcome::RolledBack
        );
        let s = storage(&f);
        assert_eq!(
            s.read(&VaultPath::new("late.md").unwrap()).unwrap(),
            b"late"
        );
    }
}

/// Review M2: only files that are this vault's header count as its copies:
/// a user's `liber-vault-export.json`, or a folder with a header-copy name,
/// stays.
#[test]
fn a_users_file_named_like_a_header_copy_is_kept() {
    let f = fixture();
    put(&f.root, "liber-vault-export.json", b"{\"mine\":true}", 5);
    put(&f.root, "liber-vault 3.json/inside.md", b"a folder", 6);
    full_run(&f, &|_| Ok(()));
    assert_eq!(
        std::fs::read(f.root.join("liber-vault-export.json")).unwrap(),
        b"{\"mine\":true}"
    );
    assert_eq!(
        std::fs::read(f.root.join("liber-vault 3.json/inside.md")).unwrap(),
        b"a folder"
    );
    assert_no_keys_left(&f.root);
}

/// Review M5: a readable copy that went missing part-way through the commit
/// stops it before anything encrypted is deleted.
#[test]
fn a_readable_copy_missing_mid_commit_deletes_nothing() {
    let f = fixture();
    decrypt::crash_at(Some(CrashPoint::Committing(1)));
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(decrypt::stage_and_commit(d).is_err());
    decrypt::crash_at(None);
    std::fs::remove_dir_all(f.root.join(decrypt::STAGING)).unwrap();
    assert!(decrypt::recover(&f.root, ME, &|_| Ok(())).is_err());
    let retired = f.root.join(decrypt::RETIRED);
    assert!(retired.join(HEADER_FILE).exists(), "the keys stay");
    assert!(retired.join("d").exists(), "the ciphertext stays");
}

/// Review 6a, 6b: copies of the header that reach the root after the stage
/// (a sync conflict) or that a crashed header write left (its temp file) go
/// with the keys.
#[test]
fn every_copy_of_the_header_at_the_root_goes_with_the_keys() {
    let f = fixture();
    let header = std::fs::read(f.root.join(HEADER_FILE)).unwrap();
    std::fs::write(f.root.join(".liber-vault.json.liber-tmp-77-0"), &header).unwrap();
    decrypt::crash_at(Some(CrashPoint::AfterStaged));
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(decrypt::stage_and_commit(d).is_err());
    decrypt::crash_at(None);
    std::fs::write(f.root.join("liber-vault (conflicted copy).json"), &header).unwrap();
    assert_eq!(
        decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap(),
        RecoverOutcome::Finished
    );
    for name in [
        ".liber-vault.json.liber-tmp-77-0",
        "liber-vault (conflicted copy).json",
    ] {
        assert!(!f.root.join(name).exists(), "{name} left behind");
    }
    assert_no_keys_left(&f.root);
}

/// Review 6d: another device's decryption, committed, with its readable tree
/// in place here: this device deletes the keys and the ciphertext too. One
/// whose tree changed since is left for that device.
#[test]
fn another_devices_committed_decryption_is_finished_here_when_the_tree_is_in_place() {
    for edited in [false, true] {
        let f = fixture();
        decrypt::crash_at(Some(CrashPoint::AfterCommitted));
        let mut d = decrypt::begin(storage(&f), &[], "install-other").unwrap();
        decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
        assert!(decrypt::stage_and_commit(d).is_err());
        decrypt::crash_at(None);
        if edited {
            put(&f.root, "Notes.md", b"edited since, longer than before", 9);
        }
        let out = decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap();
        if edited {
            assert_eq!(out, RecoverOutcome::FinishingElsewhere);
            assert!(
                f.root.join(decrypt::RETIRED).exists(),
                "left for that device"
            );
        } else {
            assert_eq!(out, RecoverOutcome::Finished);
            assert_no_keys_left(&f.root);
            same_tree(&snapshot(&f.root), &f.plain, "the readable tree");
        }
    }
}

/// Review 6f: a retired vault's header a sync puts back would make the
/// folder read as an encrypted (or damaged) vault: it goes.
#[test]
fn a_retired_header_put_back_by_a_sync_is_dropped() {
    let f = fixture();
    let header = std::fs::read(f.root.join(HEADER_FILE)).unwrap();
    full_run(&f, &|_| Ok(()));
    std::fs::write(f.root.join(HEADER_FILE), &header).unwrap();
    assert_ne!(vault_kind(&f.root), VaultKind::Plain);
    assert!(!decrypt::drop_retired_header(&f.root, &|_| false).unwrap());
    assert!(f.root.join(HEADER_FILE).exists(), "not retired: untouched");
    let id = f.vault_id.clone();
    assert!(decrypt::drop_retired_header(&f.root, &move |v| v == id).unwrap());
    assert_eq!(vault_kind(&f.root), VaultKind::Plain);
    same_tree(&snapshot(&f.root), &f.plain, "the readable tree");
}

/// Review L10: something a sync puts where the readable tree goes, after the
/// stage, is kept as `<name> (conflict)`: the commit goes on.
#[test]
fn an_entry_in_the_way_of_the_commit_is_kept_aside() {
    let f = fixture();
    decrypt::crash_at(Some(CrashPoint::AfterStaged));
    let mut d = decrypt::begin(storage(&f), &[], ME).unwrap();
    decrypt::copy(&mut d, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(decrypt::stage_and_commit(d).is_err());
    decrypt::crash_at(None);
    put(&f.root, "Notes.md", b"theirs", 11);
    assert_eq!(
        decrypt::recover(&f.root, ME, &|_| Ok(())).unwrap(),
        RecoverOutcome::Finished
    );
    assert_eq!(
        std::fs::read(f.root.join("Notes (conflict).md")).unwrap(),
        b"theirs"
    );
    let mut want = f.plain.clone();
    want.insert(
        "Notes (conflict).md".into(),
        Node::File(b"theirs".to_vec(), UNIX_EPOCH + Duration::from_secs(11)),
    );
    same_tree(&snapshot(&f.root), &want, "ours in place, theirs aside");
    assert_no_keys_left(&f.root);
}

/// Review M4: a take not yet saved as a clip, and an unfinished write under
/// `d/`, block decrypting: neither would survive it.
#[test]
fn preflight_blocks_unsaved_takes_and_unfinished_writes() {
    let f = fixture();
    let s = storage(&f);
    s.create_dir(&VaultPath::new(".liber/recording").unwrap())
        .unwrap();
    s.create_dir(&VaultPath::new(".liber/recording/clip-1").unwrap())
        .unwrap();
    put(&f.root, "d/.0123abcd.liber-tmp", b"LIBER", 4);
    let blocked = decrypt::preflight(&s, &[]).unwrap().blocked;
    assert!(
        blocked
            .iter()
            .any(|b| b.reason == Reason::Recording && b.path == ".liber/recording/clip-1"),
        "{blocked:?}"
    );
    assert!(
        blocked
            .iter()
            .any(|b| b.reason == Reason::Unfinished && b.path == "d/.0123abcd.liber-tmp"),
        "{blocked:?}"
    );
}

/// Review 6c: sync archives at the root are named, never touched.
#[test]
fn preflight_names_sync_archives() {
    let f = fixture();
    put(&f.root, ".stversions/old.libere", b"old", 3);
    let pre = decrypt::preflight(&storage(&f), &[]).unwrap();
    assert_eq!(pre.archives, vec![".stversions".to_string()]);
    full_run(&f, &|_| Ok(()));
    assert_eq!(
        std::fs::read(f.root.join(".stversions/old.libere")).unwrap(),
        b"old"
    );
}
