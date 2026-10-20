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
    assert!(
        !seen.lock().unwrap().contains(&RawEvent::Overflow),
        "{:?}",
        seen.lock().unwrap()
    );

    std::fs::write(dir.path().join("d").join("stray.libere"), b"random").unwrap();
    assert!(saw(RawEvent::Overflow), "{:?}", seen.lock().unwrap());
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
    assert!(
        storage
            .replace_atomic(&vp("at 10:30.md"), &mut &b"x"[..], Replace::CreateOnly)
            .is_err()
    );
}
