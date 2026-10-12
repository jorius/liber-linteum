use nimw_vault::{Hash, VaultError, VaultPath};

#[test]
fn vlt_path_public_api() {
    let p = VaultPath::new("Projects/Ideas.md").unwrap();
    assert_eq!(
        (p.as_str(), p.stem(), p.extension()),
        ("Projects/Ideas.md", "Ideas", Some("md"))
    );
    assert_eq!(
        p.parent().unwrap().join("Other.md").unwrap().as_str(),
        "Projects/Other.md"
    );
    assert!(matches!(
        VaultPath::new("../escape"),
        Err(VaultError::OutsideVault(_))
    ));
    assert!(VaultPath::root().is_root());
}

#[test]
fn nfr_08_hash_public_api() {
    let h = Hash::of(b"note");
    assert_eq!(Hash::from_hex(&h.to_hex()), Some(h));
    assert_eq!(h.to_string().len(), 64);
}
