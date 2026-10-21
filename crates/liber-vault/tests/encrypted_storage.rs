//! `EncryptedStorage` (E3): create, unlock, lock and reads through the `Storage` trait.
//! Built with `liber-vault/test-params` (the crate's own dev-dependency enables it), so
//! fixtures use tiny Argon2 parameters.

use liber_crypto::{Argon2Params, FolderId, NameCodec, StreamWriter, Unlock, VaultHeader};
use liber_vault::{
    Child, EncryptedStorage, Follow, HEADER_FILE, Kind, OsUse, Reach, Replace, Storage, Vault,
    VaultError, VaultKind, VaultPath, is_encrypted_vault, vault_kind,
};
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

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

/// Writes `body` at `logical` (each folder in it new) straight to disk with the crypto
/// core, behind the storage's back. Task 2's writer replaces this.
fn seal_file(storage: &EncryptedStorage, logical: &str, body: &[u8]) {
    seal_file_as(storage.location(), PASS, logical, body);
}

/// [`seal_file`] under the header's current epoch, unlocked with `pass`.
fn seal_file_as(root: &Path, pass: &str, logical: &str, body: &[u8]) {
    let header = VaultHeader::parse(&std::fs::read(root.join(HEADER_FILE)).unwrap()).unwrap();
    let u = header.unlock(Unlock::Passphrase(pass)).unwrap();
    let codec = NameCodec::new(&u.subkeys().name, u.vault_id(), u.epoch());
    let mut parts: Vec<&str> = logical.split('/').collect();
    let file = parts.pop().unwrap();
    let mut dir = root.join("d");
    let mut parent = FolderId::ROOT;
    for name in parts {
        let id = FolderId::random();
        dir.push(codec.encrypt_folder(&parent, &id, name).unwrap());
        std::fs::create_dir(&dir).unwrap();
        parent = id;
    }
    let out = std::fs::File::create(dir.join(codec.encrypt_file(&parent, file).unwrap())).unwrap();
    let mut w = StreamWriter::new(out, &u.subkeys().content, u.epoch()).unwrap();
    w.write_all(body).unwrap();
    w.finish().unwrap();
}

fn entries(storage: &EncryptedStorage, dir: &str) -> Vec<(String, Kind, u64)> {
    let mut out: Vec<_> = storage
        .children(&vp(dir))
        .unwrap()
        .into_iter()
        .map(|c| match c {
            Child::Entry { name, meta } => (name, meta.kind, meta.len),
            Child::Unreadable(msg) => panic!("unreadable: {msg}"),
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Every physical file under `d/`.
fn physical_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.join("d")];
    while let Some(p) = stack.pop() {
        for e in std::fs::read_dir(&p).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                out.push(e.path());
            }
        }
    }
    out
}

fn unreadable(storage: &EncryptedStorage, dir: &str) -> Vec<String> {
    storage
        .children(&vp(dir))
        .unwrap()
        .into_iter()
        .map(|c| match c {
            Child::Unreadable(msg) => msg,
            Child::Entry { name, .. } => panic!("listed: {name}"),
        })
        .collect()
}

fn top_level(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn create_then_unlock_with_passphrase_and_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let (created, rc) = EncryptedStorage::create_insecure(dir.path(), PASS, TINY).unwrap();
    assert_eq!(top_level(dir.path()), ["README.txt", "d", HEADER_FILE]);
    assert!(dir.path().join("d").is_dir());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("README.txt")).unwrap(),
        "Encrypted Liber Linteum vault. Open it with Liber Linteum."
    );
    assert!(is_encrypted_vault(dir.path()));
    assert!(!created.is_locked());

    let (by_pass, report) = EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).unwrap();
    assert_eq!(report.vault_id, created.vault_id());
    assert_eq!(report.epoch, 1);
    assert_eq!(by_pass.epoch(), 1);
    assert!(report.merged.is_none());

    let (by_code, report) = EncryptedStorage::unlock(dir.path(), Unlock::Recovery(&rc)).unwrap();
    assert_eq!(report.vault_id, created.vault_id());
    assert_eq!(by_code.vault_id(), created.vault_id());

    let wrong = EncryptedStorage::unlock(dir.path(), Unlock::Passphrase("nope"));
    assert!(matches!(wrong, Err(VaultError::WrongSecret)));

    let empty = tempfile::tempdir().unwrap();
    assert!(!is_encrypted_vault(empty.path()));
    let missing = EncryptedStorage::unlock(empty.path(), Unlock::Passphrase(PASS));
    assert!(matches!(missing, Err(VaultError::NotFound(_))));
}

#[test]
fn create_refuses_non_empty_folder() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "x").unwrap();
    let made = EncryptedStorage::create_insecure(dir.path(), PASS, TINY);
    assert!(matches!(made, Err(VaultError::NotEmpty(_))));
    assert_eq!(top_level(dir.path()), ["a.md"]);

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".DS_Store"), "x").unwrap();
    EncryptedStorage::create_insecure(dir.path(), PASS, TINY).unwrap();
    assert!(is_encrypted_vault(dir.path()));
}

#[test]
fn create_enforces_the_argon2_floor_even_in_test_builds() {
    let dir = tempfile::tempdir().unwrap();
    let err = EncryptedStorage::create(dir.path(), PASS, TINY).err();
    assert!(matches!(err, Some(VaultError::Crypto(_))), "{err:?}");
    assert!(top_level(dir.path()).is_empty(), "nothing written");
}

#[test]
fn create_can_be_retried_after_failing_before_the_header() {
    // What a create that died before writing the header leaves behind.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("d")).unwrap();
    std::fs::write(
        dir.path().join("README.txt"),
        "Encrypted Liber Linteum vault. Open it with Liber Linteum.",
    )
    .unwrap();
    EncryptedStorage::create_insecure(dir.path(), PASS, TINY).unwrap();
    assert!(is_encrypted_vault(dir.path()));

    // A README.txt of the user's own is never overwritten.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("README.txt"), "my notes").unwrap();
    let made = EncryptedStorage::create_insecure(dir.path(), PASS, TINY);
    assert!(matches!(made, Err(VaultError::NotEmpty(_))));
    // Nor is a non-empty `d/`.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("d")).unwrap();
    std::fs::write(dir.path().join("d/x"), "x").unwrap();
    let made = EncryptedStorage::create_insecure(dir.path(), PASS, TINY);
    assert!(matches!(made, Err(VaultError::NotEmpty(_))));
}

#[test]
fn read_back_through_the_trait() {
    let (_dir, storage) = new_vault();
    seal_file(&storage, "A/b.md", b"hello");

    assert_eq!(entries(&storage, ""), [("A".to_string(), Kind::Dir, 0)]);
    assert_eq!(
        entries(&storage, "A"),
        [("b.md".to_string(), Kind::File, 5)]
    );
    assert_eq!(storage.read(&vp("A/b.md")).unwrap(), b"hello");

    let meta = storage
        .meta(&vp("A/b.md"), liber_vault::Follow::No)
        .unwrap()
        .unwrap();
    assert_eq!((meta.kind, meta.len), (Kind::File, 5));
    assert!(
        storage
            .meta(&vp("A/missing.md"), liber_vault::Follow::No)
            .unwrap()
            .is_none()
    );

    let mut r = storage.open_read(&vp("A/b.md"), Reach::Any).unwrap();
    assert_eq!(r.len, 5);
    r.inner.seek(SeekFrom::Start(2)).unwrap();
    let mut rest = Vec::new();
    r.inner.read_to_end(&mut rest).unwrap();
    assert_eq!(rest, b"llo");

    assert!(matches!(
        storage.open_read(&vp("A"), Reach::Any),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        storage.read(&vp("A/nope.md")),
        Err(VaultError::NotFound(_))
    ));

    // A name that won't decrypt is listed as unreadable; OS dot-files are skipped.
    let d = storage.location().join("d");
    std::fs::write(d.join("zz.libere"), b"junk").unwrap();
    std::fs::write(d.join(".DS_Store"), b"junk").unwrap();
    let kids = storage.children(&vp("")).unwrap();
    let bad: Vec<&String> = kids
        .iter()
        .filter_map(|c| match c {
            Child::Unreadable(msg) => Some(msg),
            Child::Entry { .. } => None,
        })
        .collect();
    assert_eq!((kids.len(), bad.len()), (2, 1));
    assert!(
        bad[0].contains("zz.libere: couldn't read the name"),
        "{}",
        bad[0]
    );
}

#[test]
fn nothing_on_disk_is_plaintext() {
    let (dir, storage) = new_vault();
    seal_file(&storage, "Secret/Canary-7f3a.md", b"canary-7f3a");
    assert_eq!(
        storage.read(&vp("Secret/Canary-7f3a.md")).unwrap(),
        b"canary-7f3a"
    );

    let mut stack = vec![dir.path().to_path_buf()];
    let mut seen = 0;
    while let Some(p) = stack.pop() {
        for e in std::fs::read_dir(&p).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().into_string().unwrap();
            assert!(
                !name.to_lowercase().contains("canary"),
                "name leaks: {name}"
            );
            assert!(!name.contains("Secret"), "name leaks: {name}");
            if e.file_type().unwrap().is_dir() {
                stack.push(e.path());
            } else {
                let bytes = std::fs::read(e.path()).unwrap();
                assert!(
                    !bytes.windows(6).any(|w| w.eq_ignore_ascii_case(b"canary")),
                    "content leaks in {name}"
                );
                seen += 1;
            }
        }
    }
    assert_eq!(seen, 3, "header, README and the sealed note");
}

#[test]
fn lock_drops_keys() {
    let (_dir, storage) = new_vault();
    seal_file(&storage, "A/b.md", b"hello");
    assert_eq!(storage.read(&vp("A/b.md")).unwrap(), b"hello");

    storage.lock();
    assert!(storage.is_locked());
    assert!(matches!(
        storage.read(&vp("A/b.md")),
        Err(VaultError::Locked)
    ));
    assert!(matches!(storage.children(&vp("")), Err(VaultError::Locked)));
    assert!(matches!(
        storage.meta(&vp("A"), liber_vault::Follow::No),
        Err(VaultError::Locked)
    ));
}

#[test]
fn duplicate_names_are_both_unreadable_in_a_stable_order() {
    let (_dir, storage) = new_vault();
    // A folder `A` and a file `A` at the root both decrypt to "A".
    seal_file(&storage, "A/b.md", b"x");
    seal_file(&storage, "A", b"y");
    let first = unreadable(&storage, "");
    assert_eq!(first.len(), 2, "{first:?}");
    assert!(
        first
            .iter()
            .all(|m| m.contains("another entry is also named"))
    );
    let mut sorted = first.clone();
    sorted.sort();
    assert_eq!(first, sorted);
    assert_eq!(unreadable(&storage, ""), first);
    assert!(
        storage
            .meta(&vp("A"), liber_vault::Follow::No)
            .unwrap()
            .is_none()
    );
}

#[test]
fn names_decrypt_under_the_retiring_key() {
    let (dir, storage) = new_vault();
    seal_file(&storage, "Old/n.md", b"from epoch 1");
    // Begin a rotation: epoch 2 is current, epoch 1 retiring.
    let path = dir.path().join(HEADER_FILE);
    let mut header = VaultHeader::parse(&std::fs::read(&path).unwrap()).unwrap();
    let u1 = header.unlock(Unlock::Passphrase(PASS)).unwrap();
    let (u2, _rc) = header.begin_rotation_insecure(&u1, "next", TINY).unwrap();
    std::fs::write(&path, header.to_bytes(&u2).unwrap()).unwrap();

    let (rotated, report) =
        EncryptedStorage::unlock(dir.path(), Unlock::Passphrase("next")).unwrap();
    assert_eq!(report.epoch, 2);
    assert_eq!(entries(&rotated, ""), [("Old".to_string(), Kind::Dir, 0)]);
    assert_eq!(
        entries(&rotated, "Old"),
        [("n.md".to_string(), Kind::File, 12)]
    );
    assert_eq!(rotated.read(&vp("Old/n.md")).unwrap(), b"from epoch 1");
}

#[test]
fn damaged_content_lists_with_len_0_and_reads_as_damaged() {
    let (dir, storage) = new_vault();
    seal_file(&storage, "a.md", b"hello");
    let [file] = physical_files(dir.path()).try_into().unwrap();
    let mut bytes = std::fs::read(&file).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    std::fs::write(&file, bytes).unwrap();

    assert_eq!(entries(&storage, ""), [("a.md".to_string(), Kind::File, 0)]);
    match storage.read(&vp("a.md")) {
        Err(VaultError::Crypto(msg)) => assert!(msg.contains("damaged or modified"), "{msg}"),
        other => panic!("{other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn symlinks_are_never_followed() {
    let (dir, storage) = new_vault();
    seal_file(&storage, "x.md", b"outside");
    let [file] = physical_files(dir.path()).try_into().unwrap();
    assert_eq!(storage.read(&vp("x.md")).unwrap(), b"outside"); // caches the listing

    // The entry becomes a link to the same ciphertext, now outside the vault.
    let elsewhere = tempfile::tempdir().unwrap();
    let target = elsewhere.path().join("x");
    std::fs::rename(&file, &target).unwrap();
    std::os::unix::fs::symlink(&target, &file).unwrap();

    // A stale cache entry doesn't follow it…
    assert!(storage.read(&vp("x.md")).is_err());
    assert!(storage.open_read(&vp("x.md"), Reach::Any).is_err());
    // …and a fresh listing shows it as unreadable.
    let bad = unreadable(&storage, "");
    assert_eq!(bad.len(), 1);
    assert!(bad[0].contains("not a file or folder"), "{}", bad[0]);
    assert!(storage.read(&vp("x.md")).is_err());

    // A `d/` that is a link is refused at unlock.
    let other = tempfile::tempdir().unwrap();
    std::fs::rename(dir.path().join("d"), other.path().join("d")).unwrap();
    std::os::unix::fs::symlink(other.path().join("d"), dir.path().join("d")).unwrap();
    assert!(EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).is_err());
}

// ---- Task 2: writes, folders, renames and trash ----

fn write(
    storage: &EncryptedStorage,
    path: &str,
    body: &[u8],
    mode: Replace,
) -> Result<(), VaultError> {
    storage.replace_atomic(&vp(path), &mut &body[..], mode)
}

/// Every entry under `d/`, relative to it: folders map to `None`, files to their bytes.
fn tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let d = root.join("d");
    let mut out = BTreeMap::new();
    let mut stack = vec![d.clone()];
    while let Some(p) = stack.pop() {
        for e in std::fs::read_dir(&p).unwrap() {
            let path = e.unwrap().path();
            let rel = path.strip_prefix(&d).unwrap().to_path_buf();
            if path.is_dir() {
                stack.push(path);
                out.insert(rel, None);
            } else {
                out.insert(rel, Some(std::fs::read(&path).unwrap()));
            }
        }
    }
    out
}

fn top_dirs(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root.join("d"))
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| e.file_type().unwrap().is_dir())
        .map(|e| e.file_name().into_string().unwrap())
        .collect();
    out.sort();
    out
}

#[test]
fn write_read_round_trip_and_overwrite() {
    let (dir, storage) = new_vault();
    write(&storage, "n.md", b"v1", Replace::CreateOnly).unwrap();
    assert_eq!(storage.read(&vp("n.md")).unwrap(), b"v1");
    let [file] = physical_files(dir.path()).try_into().unwrap();
    let first = std::fs::read(&file).unwrap()[..48].to_vec();

    write(&storage, "n.md", b"v2", Replace::Overwrite).unwrap();
    assert_eq!(storage.read(&vp("n.md")).unwrap(), b"v2");
    let [again] = physical_files(dir.path()).try_into().unwrap();
    assert_eq!(again, file, "an overwrite keeps the physical name");
    assert_ne!(
        std::fs::read(&again).unwrap()[..48],
        first[..],
        "fresh salt"
    );

    assert!(matches!(
        write(&storage, "n.md", b"v3", Replace::CreateOnly),
        Err(VaultError::AlreadyExists(_))
    ));
    assert_eq!(storage.read(&vp("n.md")).unwrap(), b"v2");
    assert!(matches!(
        write(&storage, "missing/n.md", b"x", Replace::CreateOnly),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn encrypted_save_failure_keeps_previous_version() {
    let (dir, storage) = new_vault();
    write(&storage, "n.md", b"previous", Replace::CreateOnly).unwrap();
    let big = vec![7u8; 200_000];
    let err = storage
        .replace_atomic_failing(&vp("n.md"), &mut &big[..], Replace::Overwrite)
        .unwrap_err();
    assert!(matches!(err, VaultError::Io { .. }), "{err:?}");
    assert_eq!(storage.read(&vp("n.md")).unwrap(), b"previous");
    assert_eq!(entries(&storage, ""), [("n.md".to_string(), Kind::File, 8)]);
    assert_eq!(physical_files(dir.path()).len(), 1, "no temp file left");

    // A new file that fails leaves nothing at all.
    let err = storage.replace_atomic_failing(&vp("new.md"), &mut &big[..], Replace::CreateOnly);
    assert!(err.is_err());
    assert_eq!(entries(&storage, "").len(), 1);
    assert_eq!(physical_files(dir.path()).len(), 1);
}

#[test]
fn create_new_streams_and_finalises_on_finish() {
    let (dir, storage) = new_vault();
    let body: Vec<u8> = (0..150_000u32).map(|i| (i % 251) as u8).collect();
    let mut w = storage.create_new(&vp("rec.m4a")).unwrap();
    for (i, piece) in body.chunks(7 * 1024).enumerate() {
        w.write_all(piece).unwrap();
        if i % 3 == 0 {
            w.flush().unwrap();
        }
    }
    assert!(
        entries(&storage, "").is_empty(),
        "not visible before finish"
    );
    w.finish().unwrap();
    assert_eq!(storage.read(&vp("rec.m4a")).unwrap(), body);
    assert!(matches!(
        storage.create_new(&vp("rec.m4a")).err(),
        Some(VaultError::AlreadyExists(_))
    ));

    for flushed in [true, false] {
        let mut w = storage.create_new(&vp("dropped.m4a")).unwrap();
        w.write_all(&body).unwrap();
        if flushed {
            w.flush().unwrap();
        }
        drop(w);
        assert_eq!(entries(&storage, "").len(), 1, "flushed: {flushed}");
        assert_eq!(
            physical_files(dir.path()).len(),
            1,
            "only rec.m4a, no temp file"
        );
    }
}

#[test]
fn same_entry_folds_case() {
    let (_dir, storage) = new_vault();
    storage.create_dir(&vp("Notes")).unwrap();
    assert!(storage.same_entry(&vp("Notes"), &vp("notes")));
    assert!(storage.same_entry(&vp("Notes"), &vp("Notes")));
    assert!(!storage.same_entry(&vp("Notes"), &vp("missing")));
}

#[test]
fn folder_rename_touches_only_its_name() {
    let (dir, storage) = new_vault();
    for f in ["A", "B"] {
        storage.create_dir(&vp(f)).unwrap();
        write(
            &storage,
            &format!("{f}/Notes.md"),
            f.as_bytes(),
            Replace::CreateOnly,
        )
        .unwrap();
    }
    let before = tree(dir.path());
    let dirs_before = top_dirs(dir.path());
    storage.rename(&vp("A"), &vp("C")).unwrap();
    assert_eq!(storage.read(&vp("C/Notes.md")).unwrap(), b"A");
    assert_eq!(storage.read(&vp("B/Notes.md")).unwrap(), b"B");
    assert!(storage.meta(&vp("A"), Follow::No).unwrap().is_none());

    // Exactly one top-level physical name changed: A's became C's.
    let dirs_after = top_dirs(dir.path());
    let [old] = dirs_before
        .iter()
        .filter(|d| !dirs_after.contains(d))
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let [new] = dirs_after
        .iter()
        .filter(|d| !dirs_before.contains(d))
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    // Everything else, A's children included, is byte-identical under its new name.
    let moved: BTreeMap<_, _> = before
        .into_iter()
        .map(|(p, v)| match p.strip_prefix(old) {
            Ok(rest) => (Path::new(new).join(rest), v),
            Err(_) => (p, v),
        })
        .collect();
    let after = tree(dir.path());
    assert_eq!(moved, after);
}

#[test]
fn move_file_between_folders() {
    let (dir, storage) = new_vault();
    storage.create_dir(&vp("A")).unwrap();
    storage.create_dir(&vp("B")).unwrap();
    write(&storage, "A/x.md", b"moving", Replace::CreateOnly).unwrap();
    let [old] = physical_files(dir.path()).try_into().unwrap();
    storage.rename(&vp("A/x.md"), &vp("B/x.md")).unwrap();
    assert_eq!(storage.read(&vp("B/x.md")).unwrap(), b"moving");
    assert!(entries(&storage, "A").is_empty());
    assert!(!old.exists(), "the physical file under A is gone");
    assert!(
        std::fs::read_dir(old.parent().unwrap())
            .unwrap()
            .next()
            .is_none()
    );
    assert!(matches!(
        storage.rename(&vp("A/x.md"), &vp("B/y.md")),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn case_clash_is_refused() {
    let (_dir, storage) = new_vault();
    write(&storage, "a.md", b"a", Replace::CreateOnly).unwrap();
    write(&storage, "b.md", b"b", Replace::CreateOnly).unwrap();
    assert!(matches!(
        storage.create_dir(&vp("A.md")),
        Err(VaultError::AlreadyExists(_))
    ));
    assert!(matches!(
        write(&storage, "A.md", b"x", Replace::CreateOnly),
        Err(VaultError::AlreadyExists(_))
    ));
    assert!(matches!(
        storage.rename(&vp("b.md"), &vp("A.MD")),
        Err(VaultError::AlreadyExists(_))
    ));
    // A case-only rename of the entry itself works.
    storage.rename(&vp("a.md"), &vp("A.md")).unwrap();
    assert_eq!(
        entries(&storage, ""),
        [
            ("A.md".to_string(), Kind::File, 1),
            ("b.md".to_string(), Kind::File, 1)
        ]
    );
    assert_eq!(storage.read(&vp("A.md")).unwrap(), b"a");
}

#[test]
fn os_path_is_never_plaintext() {
    let (dir, storage) = new_vault();
    write(&storage, "n.md", b"x", Replace::CreateOnly).unwrap();
    for use_ in [OsUse::Open, OsUse::Reveal, OsUse::FileUrl] {
        assert!(matches!(
            storage.os_path(&vp("n.md"), use_),
            Err(VaultError::NotPermitted(_))
        ));
    }
    let [file] = physical_files(dir.path()).try_into().unwrap();
    assert!(storage.vault_path_of(&file).is_none());
    assert!(storage.vault_path_of(dir.path()).is_none());
}

#[test]
fn removes_trash_and_locked_writes() {
    let (dir, storage) = new_vault();
    storage.create_dir(&vp("F")).unwrap();
    write(&storage, "F/a.md", b"a", Replace::CreateOnly).unwrap();
    write(&storage, "b.md", b"b", Replace::CreateOnly).unwrap();
    assert!(storage.remove_empty_dir(&vp("F")).is_err(), "not empty");
    storage.remove_file(&vp("F/a.md")).unwrap();
    storage.remove_empty_dir(&vp("F")).unwrap();
    assert!(matches!(
        storage.remove_file(&vp("F/a.md")),
        Err(VaultError::NotFound(_))
    ));
    // The OS trash gets ciphertext only.
    storage.trash_os(&vp("b.md")).unwrap();
    assert!(entries(&storage, "").is_empty());
    assert!(tree(dir.path()).is_empty());

    storage.lock();
    assert!(matches!(
        write(&storage, "c.md", b"c", Replace::CreateOnly),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        storage.create_dir(&vp("G")),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        storage.create_new(&vp("c.md")).err(),
        Some(VaultError::Locked)
    ));
}

// ---- Task 2, fix round 1 ----

#[test]
fn overwrite_never_replaces_an_unreadable_duplicate() {
    let (dir, storage) = new_vault();
    seal_file(&storage, "n.md", b"epoch 1 copy");
    // Mid-rotation, a current-epoch copy of the same name arrives (sync).
    let path = dir.path().join(HEADER_FILE);
    let mut header = VaultHeader::parse(&std::fs::read(&path).unwrap()).unwrap();
    let u1 = header.unlock(Unlock::Passphrase(PASS)).unwrap();
    let (u2, _rc) = header.begin_rotation_insecure(&u1, "next", TINY).unwrap();
    std::fs::write(&path, header.to_bytes(&u2).unwrap()).unwrap();
    seal_file_as(dir.path(), "next", "n.md", b"epoch 2 copy");
    drop(storage);

    let (rotated, _) = EncryptedStorage::unlock(dir.path(), Unlock::Passphrase("next")).unwrap();
    assert_eq!(
        unreadable(&rotated, "").len(),
        2,
        "both duplicates unreadable"
    );
    let before = tree(dir.path());
    assert_eq!(before.len(), 2);
    assert!(write(&rotated, "n.md", b"autosave", Replace::Overwrite).is_err());
    assert_eq!(tree(dir.path()), before, "both physical files intact");
}

#[test]
fn moving_a_folder_keeps_its_id_and_children() {
    let (dir, storage) = new_vault();
    storage.create_dir(&vp("A")).unwrap();
    storage.create_dir(&vp("B")).unwrap();
    write(&storage, "A/x.md", b"inside", Replace::CreateOnly).unwrap();
    storage.create_dir(&vp("A/Sub")).unwrap();
    write(&storage, "A/Sub/y.md", b"deeper", Replace::CreateOnly).unwrap();
    let dirs_before = top_dirs(dir.path());
    let before = tree(dir.path());

    storage.rename(&vp("A"), &vp("B/A")).unwrap();
    assert_eq!(storage.read(&vp("B/A/x.md")).unwrap(), b"inside");
    assert_eq!(storage.read(&vp("B/A/Sub/y.md")).unwrap(), b"deeper");
    assert!(storage.meta(&vp("A"), Follow::No).unwrap().is_none());

    let [b] = top_dirs(dir.path()).try_into().unwrap();
    let [old_a] = dirs_before
        .into_iter()
        .filter(|d| *d != b)
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let after = tree(dir.path());
    let [new_a] = after
        .keys()
        .filter(|p| p.parent() == Some(Path::new(&b)))
        .cloned()
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    // A's own name was re-encrypted under B (it differs from its old name); its id
    // is kept, so every child's physical name and bytes are unchanged.
    assert_ne!(new_a.file_name().unwrap(), Path::new(&old_a).as_os_str());
    assert_eq!(subtree(&after, &new_a), subtree(&before, Path::new(&old_a)));
    assert_eq!(subtree(&after, &new_a).len(), 3, "x.md, Sub, Sub/y.md");
}

/// The entries of `t` strictly under `prefix`, relative to it.
fn subtree(
    t: &BTreeMap<PathBuf, Option<Vec<u8>>>,
    prefix: &Path,
) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    t.iter()
        .filter_map(|(p, v)| {
            let rest = p.strip_prefix(prefix).ok()?;
            (!rest.as_os_str().is_empty()).then(|| (rest.to_path_buf(), v.clone()))
        })
        .collect()
}

#[test]
fn lock_before_finish_still_commits_ciphertext_only() {
    let (dir, storage) = new_vault();
    let body = b"canary-lock-finish ".repeat(5000);
    let mut w = storage.create_new(&vp("rec.m4a")).unwrap();
    w.write_all(&body).unwrap();
    storage.lock();
    w.finish().unwrap();
    for (_, bytes) in tree(dir.path()) {
        let bytes = bytes.unwrap_or_default();
        assert!(!bytes.windows(18).any(|x| x == b"canary-lock-finish"));
    }
    let (again, _) = EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).unwrap();
    assert_eq!(again.read(&vp("rec.m4a")).unwrap(), body);
}

#[test]
fn same_entry_folds_normal_form() {
    let (_dir, storage) = new_vault();
    storage.create_dir(&vp("Caf\u{e9}")).unwrap();
    assert!(storage.same_entry(&vp("Caf\u{e9}"), &vp("Cafe\u{301}")));
    assert!(storage.same_entry(&vp("Caf\u{e9}"), &vp("CAFE\u{301}")));
    assert!(
        storage
            .meta(&vp("cafe\u{301}"), Follow::No)
            .unwrap()
            .is_some()
    );
}

/// E3 Task 4 lock rework: reads, listings and renames from several threads at
/// once never deadlock, and each sees a state the renames allow.
#[test]
fn concurrent_reads_listings_and_renames_stay_consistent() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    fn rename(s: &EncryptedStorage) {
        s.rename(&vp("F/a.md"), &vp("F/b.md")).unwrap();
        s.rename(&vp("F/b.md"), &vp("F/a.md")).unwrap();
    }
    fn read(s: &EncryptedStorage) {
        assert_eq!(s.read(&vp("F/still.md")).unwrap(), b"still");
        for name in ["F/a.md", "F/b.md"] {
            match s.read(&vp(name)) {
                Ok(bytes) => assert_eq!(bytes, b"moving"),
                Err(e) => assert!(matches!(e, VaultError::NotFound(_)), "{e:?}"),
            }
        }
        assert!(s.meta(&vp("F/still.md"), Follow::No).unwrap().is_some());
    }
    fn list(s: &EncryptedStorage) {
        let names: Vec<String> = s
            .children(&vp("F"))
            .unwrap()
            .into_iter()
            .map(|c| match c {
                Child::Entry { name, .. } => name,
                Child::Unreadable(why) => panic!("unreadable: {why}"),
            })
            .collect();
        assert!(names.contains(&"still.md".to_string()), "{names:?}");
        let known = ["a.md", "b.md", "still.md"];
        assert!(
            names.iter().all(|n| known.contains(&n.as_str())),
            "{names:?}"
        );
    }

    let (_dir, storage) = new_vault();
    storage.create_dir(&vp("F")).unwrap();
    for (name, body) in [("F/a.md", "moving"), ("F/still.md", "still")] {
        storage
            .replace_atomic(&vp(name), &mut body.as_bytes(), Replace::CreateOnly)
            .unwrap();
    }
    let storage = Arc::new(storage);
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    let jobs: [fn(&EncryptedStorage); 4] = [rename, read, read, list];
    for job in jobs {
        let (s, stop, tx) = (Arc::clone(&storage), Arc::clone(&stop), tx.clone());
        std::thread::spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                while !stop.load(Ordering::Relaxed) {
                    job(&s);
                }
            }));
            let _ = tx.send(r);
        });
    }
    std::thread::sleep(Duration::from_millis(400));
    stop.store(true, Ordering::Relaxed);
    for _ in jobs {
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {}
            Ok(Err(panic)) => std::panic::resume_unwind(panic),
            Err(_) => panic!("a thread didn't finish: deadlock"),
        }
    }
    assert_eq!(storage.read(&vp("F/a.md")).unwrap(), b"moving");
}

/// Fix round 1 (I2): a folder is encrypted only when its header parses and `d/` is a folder.
#[test]
fn vault_kind_needs_a_real_header_and_never_opens_a_damaged_vault_plain() {
    let damaged = |root: &Path| {
        assert!(
            matches!(vault_kind(root), VaultKind::Damaged(_)),
            "{root:?}"
        );
        let err = Vault::open(root).unwrap_err();
        assert!(matches!(err, VaultError::Damaged(_)), "{err:?}");
    };
    // A plain vault with a user's own `liber-vault.json` (no `d/` folder).
    let plain = tempfile::tempdir().unwrap();
    std::fs::write(plain.path().join(HEADER_FILE), r#"{"theme":"dark"}"#).unwrap();
    std::fs::write(plain.path().join("n.md"), "# n").unwrap();
    assert_eq!(vault_kind(plain.path()), VaultKind::Plain);
    assert!(Vault::open(plain.path()).is_ok());
    // A plain folder named `d` with notes in it, no header: plain.
    let d_notes = tempfile::tempdir().unwrap();
    std::fs::create_dir(d_notes.path().join("d")).unwrap();
    std::fs::write(d_notes.path().join("d/n.md"), "# n").unwrap();
    assert_eq!(vault_kind(d_notes.path()), VaultKind::Plain);

    // An encrypted vault whose header was damaged: never plain.
    let (dir, storage) = new_vault();
    storage
        .replace_atomic(&vp("n.md"), &mut &b"secret"[..], Replace::CreateOnly)
        .unwrap();
    drop(storage);
    assert_eq!(vault_kind(dir.path()), VaultKind::Encrypted);
    std::fs::write(dir.path().join(HEADER_FILE), b"{ torn").unwrap();
    damaged(dir.path());
    // Its header gone, `d/` still holding ciphertext: never plain.
    std::fs::remove_file(dir.path().join(HEADER_FILE)).unwrap();
    damaged(dir.path());
    // A real header whose `d/` is gone: damaged too.
    let (bare, storage) = new_vault();
    drop(storage);
    std::fs::remove_dir(bare.path().join("d")).unwrap();
    damaged(bare.path());
}

/// E3 Task 5 review I1: at most the format's limit (`MAX_HEADER_BYTES`, 1 MiB)
/// of a header is read; a longer one is unparseable (damaged beside `d/`,
/// else the folder stays plain).
#[test]
fn vault_kind_reads_at_most_the_formats_header_limit() {
    let (dir, storage) = new_vault();
    drop(storage);
    let header = dir.path().join(HEADER_FILE);
    let mut bytes = std::fs::read(&header).unwrap();
    // Trailing whitespace keeps it valid JSON: only the size changes.
    bytes.resize(liber_crypto::MAX_HEADER_BYTES, b' ');
    std::fs::write(&header, &bytes).unwrap();
    assert_eq!(vault_kind(dir.path()), VaultKind::Encrypted);
    EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).unwrap();
    bytes.push(b' ');
    std::fs::write(&header, &bytes).unwrap();
    assert!(
        matches!(vault_kind(dir.path()), VaultKind::Damaged(_)),
        "{:?}",
        vault_kind(dir.path())
    );
    assert!(EncryptedStorage::unlock(dir.path(), Unlock::Passphrase(PASS)).is_err());
    std::fs::remove_dir(dir.path().join("d")).unwrap();
    assert_eq!(vault_kind(dir.path()), VaultKind::Plain);
}

/// E3 Task 5 review I2: a create whose vault never opened is undone: the
/// folder holds only what it held before, and a new create works.
#[test]
fn remove_new_vault_undoes_a_create() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".DS_Store"), "").unwrap();
    let (storage, _rc) = EncryptedStorage::create_insecure(dir.path(), PASS, TINY).unwrap();
    storage
        .replace_atomic(&vp("n.md"), &mut &b"secret"[..], Replace::CreateOnly)
        .unwrap();
    drop(storage);
    liber_vault::remove_new_vault(dir.path()).unwrap();
    let left: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, [".DS_Store"]);
    assert_eq!(vault_kind(dir.path()), VaultKind::Plain);
    EncryptedStorage::create_insecure(dir.path(), PASS, TINY).unwrap();
}

/// E3 Task 6 (format §13.7): salvage streams a finished file whole. A file a
/// crash left uncommitted — only its hidden temp file exists — is salvaged up
/// to its last complete chunk, but only explicitly and only in a recording
/// folder (review M2); its leftover temp then goes, so the folder can be removed.
#[test]
fn salvage_reads_a_finished_file_and_a_crashed_one() {
    let (_dir, storage) = new_vault();
    let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let rec = vp(".liber/recording/clip-1");
    storage.create_dir(&vp(".liber")).unwrap();
    storage.create_dir(&vp(".liber/recording")).unwrap();
    storage.create_dir(&rec).unwrap();
    let mut w = storage.create_new(&rec.join("done.wav").unwrap()).unwrap();
    w.write_all(&body).unwrap();
    w.finish().unwrap();
    let mut got = Vec::new();
    assert!(
        storage
            .salvage(&rec.join("done.wav").unwrap(), &mut got)
            .unwrap()
    );
    assert_eq!(got, body);

    let crash = vp(".liber/recording/clip-2");
    storage.create_dir(&crash).unwrap();
    let mut w = storage
        .create_new(&crash.join("take.wav").unwrap())
        .unwrap();
    w.write_all(&body).unwrap();
    w.flush().unwrap();
    std::mem::forget(w); // the app dies: no finish, no drop
    // No silent fallback: the file itself isn't there.
    let err = storage.salvage(&crash.join("take.wav").unwrap(), &mut Vec::new());
    assert!(matches!(err, Err(VaultError::NotFound(_))), "{err:?}");
    let mut got = Vec::new();
    assert!(!storage.salvage_uncommitted(&crash, &mut got).unwrap());
    // Three whole 64 KiB chunks were written; the rest was still buffered.
    assert_eq!(got, body[..3 * 65_536]);
    let err = storage.remove_empty_dir(&crash).unwrap_err();
    assert!(matches!(err, VaultError::NotEmpty(_)), "{err}");
    storage.remove_temp_files(&crash).unwrap();
    storage.remove_empty_dir(&crash).unwrap();

    // Anywhere else the uncommitted helpers refuse.
    storage.create_dir(&vp("notes")).unwrap();
    for dir in ["notes", ".liber/recording", ".liber"] {
        let err = storage.salvage_uncommitted(&vp(dir), &mut Vec::new());
        assert!(
            matches!(err, Err(VaultError::NotPermitted(_))),
            "{dir}: {err:?}"
        );
        let err = storage.remove_temp_files(&vp(dir));
        assert!(
            matches!(err, Err(VaultError::NotPermitted(_))),
            "{dir}: {err:?}"
        );
    }
}

/// Review I1: a stream whose write failed (a full disk) keeps what reached the
/// disk when the recorder asks (`finish_or_keep`): no key is kept, only the
/// ciphertext, for salvage.
#[test]
fn a_failed_stream_is_kept_for_salvage() {
    let (_dir, storage) = new_vault();
    let rec = vp(".liber/recording/clip-1");
    storage.create_dir(&vp(".liber")).unwrap();
    storage.create_dir(&vp(".liber/recording")).unwrap();
    storage.create_dir(&rec).unwrap();
    let path = rec.join("take.wav").unwrap();
    // Room for the header and two chunks.
    let mut w = storage
        .create_new_failing(&path, 48 + 2 * (65_536 + 16))
        .unwrap();
    let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    assert!(w.write_all(&body).is_err());
    assert!(w.finish_or_keep().is_err());
    let mut got = Vec::new();
    assert!(!storage.salvage_uncommitted(&rec, &mut got).unwrap());
    assert_eq!(got, body[..2 * 65_536]);

    // A plain `finish` that fails still leaves nothing behind.
    let other = vp(".liber/recording/clip-2");
    storage.create_dir(&other).unwrap();
    let mut w = storage
        .create_new_failing(&other.join("take.wav").unwrap(), 48 + 65_552)
        .unwrap();
    assert!(w.write_all(&body).is_err());
    assert!(w.finish().is_err());
    let err = storage.salvage_uncommitted(&other, &mut Vec::new());
    assert!(matches!(err, Err(VaultError::NotFound(_))), "{err:?}");
}
