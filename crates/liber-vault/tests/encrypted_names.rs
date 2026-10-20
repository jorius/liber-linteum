//! `EncryptedStorage` (E3 Task 3): long names, sync conflict copies, unreadable
//! entries and the watcher.

use liber_crypto::{Argon2Params, FolderId, NameCodec, StreamWriter, Unlock, VaultHeader};
use liber_testkit::{real_trash_tests_enabled, wait_until};
use liber_vault::{
    Child, EncryptedStorage, HEADER_FILE, RawEvent, Replace, Storage, VaultError, VaultPath,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const PASS: &str = "correct horse battery staple";
const TINY: Argon2Params = Argon2Params {
    m_kib: 64,
    t: 1,
    p: 1,
};

fn vp(s: &str) -> VaultPath {
    if s.is_empty() {
        VaultPath::root()
    } else {
        VaultPath::new(s).unwrap()
    }
}

fn new_vault() -> (tempfile::TempDir, EncryptedStorage) {
    let dir = tempfile::tempdir().unwrap();
    let (storage, _rc) = EncryptedStorage::create_insecure(dir.path(), PASS, TINY).unwrap();
    (dir, storage)
}

fn write(storage: &EncryptedStorage, path: &str, body: &[u8]) {
    storage
        .replace_atomic(&vp(path), &mut &body[..], Replace::CreateOnly)
        .unwrap();
}

/// The listed (readable) names in `dir`, sorted.
fn names(storage: &EncryptedStorage, dir: &str) -> Vec<String> {
    let mut out: Vec<String> = storage
        .children(&vp(dir))
        .unwrap()
        .into_iter()
        .filter_map(|c| match c {
            Child::Entry { name, .. } => Some(name),
            Child::Unreadable(_) => None,
        })
        .collect();
    out.sort();
    out
}

/// The physical names directly in `folder`, sorted.
fn on_disk(folder: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    out.sort();
    out
}

fn unreadable_paths(storage: &EncryptedStorage) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = storage.unreadable().into_iter().map(|(p, _)| p).collect();
    out.sort();
    out
}

/// The current epoch's name codec, unlocked from the header behind the storage's back.
fn with_codec<T>(root: &Path, f: impl FnOnce(&NameCodec<'_>, &liber_crypto::Unlocked) -> T) -> T {
    let header = VaultHeader::parse(&std::fs::read(root.join(HEADER_FILE)).unwrap()).unwrap();
    let u = header.unlock(Unlock::Passphrase(PASS)).unwrap();
    let codec = NameCodec::new(&u.subkeys().name, u.vault_id(), u.epoch());
    f(&codec, &u)
}

#[test]
fn long_names_round_trip() {
    let (dir, storage) = new_vault();
    let d = storage.location().join("d");
    let long = format!("{}.md", "l".repeat(177));
    assert_eq!(long.len(), 180);
    write(&storage, &long, b"long body");
    assert_eq!(storage.read(&vp(&long)).unwrap(), b"long body");
    assert_eq!(names(&storage, ""), std::slice::from_ref(&long));

    let files = on_disk(&d);
    assert_eq!(files.len(), 2, "{files:?}");
    let (h, ext) = files[0].split_once('.').unwrap();
    assert_eq!((h.len(), ext), (32, "liberl"));
    assert_eq!(files[1], format!("{h}.libern"));

    // A fresh unlock reads the name back from the side file.
    let (again, _) = EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).unwrap();
    assert_eq!(names(&again, ""), std::slice::from_ref(&long));

    // Into a folder and back: the side file follows the entry.
    storage.create_dir(&vp("F")).unwrap();
    storage
        .rename(&vp(&long), &vp(&format!("F/{long}")))
        .unwrap();
    assert_eq!(names(&storage, "F"), std::slice::from_ref(&long));
    assert!(on_disk(&d).iter().all(|n| !n.contains(".liber")));
    storage
        .rename(&vp(&format!("F/{long}")), &vp("short.md"))
        .unwrap();
    assert_eq!(storage.read(&vp("short.md")).unwrap(), b"long body");
    let files = on_disk(&d);
    assert_eq!(files.len(), 2, "{files:?}"); // F and short.md
    assert!(
        files
            .iter()
            .all(|n| !n.ends_with(".liberl") && !n.ends_with(".libern"))
    );
    let folder = d.join(files.iter().find(|n| !n.contains('.')).unwrap());
    assert!(
        on_disk(&folder).is_empty(),
        "the side file left with its entry"
    );

    // A long folder name, and a short name renamed to a long one.
    let long_dir = "f".repeat(180);
    storage.create_dir(&vp(&long_dir)).unwrap();
    storage
        .rename(&vp("short.md"), &vp(&format!("{long_dir}/{long}")))
        .unwrap();
    let (again, _) = EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).unwrap();
    assert_eq!(
        again.read(&vp(&format!("{long_dir}/{long}"))).unwrap(),
        b"long body"
    );
    assert!(again.unreadable().is_empty(), "{:?}", again.unreadable());
}

#[test]
fn oversized_side_file_is_unreadable() {
    let (dir, storage) = new_vault();
    let d = storage.location().join("d");
    let long = format!("{}.md", "l".repeat(177));
    write(&storage, &long, b"x");
    let side = on_disk(&d)
        .into_iter()
        .find(|n| n.ends_with(".libern"))
        .unwrap();
    std::fs::write(d.join(&side), vec![b'A'; 4096]).unwrap();
    let (fresh, _) = EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).unwrap();
    assert!(names(&fresh, "").is_empty());
    let entry = d.join(side.replace(".libern", ".liberl"));
    assert_eq!(unreadable_paths(&fresh), [entry]);
    // A side file that doesn't hash to its entry's name is unreadable too.
    std::fs::write(d.join(&side), b"AAAA.libere").unwrap();
    assert!(names(&fresh, "").is_empty());
    assert_eq!(fresh.unreadable().len(), 1);
}

#[test]
fn conflict_copy_is_listed_and_can_be_renamed() {
    let (_dir, storage) = new_vault();
    let d = storage.location().join("d");
    write(&storage, "n.md", b"mine");
    let x = on_disk(&d).remove(0);
    let stem = x.strip_suffix(".libere").unwrap();
    let copy = d.join(format!("{stem} (conflicted copy 2026-10-20).libere"));
    std::fs::copy(d.join(&x), &copy).unwrap();

    let conflict = "n (conflict conflicted copy 2026-10-20).md";
    assert_eq!(names(&storage, ""), [conflict, "n.md"]);
    assert_eq!(storage.read(&vp("n.md")).unwrap(), b"mine");
    assert_eq!(storage.read(&vp(conflict)).unwrap(), b"mine");
    // Writes land on the conflict copy itself.
    storage
        .replace_atomic(&vp(conflict), &mut &b"theirs"[..], Replace::Overwrite)
        .unwrap();
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 2);
    assert_eq!(storage.read(&vp(conflict)).unwrap(), b"theirs");

    storage.rename(&vp(conflict), &vp("n2.md")).unwrap();
    assert_eq!(storage.read(&vp("n2.md")).unwrap(), b"theirs");
    assert_eq!(storage.read(&vp("n.md")).unwrap(), b"mine");
    assert!(!copy.exists(), "the conflict-named physical file is gone");
    assert_eq!(names(&storage, ""), ["n.md", "n2.md"]);
}

#[test]
fn unreadable_entries_are_never_deleted() {
    let (_dir, storage) = new_vault();
    let d = storage.location().join("d");
    storage.create_dir(&vp("F")).unwrap();
    write(&storage, "a.md", b"a");
    write(&storage, "b.md", b"b");
    let folder = d.join(on_disk(&d).into_iter().find(|n| !n.contains('.')).unwrap());
    let random = |n: usize| (0..n).map(|i| (i * 37 % 251) as u8).collect::<Vec<u8>>();
    let garbage = d.join("garbage.libere");
    let zz = d.join("zz.libere");
    let junk = folder.join("junk");
    std::fs::write(&garbage, random(300)).unwrap();
    std::fs::write(&zz, random(64)).unwrap();
    std::fs::create_dir(&junk).unwrap();

    assert_eq!(names(&storage, ""), ["F", "a.md", "b.md"]);
    assert!(names(&storage, "F").is_empty());
    let mut expected = vec![garbage.clone(), zz.clone(), junk.clone()];
    expected.sort();
    assert_eq!(unreadable_paths(&storage), expected);
    // Writing elsewhere doesn't hide them.
    write(&storage, "c.md", b"c");
    assert_eq!(unreadable_paths(&storage), expected);

    assert!(matches!(
        storage.remove_empty_dir(&vp("F")),
        Err(VaultError::NotEmpty(_))
    ));
    storage.rename(&vp("a.md"), &vp("F/a.md")).unwrap();
    storage.rename(&vp("F"), &vp("G")).unwrap();
    storage.rename(&vp("G/a.md"), &vp("a2.md")).unwrap();
    storage.remove_file(&vp("c.md")).unwrap();
    if real_trash_tests_enabled() {
        storage.trash_os(&vp("b.md")).unwrap();
    }
    let folder = d.join(on_disk(&d).into_iter().find(|n| !n.contains('.')).unwrap());
    for p in [&garbage, &zz, &folder.join("junk")] {
        assert!(p.exists(), "{} is gone", p.display());
    }
    assert_eq!(std::fs::read(&garbage).unwrap(), random(300));
}

#[test]
fn watcher_translates_and_overflows_unknown() {
    let (dir, storage) = new_vault();
    let seen = Arc::new(Mutex::new(Vec::<RawEvent>::new()));
    let sink = Arc::clone(&seen);
    let _guard = storage
        .watch(true, Box::new(move |ev| sink.lock().unwrap().push(ev)))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300)); // let the backend arm
    write(&storage, "w.md", b"w");
    let saw = |ev: RawEvent| {
        wait_until(Duration::from_secs(2), || {
            seen.lock().unwrap().contains(&ev)
        })
    };
    assert!(
        saw(RawEvent::Changed(vp("w.md"))),
        "{:?}",
        seen.lock().unwrap()
    );
    // Nothing else follows our own write: no Overflow, no temp or side file.
    std::thread::sleep(Duration::from_millis(500));
    let got = seen.lock().unwrap().clone();
    assert!(
        got.iter().all(|e| *e == RawEvent::Changed(vp("w.md"))),
        "{got:?}"
    );

    std::fs::write(dir.path().join("d").join("stray.libere"), b"random").unwrap();
    assert!(saw(RawEvent::Overflow), "{:?}", seen.lock().unwrap());

    // A dropped guard drops the watch: nothing more reaches the sink.
    drop(_guard);
    std::thread::sleep(Duration::from_millis(100));
    seen.lock().unwrap().clear();
    write(&storage, "w2.md", b"w");
    std::fs::write(dir.path().join("d").join("stray2.libere"), b"random").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        seen.lock().unwrap().is_empty(),
        "{:?}",
        seen.lock().unwrap()
    );
}

#[test]
fn dropping_the_storage_clears_the_keys_a_watcher_shares() {
    let (dir, storage) = new_vault();
    let seen = Arc::new(Mutex::new(Vec::<RawEvent>::new()));
    let sink = Arc::clone(&seen);
    let _guard = storage
        .watch(true, Box::new(move |ev| sink.lock().unwrap().push(ev)))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    drop(storage);
    // A name the keys would decrypt: with them cleared it can only overflow.
    let d = dunce::canonicalize(dir.path()).unwrap().join("d");
    let on_disk = with_codec(dir.path(), |c, _| {
        c.encrypt_file(&FolderId::ROOT, "x.md").unwrap()
    });
    std::fs::write(d.join(on_disk), b"x").unwrap();
    assert!(
        wait_until(Duration::from_secs(2), || {
            seen.lock().unwrap().contains(&RawEvent::Overflow)
        }),
        "{:?}",
        seen.lock().unwrap()
    );
    assert!(
        !seen
            .lock()
            .unwrap()
            .contains(&RawEvent::Changed(vp("x.md"))),
        "{:?}",
        seen.lock().unwrap()
    );
}

/// A Dropbox-style copy of the long-named physical entry in `d`.
fn plant_long_copy(d: &Path) -> PathBuf {
    let liberl = on_disk(d)
        .into_iter()
        .find(|n| n.ends_with(".liberl"))
        .unwrap();
    let h = liberl.strip_suffix(".liberl").unwrap();
    let copy = d.join(format!("{h} (conflicted copy 2026-10-20).liberl"));
    std::fs::copy(d.join(&liberl), &copy).unwrap();
    copy
}

#[test]
fn a_long_names_conflict_copy_survives_its_original() {
    let long = format!("{}.md", "l".repeat(177));
    let copy_name = format!(
        "{} (conflict conflicted copy 2026-10-20).md",
        "l".repeat(177)
    );

    // (a) The original is removed.
    let (_dir, storage) = new_vault();
    let d = storage.location().join("d");
    write(&storage, &long, b"body");
    plant_long_copy(&d);
    assert_eq!(names(&storage, ""), [copy_name.clone(), long.clone()]);
    storage.remove_file(&vp(&long)).unwrap();
    assert_eq!(names(&storage, ""), std::slice::from_ref(&copy_name));
    assert_eq!(storage.read(&vp(&copy_name)).unwrap(), b"body");
    assert!(
        storage.unreadable().is_empty(),
        "{:?}",
        storage.unreadable()
    );

    // (b) The original is renamed to a short name.
    let (_dir, storage) = new_vault();
    let d = storage.location().join("d");
    write(&storage, &long, b"body");
    plant_long_copy(&d);
    storage.rename(&vp(&long), &vp("short.md")).unwrap();
    assert_eq!(names(&storage, ""), [copy_name.clone(), "short.md".into()]);
    assert_eq!(storage.read(&vp(&copy_name)).unwrap(), b"body");
    assert!(
        storage.unreadable().is_empty(),
        "{:?}",
        storage.unreadable()
    );

    // Renaming the copy itself away leaves no side file behind.
    storage.rename(&vp(&copy_name), &vp("kept.md")).unwrap();
    assert!(
        on_disk(&d).iter().all(|n| n.ends_with(".libere")),
        "{:?}",
        on_disk(&d)
    );

    if real_trash_tests_enabled() {
        let (_dir, storage) = new_vault();
        let d = storage.location().join("d");
        write(&storage, &long, b"body");
        plant_long_copy(&d);
        storage.trash_os(&vp(&long)).unwrap();
        assert_eq!(storage.read(&vp(&copy_name)).unwrap(), b"body");
    }
}

#[test]
fn orphan_side_files_are_listed_and_failed_moves_leave_none() {
    let (_dir, storage) = new_vault();
    let d = storage.location().join("d");
    storage.create_dir(&vp("F")).unwrap();
    let long = format!("{}.md", "l".repeat(177));
    write(&storage, &format!("F/{long}"), b"x");
    let folder = d.join(on_disk(&d).remove(0));
    let liberl = on_disk(&folder)
        .into_iter()
        .find(|n| n.ends_with(".liberl"))
        .unwrap();
    std::fs::remove_file(folder.join(&liberl)).unwrap();

    assert!(names(&storage, "F").is_empty());
    let side = folder.join(liberl.replace(".liberl", ".libern"));
    let found = storage.unreadable();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, side);
    assert!(
        found[0].1.contains("side file without its entry"),
        "{found:?}"
    );
    assert!(matches!(
        storage.remove_empty_dir(&vp("F")),
        Err(VaultError::NotEmpty(_))
    ));
    std::fs::remove_file(&side).unwrap();

    // A move the OS refuses (a folder into itself) takes its new side file back.
    let long_dir = "f".repeat(180);
    let err = storage.rename(&vp("F"), &vp(&format!("F/{long_dir}")));
    assert!(err.is_err());
    assert!(on_disk(&folder).is_empty(), "{:?}", on_disk(&folder));
}

#[test]
fn decrypted_names_are_single_components() {
    let (dir, storage) = new_vault();
    let d = storage.location().join("d");
    with_codec(dir.path(), |codec, u| {
        for name in ["C:x", "a:b"] {
            let on_disk = codec.encrypt_file(&FolderId::ROOT, name).unwrap();
            let out = std::fs::File::create(d.join(on_disk)).unwrap();
            let mut w = StreamWriter::new(out, &u.subkeys().content, u.epoch()).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }
    });
    assert!(names(&storage, "").is_empty());
    assert_eq!(storage.unreadable().len(), 2);
    assert!(
        storage
            .unreadable()
            .iter()
            .all(|(_, why)| why.contains("not a single name"))
    );
    // Writing such a name is refused: it would list as unreadable.
    let err = storage
        .replace_atomic(&vp("at 10:30.md"), &mut &b"x"[..], Replace::CreateOnly)
        .unwrap_err();
    assert!(
        matches!(&err, VaultError::Io { source, .. }
            if source.kind() == std::io::ErrorKind::InvalidInput
                && source.to_string().contains("bad name")),
        "{err:?}"
    );
}
