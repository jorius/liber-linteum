//! `EncryptedStorage` (E3): create, unlock, lock and reads through the `Storage` trait.
//! Built with `liber-vault/test-params` (the crate's own dev-dependency enables it), so
//! fixtures use tiny Argon2 parameters.

use liber_crypto::{Argon2Params, FolderId, NameCodec, StreamWriter, Unlock, VaultHeader};
use liber_vault::{
    Child, EncryptedStorage, HEADER_FILE, Kind, Reach, Storage, VaultError, VaultPath,
    is_encrypted_vault,
};
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
    let root = storage.location();
    let header = VaultHeader::parse(&std::fs::read(root.join(HEADER_FILE)).unwrap()).unwrap();
    let u = header.unlock(Unlock::Passphrase(PASS)).unwrap();
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
