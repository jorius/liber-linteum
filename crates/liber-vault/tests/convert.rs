//! Encrypting a plain vault in place (encryption UX spec §4.3, §8): the round
//! trip, a crash at every phase boundary and mid-phase, collisions, another
//! device's journal, preflight refusals, sync changes, cancel, a failed trash.
//! Temp dirs only; the trash is a fake folder, never the OS trash.

use liber_crypto::{Argon2Params, Unlock};
use liber_vault::convert::{
    self, Blocked, ConvertError, CrashPoint, Finished, Phase, Reason, RecoverOutcome,
};
use liber_vault::{
    EncryptedStorage, Follow, HEADER_FILE, Storage, VaultKind, VaultPath, vault_kind,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
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

fn long_folder() -> String {
    "F".repeat(210)
}

/// A realistic vault: nested folders, long names, dot-folders, a large
/// attachment, an empty folder, an NFD name, OS junk and sync control files.
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
        &format!("{}/inside.md", long_folder()),
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
    std::fs::create_dir_all(root.join("Empty")).unwrap();
    // Junk anywhere (never copied; it goes to the trash with the originals,
    // the root's too) and kept sync files at the root.
    put(root, "Projects/.DS_Store", b"junk", 1_000_001_000);
    put(root, ".DS_Store", b"root junk", 1_000_001_100);
    put(root, ".stfolder/marker", b"syncthing", 1_000_001_200);
}

/// A fresh `<tmp>/Vault` holding [`realistic`].
fn vault() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Vault");
    std::fs::create_dir(&root).unwrap();
    realistic(&root);
    (dir, dunce::canonicalize(&root).unwrap())
}

fn make(p: &Path) -> liber_vault::Result<(EncryptedStorage, liber_crypto::RecoveryCode)> {
    EncryptedStorage::create_insecure(p, PASS, TINY)
}

/// Moves what it's given into `bin` (never the OS trash).
fn fake_trash(bin: &Path) -> impl Fn(&Path) -> std::io::Result<()> + use<> {
    let bin = bin.to_path_buf();
    move |p: &Path| {
        std::fs::create_dir_all(&bin)?;
        std::fs::rename(p, bin.join(p.file_name().unwrap()))
    }
}

fn no_trash(_: &Path) -> std::io::Result<()> {
    unreachable!("nothing to trash")
}

fn no_index() -> std::io::Result<()> {
    Ok(())
}

fn is_kept_or_junk(rel: &str) -> bool {
    let top = rel.split('/').next().unwrap();
    let last = rel.rsplit('/').next().unwrap();
    [".DS_Store", ".stfolder"].contains(&top) || last == ".DS_Store"
}

/// The plaintext tree a converted vault must hold: the original minus kept
/// and junk entries.
fn content(original: &BTreeMap<String, Node>) -> BTreeMap<String, Node> {
    original
        .iter()
        .filter(|(k, _)| !is_kept_or_junk(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Unlocks `root` and checks every file of `want` reads back byte for byte
/// with its mtime, and every folder exists.
fn assert_encrypted(root: &Path, want: &BTreeMap<String, Node>) {
    assert_eq!(vault_kind(root), VaultKind::Encrypted);
    let (s, _) = EncryptedStorage::unlock(root, Unlock::Passphrase(PASS)).unwrap();
    for (rel, node) in want {
        let vp = VaultPath::new(rel).unwrap();
        let meta = s
            .meta(&vp, Follow::No)
            .unwrap()
            .unwrap_or_else(|| panic!("{rel} missing"));
        match node {
            Node::Dir => assert_eq!(meta.kind, liber_vault::Kind::Dir, "{rel}"),
            Node::File(bytes, mtime) => {
                assert_eq!(&s.read(&vp).unwrap(), bytes, "{rel}");
                let ns = mtime.duration_since(UNIX_EPOCH).unwrap().as_nanos() as i128;
                assert_eq!(meta.mtime_ns, ns, "{rel}: mtime kept");
            }
        }
    }
    // Nothing more than `want` at the top (junk and kept names weren't copied).
    let mut tops: Vec<String> = s
        .children(&VaultPath::root())
        .unwrap()
        .into_iter()
        .map(|c| match c {
            liber_vault::Child::Entry { name, .. } => name.nfc().collect(),
            liber_vault::Child::Unreadable(m) => panic!("unreadable {m}"),
        })
        .collect();
    tops.sort();
    let mut want_tops: Vec<String> = want
        .keys()
        .filter(|k| !k.contains('/'))
        .map(|k| k.nfc().collect())
        .collect();
    want_tops.sort();
    assert_eq!(tops, want_tops);
}

/// The kept entries still at the root, untouched; no conversion leftovers.
fn assert_kept_and_clean(root: &Path, original: &BTreeMap<String, Node>) {
    let now = snapshot(root);
    for (rel, node) in original {
        if rel.starts_with(".stfolder") {
            assert_eq!(now.get(rel), Some(node), "{rel} kept as it was");
        }
    }
    for name in [convert::JOURNAL, convert::STAGING, convert::ORIGINALS] {
        assert!(!root.join(name).exists(), "{name} left behind");
    }
    let tops: Vec<&String> = now.keys().filter(|k| !k.contains('/')).collect();
    assert_eq!(
        tops,
        vec![".stfolder", "README.txt", "d", HEADER_FILE],
        "only the vault and the kept entries at the root"
    );
}

/// The originals the fake trash got, as one folder named for the vault.
fn assert_trashed(bin: &Path, original: &BTreeMap<String, Node>) {
    let names: Vec<_> = std::fs::read_dir(bin)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["Vault (unencrypted originals)".to_string()]);
    let got = snapshot(&bin.join(&names[0]));
    let want: BTreeMap<_, _> = original
        .iter()
        .filter(|(k, _)| {
            let top = k.split('/').next().unwrap();
            top != ".stfolder"
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    assert_eq!(got, want, "every original is in the trash, unchanged");
}

fn full_run(root: &Path, bin: &Path) -> Finished {
    let (mut c, _code) = convert::begin(root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    convert::stage_and_commit(c).unwrap();
    convert::finish(root, &fake_trash(bin), &no_index).unwrap()
}

#[test]
fn a_realistic_vault_round_trips() {
    let (dir, root) = vault();
    let original = snapshot(&root);
    let bin = dir.path().join("bin");
    let (mut c, code) = convert::begin(&root, &[], ME, make).unwrap();
    assert!(code.to_display().starts_with("LIBER-"));
    let journal = convert::read_journal(&root).unwrap().unwrap();
    assert_eq!(journal.phase, Phase::Copying);
    assert_eq!(journal.install_id, ME);
    assert_eq!(journal.version, 1);
    let hex: String = c.vault_id().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(journal.vault_id.as_deref(), Some(hex.as_str()));
    let mut seen = Vec::new();
    convert::copy(&mut c, |d, t| seen.push((d, t)), &AtomicBool::new(false)).unwrap();
    let files = content(&original)
        .values()
        .filter(|n| matches!(n, Node::File(..)))
        .count() as u64;
    assert_eq!(
        seen.last(),
        Some(&(files, files)),
        "progress ends at the total"
    );
    convert::stage_and_commit(c).unwrap();
    assert_eq!(
        convert::finish(&root, &fake_trash(&bin), &no_index).unwrap(),
        Finished::Done
    );
    assert_encrypted(&root, &content(&original));
    assert_kept_and_clean(&root, &original);
    assert_trashed(&bin, &original);
    // The code shown at begin opens the converted vault.
    EncryptedStorage::unlock(&root, Unlock::Recovery(&code)).unwrap();
}

#[test]
fn the_index_cache_is_dropped_before_the_originals_go() {
    let (dir, root) = vault();
    let bin = dir.path().join("bin");
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    convert::stage_and_commit(c).unwrap();
    let order = std::sync::Mutex::new(Vec::new());
    let trash = |p: &Path| {
        order.lock().unwrap().push("trash");
        fake_trash(&bin)(p)
    };
    let drop_index = || {
        order.lock().unwrap().push("index");
        Ok(())
    };
    convert::finish(&root, &trash, &drop_index).unwrap();
    assert_eq!(*order.lock().unwrap(), vec!["index", "trash"]);
}

/// Runs a conversion that stops at `at` (as if the app died there), then
/// recovers it as the next open would.
fn crash_then_recover(
    at: CrashPoint,
) -> (
    tempfile::TempDir,
    PathBuf,
    BTreeMap<String, Node>,
    RecoverOutcome,
) {
    let (dir, root) = vault();
    let original = snapshot(&root);
    let bin = dir.path().join("bin");
    convert::crash_at(Some(at));
    let run = (|| -> convert::Result<()> {
        let (mut c, _) = convert::begin(&root, &[], ME, make)?;
        convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false))?;
        convert::stage_and_commit(c)?;
        convert::finish(&root, &fake_trash(&bin), &no_index)?;
        Ok(())
    })();
    convert::crash_at(None);
    assert!(run.is_err(), "{at:?} should have stopped the run");
    let out = convert::recover(&root, ME, &fake_trash(&bin), &no_index).unwrap();
    (dir, root, original, out)
}

#[test]
fn a_crash_before_staged_rolls_back_byte_for_byte() {
    for at in [
        CrashPoint::AfterJournal,
        CrashPoint::Staging(1),
        CrashPoint::Staging(4),
        CrashPoint::AllMoved,
    ] {
        let (_dir, root, original, out) = crash_then_recover(at);
        assert_eq!(out, RecoverOutcome::RolledBack, "{at:?}");
        assert_eq!(snapshot(&root), original, "{at:?}: the tree as it was");
    }
}

#[test]
fn a_crash_mid_copy_rolls_back_byte_for_byte() {
    let (_dir, root) = vault();
    let original = snapshot(&root);
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    let cancel = AtomicBool::new(false);
    let err = convert::copy(
        &mut c,
        |d, t| {
            if d * 2 >= t {
                cancel.store(true, Ordering::Relaxed);
            }
        },
        &cancel,
    )
    .unwrap_err();
    assert!(matches!(err, ConvertError::Cancelled), "{err:?}");
    drop(c); // the app died here
    let out = convert::recover(&root, ME, &no_trash, &no_index).unwrap();
    assert_eq!(out, RecoverOutcome::RolledBack);
    assert_eq!(snapshot(&root), original);
}

#[test]
fn stop_and_undo_mid_copy_restores_the_vault() {
    let (_dir, root) = vault();
    let original = snapshot(&root);
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    let cancel = AtomicBool::new(false);
    let mut n = 0;
    let err = convert::copy(
        &mut c,
        |_, _| {
            n += 1;
            if n == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
        &cancel,
    )
    .unwrap_err();
    assert!(matches!(err, ConvertError::Cancelled));
    drop(c);
    convert::rollback(&root).unwrap();
    assert_eq!(snapshot(&root), original);
}

#[test]
fn a_crash_from_staged_on_finishes() {
    for at in [
        CrashPoint::AfterStaged,
        CrashPoint::AfterData,
        CrashPoint::AfterReadme,
        CrashPoint::AfterHeader,
        CrashPoint::AfterCommitted,
        CrashPoint::AfterIndex,
        CrashPoint::AfterVisibleRename,
        CrashPoint::AfterTrash,
        CrashPoint::AfterStagingRemoved,
    ] {
        let (dir, root, original, out) = crash_then_recover(at);
        assert_eq!(out, RecoverOutcome::Finished, "{at:?}");
        assert_encrypted(&root, &content(&original));
        assert_kept_and_clean(&root, &original);
        assert_trashed(&dir.path().join("bin"), &original);
    }
}

#[test]
fn rollback_never_overwrites_a_colliding_entry() {
    let (dir, root) = vault();
    convert::crash_at(Some(CrashPoint::Staging(2)));
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(convert::stage_and_commit(c).is_err());
    convert::crash_at(None);
    // A sync puts something back under a moved name.
    let moved = std::fs::read_dir(root.join(convert::ORIGINALS))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .next()
        .unwrap();
    let theirs = root.join(&moved);
    let before_plain = snapshot(&root.join(convert::ORIGINALS));
    if root.join(convert::ORIGINALS).join(&moved).is_dir() {
        std::fs::create_dir(&theirs).unwrap();
    } else {
        std::fs::write(&theirs, b"theirs").unwrap();
    }
    let err =
        convert::recover(&root, ME, &fake_trash(&dir.path().join("bin")), &no_index).unwrap_err();
    assert!(matches!(err, ConvertError::Collision(_)), "{err:?}");
    assert_eq!(snapshot(&root.join(convert::ORIGINALS)), before_plain);
    assert!(theirs.exists());
    assert!(
        convert::read_journal(&root).unwrap().is_some(),
        "journal kept"
    );
}

#[test]
fn roll_forward_never_overwrites_a_colliding_entry() {
    let (dir, root) = vault();
    convert::crash_at(Some(CrashPoint::AfterStaged));
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(convert::stage_and_commit(c).is_err());
    convert::crash_at(None);
    put(&root, "d/theirs.md", b"theirs", 5);
    let staged = snapshot(&root.join(convert::STAGING));
    let err =
        convert::recover(&root, ME, &fake_trash(&dir.path().join("bin")), &no_index).unwrap_err();
    assert!(matches!(err, ConvertError::Collision(_)), "{err:?}");
    assert_eq!(snapshot(&root.join(convert::STAGING)), staged);
    assert_eq!(std::fs::read(root.join("d/theirs.md")).unwrap(), b"theirs");
}

#[test]
fn another_devices_journal_is_never_touched() {
    let (dir, root) = vault();
    for at in [CrashPoint::Staging(2), CrashPoint::AfterData] {
        convert::crash_at(Some(at));
        let (mut c, _) = convert::begin(&root, &[], "install-other", make).unwrap();
        convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
        assert!(convert::stage_and_commit(c).is_err());
        convert::crash_at(None);
        let before = snapshot(&root);
        let bin = dir.path().join("bin");
        let out = convert::recover(&root, ME, &fake_trash(&bin), &no_index).unwrap();
        assert_eq!(out, RecoverOutcome::OtherDevice, "{at:?}");
        assert_eq!(snapshot(&root), before, "{at:?}: nothing touched");
        // Its own device recovers it.
        convert::recover(&root, "install-other", &fake_trash(&bin), &no_index).unwrap();
    }
}

fn blocked_of(root: &Path) -> Vec<Blocked> {
    convert::preflight(root, &[]).unwrap().blocked
}

/// Preflight and begin refuse `root` for `reason` at `path`, changing nothing.
fn assert_refused(root: &Path, path: &str, reason: Reason) {
    let before = snapshot(root);
    let blocked = blocked_of(root);
    assert!(
        blocked.contains(&Blocked {
            path: path.into(),
            reason
        }),
        "{path} {reason:?} not in {blocked:?}"
    );
    let err = convert::begin(root, &[], ME, make).err().unwrap();
    assert!(matches!(err, ConvertError::Blocked(_)), "{err:?}");
    assert_eq!(snapshot(root), before, "{path}: nothing changed");
}

fn plain_root() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("V");
    std::fs::create_dir(&root).unwrap();
    put(&root, "ok.md", b"fine", 7);
    (dir, root)
}

#[test]
fn preflight_counts_files_and_bytes() {
    let (_dir, root) = vault();
    let pre = convert::preflight(&root, &[]).unwrap();
    assert!(pre.blocked.is_empty(), "{:?}", pre.blocked);
    let want = content(&snapshot(&root));
    let files: Vec<_> = want
        .values()
        .filter_map(|n| match n {
            Node::File(b, _) => Some(b.len() as u64),
            Node::Dir => None,
        })
        .collect();
    assert_eq!(pre.files, files.len() as u64);
    assert_eq!(pre.bytes, files.iter().sum::<u64>());
}

#[test]
fn preflight_refuses_reserved_git_and_cloud_entries() {
    for (path, reason) in [
        (".liber-plain", Reason::Reserved),
        (".liber-converting", Reason::Reserved),
        (".git", Reason::Git),
        ("sub/.git", Reason::Git),
    ] {
        let (_d, root) = plain_root();
        std::fs::create_dir_all(root.join(path)).unwrap();
        assert_refused(&root, path, reason);
    }
    let (_d, root) = plain_root();
    put(&root, ".notes.md.icloud", b"stub", 1);
    assert_refused(&root, ".notes.md.icloud", Reason::Cloud);
    // A journal alone, with nothing else of a conversion: refused, not acted on.
    let (_d, root) = plain_root();
    put(&root, ".liber-convert.json", b"{}", 1);
    let before = snapshot(&root);
    assert!(convert::preflight(&root, &[]).is_err() || !blocked_of(&root).is_empty());
    assert_eq!(snapshot(&root), before);
}

#[cfg(unix)]
#[test]
fn preflight_refuses_bad_names_links_and_unreadable_files() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, root) = plain_root();
    put(&root, "a:b.md", b"x", 1);
    assert_refused(&root, "a:b.md", Reason::BadChar);
    let (_d, root) = plain_root();
    put(&root, "sub/a\\b.md", b"x", 1);
    assert_refused(&root, "sub/a\\b.md", Reason::BadChar);
    let (_d, root) = plain_root();
    std::os::unix::fs::symlink(root.join("ok.md"), root.join("link.md")).unwrap();
    assert_refused(&root, "link.md", Reason::Symlink);
    let (_d, root) = plain_root();
    put(&root, "secret.md", b"x", 1);
    std::fs::set_permissions(root.join("secret.md"), std::fs::Permissions::from_mode(0o0)).unwrap();
    if std::fs::File::open(root.join("secret.md")).is_err() {
        assert_refused(&root, "secret.md", Reason::Unreadable);
    }
    std::fs::set_permissions(
        root.join("secret.md"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let (_d, root) = plain_root();
    let _sock = std::os::unix::net::UnixListener::bind(root.join("s.sock")).unwrap();
    assert_refused(&root, "s.sock", Reason::Special);
}

#[test]
fn preflight_refuses_twins_long_and_non_utf8_names_where_the_disk_allows_them() {
    let (_d, root) = plain_root();
    put(&root, "n.md", b"lower", 1);
    if !root.join("N.md").exists() {
        put(&root, "N.md", b"upper", 1);
        let blocked = blocked_of(&root);
        assert!(
            blocked.iter().any(|b| b.reason == Reason::Twin),
            "{blocked:?}"
        );
    } else {
        println!("SKIP case twins: case-insensitive disk");
    }
    let (_d, root) = plain_root();
    let long = "\u{e9}".repeat(130) + ".md"; // 263 bytes once NFC-encoded
    if std::fs::write(root.join(&long), b"x").is_ok() {
        assert_refused(&root, &long, Reason::LongName);
    } else {
        println!("SKIP long name: the disk refuses it");
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let (_d, root) = plain_root();
        let bad = std::ffi::OsStr::from_bytes(b"bad\xff.md");
        if std::fs::write(root.join(bad), b"x").is_ok() {
            let blocked = blocked_of(&root);
            assert!(
                blocked.iter().any(|b| b.reason == Reason::NotUtf8),
                "{blocked:?}"
            );
        } else {
            println!("SKIP non-UTF-8 name: the disk refuses it");
        }
    }
}

#[test]
fn preflight_refuses_whole_folders() {
    let (_d, root) = plain_root();
    let err = convert::preflight(&root, std::slice::from_ref(&root)).unwrap_err();
    assert!(matches!(err, ConvertError::Folder(_)), "{err:?}");
    let err = convert::preflight(Path::new("/"), &[]).unwrap_err();
    assert!(matches!(err, ConvertError::Folder(_)), "{err:?}");
    // Already encrypted, and damaged.
    let dir = tempfile::tempdir().unwrap();
    make(dir.path()).unwrap();
    let err = convert::preflight(dir.path(), &[]).unwrap_err();
    assert!(matches!(err, ConvertError::Refused(_)), "{err:?}");
    std::fs::remove_dir_all(dir.path().join("d")).unwrap();
    assert!(convert::preflight(dir.path(), &[]).is_err());
}

#[test]
fn a_changed_file_aborts_and_rolls_back() {
    let (_dir, root) = vault();
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    put(
        &root,
        "Projects/R\u{e9}sum\u{e9}/Plan.md",
        b"edited by sync",
        1_500_000_000,
    );
    let changed = snapshot(&root);
    let err = convert::stage_and_commit(c).unwrap_err();
    assert!(matches!(err, ConvertError::Changed(_)), "{err:?}");
    assert_eq!(
        convert::recover(&root, ME, &no_trash, &no_index).unwrap(),
        RecoverOutcome::RolledBack
    );
    let mut now = snapshot(&root);
    let mut want = changed;
    for m in [&mut now, &mut want] {
        m.retain(|k, _| !k.starts_with(".liber-"));
    }
    assert_eq!(now, want);
    assert!(convert::read_journal(&root).unwrap().is_none());
}

#[test]
fn a_new_entry_aborts_but_new_os_junk_does_not() {
    let (_dir, root) = vault();
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    put(&root, "new.md", b"from sync", 1);
    let err = convert::stage_and_commit(c).unwrap_err();
    assert!(matches!(err, ConvertError::Changed(_)), "{err:?}");
    convert::rollback(&root).unwrap();
    assert_eq!(std::fs::read(root.join("new.md")).unwrap(), b"from sync");

    let (dir, root) = vault();
    let original = snapshot(&root);
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    put(&root, "attachments/.DS_Store", b"finder", 1);
    convert::stage_and_commit(c).unwrap();
    convert::finish(&root, &fake_trash(&dir.path().join("bin")), &no_index).unwrap();
    assert_encrypted(&root, &content(&original));
}

#[test]
fn a_failed_trash_keeps_the_originals_and_the_vault_opens() {
    let (dir, root) = vault();
    let original = snapshot(&root);
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    convert::stage_and_commit(c).unwrap();
    let broken = |_: &Path| Err(std::io::Error::other("no trash here"));
    let out = convert::finish(&root, &broken, &no_index).unwrap();
    assert!(
        matches!(out, Finished::TrashPending(ref m) if m.contains("no trash here")),
        "{out:?}"
    );
    assert_eq!(
        convert::read_journal(&root).unwrap().unwrap().phase,
        Phase::TrashPending
    );
    assert!(!root.join(convert::STAGING).exists());
    let kept = snapshot(&root.join(convert::ORIGINALS));
    assert_eq!(kept, {
        let mut m = original.clone();
        m.retain(|k, _| !k.starts_with(".stfolder"));
        m
    });
    // The encrypted vault tolerates the journal, the originals and the kept
    // entries at its root.
    assert_encrypted(&root, &content(&original));
    // Every later open reports it; nothing more happens on its own.
    assert_eq!(
        convert::recover(&root, ME, &broken, &no_index).unwrap(),
        RecoverOutcome::TrashPending
    );
    assert_eq!(
        convert::recover(&root, "install-other", &broken, &no_index).unwrap(),
        RecoverOutcome::TrashPending
    );
    // "Show in Finder" gives it its visible name.
    let shown = convert::show_originals(&root).unwrap();
    assert_eq!(shown, root.join("Vault (unencrypted originals)"));
    assert_eq!(snapshot(&shown), kept);
    // "Move to Trash" again.
    let bin = dir.path().join("bin");
    assert_eq!(
        convert::finish(&root, &fake_trash(&bin), &no_index).unwrap(),
        Finished::Done
    );
    assert_kept_and_clean(&root, &original);
    assert_trashed(&bin, &original);
}

#[test]
fn a_full_run_leaves_only_the_vault() {
    let (dir, root) = vault();
    let original = snapshot(&root);
    assert_eq!(full_run(&root, &dir.path().join("bin")), Finished::Done);
    assert_eq!(
        convert::recover(&root, ME, &no_trash, &no_index).unwrap(),
        RecoverOutcome::Nothing
    );
    assert_kept_and_clean(&root, &original);
}

#[test]
fn a_users_own_vault_json_readme_or_d_folder_are_just_originals() {
    // Each alone (both together read as a damaged encrypted vault, E3).
    for own in [
        &[(HEADER_FILE, "not a header"), ("README.txt", "my readme")][..],
        &[("d/mine.md", "my d folder")],
    ] {
        let (dir, root) = vault();
        for (rel, body) in own {
            put(&root, rel, body.as_bytes(), 3);
        }
        let original = snapshot(&root);
        assert_eq!(vault_kind(&root), VaultKind::Plain);
        full_run(&root, &dir.path().join("bin"));
        assert_encrypted(&root, &content(&original));
        assert_trashed(&dir.path().join("bin"), &original);
    }
}

/// The xcheck reader (mirrors `encrypted_xcheck.rs`) decrypts a converted vault.
#[test]
fn a_converted_vault_decrypts_with_the_python_reader() {
    let Some(py) = std::env::var("LIBER_XCHECK_PY")
        .ok()
        .filter(|p| !p.is_empty())
    else {
        println!("SKIP: set LIBER_XCHECK_PY to a python3 with cryptography >= 44");
        return;
    };
    let (dir, root) = vault();
    let original = snapshot(&root);
    full_run(&root, &dir.path().join("bin"));
    let want: BTreeMap<String, String> = content(&original)
        .into_iter()
        .map(|(k, v)| {
            let v = match v {
                Node::Dir => "dir".to_string(),
                Node::File(b, _) => b.iter().map(|x| format!("{x:02x}")).collect(),
            };
            (k.nfc().collect(), v)
        })
        .collect();
    let expected = dir.path().join("expected.json");
    std::fs::write(&expected, serde_json::to_vec(&want).unwrap()).unwrap();
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../liber-crypto/tests/xcheck/xcheck.py");
    let out = std::process::Command::new(py)
        .arg("-I")
        .arg(script)
        .arg("vault")
        .arg(&root)
        .arg(PASS)
        .arg(&expected)
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    match out.status.code() {
        Some(0) => print!("{text}"),
        Some(77) => println!("SKIP: {}", text.trim()),
        _ => panic!("xcheck failed ({}):\n{text}", out.status),
    }
}

// ---- Review fix round ----

fn case_insensitive(dir: &Path) -> bool {
    std::fs::write(dir.join("CaseProbe"), b"").unwrap();
    let ci = dir.join("caseprobe").exists();
    std::fs::remove_file(dir.join("CaseProbe")).unwrap();
    ci
}

/// Review C1 (the reviewer's probes): a name that matches a reserved one
/// only by case is refused, never deleted, scattered or truncated.
#[test]
fn a_lookalike_of_a_reserved_name_is_refused_and_never_touched() {
    for (entry, file) in [
        (".Liber-Converting", Some("precious.md")),
        (".Liber-Plain", Some("inner.md")),
        (".LIBER-CONVERT.json.tmp", None),
        (".Liber-Convert.json", None),
    ] {
        let (_d, root) = plain_root();
        match file {
            Some(f) => put(&root, &format!("{entry}/{f}"), b"only copy", 2),
            None => put(&root, entry, b"mine", 2),
        }
        let before = snapshot(&root);
        let blocked = blocked_of(&root);
        assert!(
            blocked.contains(&Blocked {
                path: entry.into(),
                reason: Reason::Reserved
            }),
            "{entry}: {blocked:?}"
        );
        let err = convert::begin(&root, &[], ME, make).err().unwrap();
        assert!(matches!(err, ConvertError::Blocked(_)), "{entry}: {err:?}");
        let out = convert::recover(&root, ME, &no_trash, &no_index).unwrap();
        assert_eq!(out, RecoverOutcome::Nothing, "{entry}");
        assert_eq!(snapshot(&root), before, "{entry}: untouched");
    }
}

/// Review C1 backstop: even with a journal (preflight bypassed), rollback
/// only removes or empties folders it can prove are its own.
#[test]
fn rollback_leaves_folders_it_did_not_create() {
    let (_d, root) = plain_root();
    put(&root, ".Liber-Converting/precious.md", b"only copy", 2);
    put(&root, ".Liber-Plain/inner.md", b"mine", 2);
    let journal = convert::Journal {
        version: 1,
        phase: Phase::Copying,
        started: 1,
        install_id: ME.into(),
        vault_id: None,
        staging_created: false,
        plain_created: false,
    };
    std::fs::write(
        root.join(convert::JOURNAL),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    let mut want = snapshot(&root);
    want.remove(convert::JOURNAL);
    let ci = case_insensitive(_d.path());
    assert_eq!(
        convert::recover(&root, ME, &no_trash, &no_index).unwrap(),
        RecoverOutcome::RolledBack
    );
    assert_eq!(snapshot(&root), want, "case-insensitive disk: {ci}");
    // An empty staging folder a crash left before the journal said so goes.
    std::fs::create_dir(root.join(convert::STAGING)).unwrap_or_default();
    if !ci {
        std::fs::write(
            root.join(convert::JOURNAL),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        convert::rollback(&root).unwrap();
        assert!(!root.join(convert::STAGING).exists());
    }
}

/// Review I5: a vault name near the limit still gets a visible originals name.
#[test]
fn a_long_vault_name_still_trashes_and_shows_its_originals() {
    for broken in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("N".repeat(240));
        std::fs::create_dir(&root).unwrap();
        put(&root, "Notes.md", b"hello", 1);
        let root = dunce::canonicalize(root).unwrap();
        let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
        convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
        convert::stage_and_commit(c).unwrap();
        let bin = dir.path().join("bin");
        let fail = |_: &Path| Err(std::io::Error::other("no trash"));
        let ok = fake_trash(&bin);
        let trash: &dyn Fn(&Path) -> std::io::Result<()> = if broken { &fail } else { &ok };
        let out = convert::finish(&root, trash, &no_index).unwrap();
        if broken {
            assert!(matches!(out, Finished::TrashPending(_)), "{out:?}");
            let shown = convert::show_originals(&root).unwrap();
            let name = shown.file_name().unwrap().to_string_lossy().into_owned();
            assert!(
                name.len() <= 255 && name.ends_with(" (unencrypted originals)"),
                "{name}"
            );
            assert!(shown.join("Notes.md").exists());
        } else {
            assert_eq!(out, Finished::Done);
            let got: Vec<_> = std::fs::read_dir(&bin).unwrap().collect();
            assert_eq!(got.len(), 1);
        }
    }
}

/// Review M1: an entry that appears at the root while the originals move
/// aborts before `staged`, and the rollback leaves it there.
#[test]
fn a_newcomer_at_the_root_during_staging_rolls_back() {
    let (_dir, root) = vault();
    let original = snapshot(&root);
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    let r = root.clone();
    convert::crash_when(Some(Box::new(move |p| {
        if p == CrashPoint::Staging(3) {
            std::fs::write(r.join("newcomer.md"), b"from sync").unwrap();
        }
        false
    })));
    let err = convert::stage_and_commit(c).unwrap_err();
    convert::crash_when(None);
    assert!(
        matches!(err, ConvertError::Changed(ref p) if p == "newcomer.md"),
        "{err:?}"
    );
    assert_eq!(
        convert::recover(&root, ME, &no_trash, &no_index).unwrap(),
        RecoverOutcome::RolledBack
    );
    let mut now = snapshot(&root);
    assert!(now.remove("newcomer.md").is_some());
    assert_eq!(now, original);
}

/// Review M2: same size and mtime, different file (unix: inode or ctime).
#[cfg(unix)]
#[test]
fn a_file_rewritten_with_the_same_size_and_mtime_is_a_change() {
    let (_dir, root) = vault();
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    put(&root, "Notes.md", b"# Notes\n\nHELLO\n", 1_000_000_000);
    let err = convert::stage_and_commit(c).unwrap_err();
    assert!(
        matches!(err, ConvertError::Changed(ref p) if p == "Notes.md"),
        "{err:?}"
    );
    convert::rollback(&root).unwrap();
}

/// Review M8: more crash points, and a rollback that itself crashes halfway.
#[test]
fn more_crash_points_recover() {
    for (at, want) in [
        (CrashPoint::AfterStagingDir, RecoverOutcome::RolledBack),
        (CrashPoint::AfterStagingCreated, RecoverOutcome::RolledBack),
        (CrashPoint::AfterCommitting, RecoverOutcome::Finished),
    ] {
        let (dir, root, original, out) = crash_then_recover(at);
        assert_eq!(out, want, "{at:?}");
        if want == RecoverOutcome::RolledBack {
            assert_eq!(snapshot(&root), original, "{at:?}");
        } else {
            assert_encrypted(&root, &content(&original));
            assert_trashed(&dir.path().join("bin"), &original);
        }
    }
    let (_dir, root) = vault();
    let original = snapshot(&root);
    convert::crash_at(Some(CrashPoint::Staging(5)));
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(convert::stage_and_commit(c).is_err());
    convert::crash_at(Some(CrashPoint::Unstaging(2)));
    assert!(convert::recover(&root, ME, &no_trash, &no_index).is_err());
    convert::crash_at(None);
    assert_eq!(
        convert::recover(&root, ME, &no_trash, &no_index).unwrap(),
        RecoverOutcome::RolledBack
    );
    assert_eq!(snapshot(&root), original);
}

/// Judgment change: another device's committed conversion doesn't block
/// opening (the vault is safe), and nothing is touched.
#[test]
fn another_devices_committed_conversion_opens() {
    let (_dir, root) = vault();
    convert::crash_at(Some(CrashPoint::AfterCommitted));
    let (mut c, _) = convert::begin(&root, &[], "install-other", make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(convert::stage_and_commit(c).is_err());
    convert::crash_at(None);
    let before = snapshot(&root);
    assert_eq!(
        convert::recover(&root, ME, &no_trash, &no_index).unwrap(),
        RecoverOutcome::FinishingElsewhere
    );
    assert_eq!(snapshot(&root), before);
    assert_eq!(vault_kind(&root), VaultKind::Encrypted);
}

/// Final round N1: Finder (or Explorer) writes the root's `.DS_Store`
/// (`Thumbs.db`) again after it was staged. Both copies are OS junk: the
/// staged one goes back in its place and the vault is as it was.
#[test]
fn rollback_puts_back_os_junk_the_os_wrote_again() {
    let (dir, root) = vault();
    std::fs::write(root.join("Thumbs.db"), b"thumbs").unwrap();
    let original = snapshot(&root);
    convert::crash_at(Some(CrashPoint::AllMoved));
    let (mut c, _) = convert::begin(&root, &[], ME, make).unwrap();
    convert::copy(&mut c, |_, _| {}, &AtomicBool::new(false)).unwrap();
    assert!(convert::stage_and_commit(c).is_err());
    convert::crash_at(None);
    std::fs::write(root.join(".DS_Store"), b"finder again").unwrap();
    std::fs::write(root.join("Thumbs.db"), b"explorer again").unwrap();
    let out = convert::recover(&root, ME, &fake_trash(&dir.path().join("bin")), &no_index).unwrap();
    assert_eq!(out, RecoverOutcome::RolledBack);
    let mut now = snapshot(&root);
    // Mtimes of the two junk files aside (one copy was discarded), as it was.
    for junk in [".DS_Store", "Thumbs.db"] {
        assert!(now.remove(junk).is_some(), "{junk} kept");
    }
    let mut want = original.clone();
    want.remove(".DS_Store");
    want.remove("Thumbs.db");
    assert_eq!(now, want);
    assert!(convert::read_journal(&root).unwrap().is_none());
}

/// Final review I3 (a): a vault of its own inside the folder (encrypted, or
/// damaged) is blocked: converting it would turn its header and `d/` into
/// opaque files of the outer vault.
#[test]
fn a_vault_inside_the_folder_is_blocked() {
    let (_dir, root) = plain_root();
    let inner = root.join("Projects/Secret");
    std::fs::create_dir_all(&inner).unwrap();
    make(&inner).unwrap();
    let before = snapshot(&root);
    assert_eq!(
        blocked_of(&root),
        vec![Blocked {
            path: "Projects/Secret".into(),
            reason: Reason::Vault
        }]
    );
    assert!(convert::begin(&root, &[], ME, make).is_err());
    assert_eq!(snapshot(&root), before);
}

/// Final review I3 (b): a folder inside an encrypted vault (its `d/`, or a
/// folder below it) is refused whole: it would trash that vault's ciphertext.
#[test]
fn a_folder_inside_an_encrypted_vault_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("Enc");
    std::fs::create_dir(&vault).unwrap();
    make(&vault).unwrap();
    let sub = vault.join("d").join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("x"), b"ciphertext").unwrap();
    for folder in [vault.join("d"), sub] {
        let before = snapshot(&vault);
        let err = convert::preflight(&folder, &[]).unwrap_err();
        assert!(matches!(err, ConvertError::InsideVault(_)), "{err:?}");
        assert!(convert::begin(&folder, &[], ME, make).is_err());
        assert_eq!(snapshot(&vault), before);
    }
}
