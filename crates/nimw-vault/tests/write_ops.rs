use nimw_testkit::trashable_fixture;
use nimw_vault::{Hash, Vault, VaultError, VaultPath};
use proptest::prelude::*;

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

#[test]
fn nfr_08_write_cas_create_update_and_conflict() {
    let (dir, vault) = fresh();
    let p = vp("note.md");
    let h1 = vault.write_cas(&p, b"one", None).unwrap();
    assert_eq!(h1, Hash::of(b"one"));
    assert!(matches!(
        vault.write_cas(&p, b"x", None),
        Err(VaultError::AlreadyExists(_))
    ));
    let h2 = vault.write_cas(&p, b"two", Some(h1)).unwrap();
    match vault.write_cas(&p, b"three", Some(h1)) {
        Err(VaultError::Conflict { current, .. }) => assert_eq!(current, h2),
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(std::fs::read(dir.path().join("note.md")).unwrap(), b"two");
    assert!(matches!(
        vault.write_cas(&vp("missing.md"), b"x", Some(h1)),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        vault.write_cas(&vp("no/such/dir.md"), b"x", None),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn read_returns_bytes_hash_and_utf8_errors() {
    let (dir, vault) = fresh();
    std::fs::write(dir.path().join("bin.md"), [0xff, 0xfe]).unwrap();
    let (bytes, hash) = vault.read(&vp("bin.md")).unwrap();
    assert_eq!(hash, Hash::of(&bytes));
    assert!(matches!(
        vault.read_to_string(&vp("bin.md")),
        Err(VaultError::NotUtf8(_))
    ));
    assert!(matches!(
        vault.read(&vp("nope.md")),
        Err(VaultError::NotFound(_))
    ));
}

#[cfg(unix)]
#[test]
fn nfr_08_write_cas_preserves_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, vault) = fresh();
    let p = vp("x.md");
    let h = vault.write_cas(&p, b"a", None).unwrap();
    let full = dir.path().join("x.md");
    std::fs::set_permissions(&full, std::fs::Permissions::from_mode(0o640)).unwrap();
    vault.write_cas(&p, b"b", Some(h)).unwrap();
    assert_eq!(
        std::fs::metadata(&full).unwrap().permissions().mode() & 0o777,
        0o640
    );
}

#[test]
fn exp_02_create_dir_and_rename() {
    let (dir, vault) = fresh();
    vault.create_dir(&vp("A")).unwrap();
    assert!(matches!(
        vault.create_dir(&vp("A")),
        Err(VaultError::AlreadyExists(_))
    ));
    assert!(matches!(
        vault.create_dir(&vp("X/Y")),
        Err(VaultError::NotFound(_))
    ));
    vault.write_cas(&vp("A/n.md"), b"n", None).unwrap();
    vault.write_cas(&vp("m.md"), b"m", None).unwrap();
    assert!(matches!(
        vault.rename(&vp("A/n.md"), &vp("m.md")),
        Err(VaultError::AlreadyExists(_))
    ));
    vault.create_dir(&vp("B")).unwrap();
    vault.rename(&vp("A"), &vp("B/A2")).unwrap();
    assert!(dir.path().join("B/A2/n.md").is_file());
    assert!(matches!(
        vault.rename(&vp("gone.md"), &vp("z.md")),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        vault.rename(&vp("m.md"), &vp("no/dir.md")),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn exp_02_case_only_rename() {
    let (dir, vault) = fresh();
    vault.write_cas(&vp("ideas.md"), b"x", None).unwrap();
    vault.rename(&vp("ideas.md"), &vp("Ideas.md")).unwrap();
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, vec!["Ideas.md".to_string()]);
}

#[test]
fn exp_03_trash_moves_to_os_trash() {
    let dir = trashable_fixture("ambiguous-names");
    let vault = Vault::open(dir.path()).unwrap();
    vault.trash(&vp("Archive")).unwrap();
    assert!(!dir.path().join("Archive").exists());
    assert!(matches!(
        vault.trash(&vp("Archive")),
        Err(VaultError::NotFound(_))
    ));
}

#[cfg(unix)]
#[test]
fn review_focus_writes_through_symlink_escaping_the_vault_are_refused() {
    let (dir, vault) = fresh();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();
    assert!(matches!(
        vault.write_cas(&vp("out/evil.md"), b"x", None),
        Err(VaultError::OutsideVault(_))
    ));
    assert!(!outside.path().join("evil.md").exists());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn nfr_08_successive_writes_round_trip_without_temp_leftovers(
        contents in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..2048), 1..6)
    ) {
        let (dir, vault) = fresh();
        let p = vp("p.md");
        let mut expected = None;
        for c in &contents {
            expected = Some(vault.write_cas(&p, c, expected).unwrap());
            prop_assert_eq!(&std::fs::read(dir.path().join("p.md")).unwrap(), c);
        }
        let count = std::fs::read_dir(dir.path()).unwrap().count();
        prop_assert_eq!(count, 1);
    }
}
