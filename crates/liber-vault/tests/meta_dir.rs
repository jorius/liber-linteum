//! Rename to Liber Linteum: a vault's `.nimw/` folder becomes `.liber/` on
//! open, never merged and never deleted.

use liber_vault::{LEGACY_META_DIR, META_DIR, Vault, vault_icon_at};
use std::fs;
use std::path::Path;

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn legacy(rel: &str) -> String {
    format!("{LEGACY_META_DIR}/{rel}")
}

#[test]
fn legacy_meta_dir_is_pinned() {
    // Split so a future sweep can't rewrite the expected value.
    assert_eq!(LEGACY_META_DIR, concat!(".", "ni", "mw"));
    assert_eq!(META_DIR, ".liber");
}

#[test]
fn old_vault_migrates_on_open() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        &legacy("vault.json"),
        r#"{"favorites":["A.md"]}"#,
    );
    write(dir.path(), &legacy("trash.json"), "[]");
    write(dir.path(), "A.md", "# A");
    let v = Vault::open(dir.path()).unwrap();
    assert!(!dir.path().join(LEGACY_META_DIR).exists());
    assert_eq!(
        fs::read_to_string(dir.path().join(".liber/vault.json")).unwrap(),
        r#"{"favorites":["A.md"]}"#
    );
    assert_eq!(
        fs::read_to_string(dir.path().join(".liber/trash.json")).unwrap(),
        "[]"
    );
    assert_eq!(v.favorites(), vec!["A.md".to_string()]);
}

#[test]
fn fresh_vault_open_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "A.md", "# A");
    let v = Vault::open(dir.path()).unwrap();
    assert!(!dir.path().join(META_DIR).exists());
    assert!(!dir.path().join(LEGACY_META_DIR).exists());
    v.set_favorites(&["A.md".to_string()]).unwrap();
    assert!(dir.path().join(".liber/vault.json").is_file());
}

#[test]
fn both_exist_liber_wins_and_nimw_is_untouched() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        &legacy("vault.json"),
        r#"{"favorites":["Old.md"]}"#,
    );
    write(
        dir.path(),
        ".liber/vault.json",
        r#"{"favorites":["New.md"]}"#,
    );
    let v = Vault::open(dir.path()).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join(legacy("vault.json"))).unwrap(),
        r#"{"favorites":["Old.md"]}"#
    );
    assert_eq!(v.favorites(), vec!["New.md".to_string()]);
    assert!(
        v.warnings().iter().any(|w| w.contains(LEGACY_META_DIR)),
        "{:?}",
        v.warnings()
    );
}

#[cfg(unix)]
#[test]
fn rename_failure_keeps_nimw_and_warns() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        &legacy("vault.json"),
        r#"{"favorites":["A.md"]}"#,
    );
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    let opened = Vault::open(dir.path());
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let v = opened.unwrap();
    assert!(dir.path().join(legacy("vault.json")).is_file());
    assert!(!v.warnings().is_empty());
    Vault::open(dir.path()).unwrap();
    assert!(!dir.path().join(LEGACY_META_DIR).exists());
    assert!(dir.path().join(".liber/vault.json").is_file());
}

#[test]
fn a_file_named_like_the_legacy_folder_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), LEGACY_META_DIR, "not a folder");
    Vault::open(dir.path()).unwrap();
    assert!(dir.path().join(LEGACY_META_DIR).is_file());
    assert!(!dir.path().join(META_DIR).exists());
}

#[test]
fn icon_peek_does_not_migrate() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), &legacy("vault.json"), r#"{"icon":"🛡️"}"#);
    assert_eq!(vault_icon_at(dir.path()).as_deref(), Some("🛡️"));
    assert!(dir.path().join(LEGACY_META_DIR).is_dir());
    assert!(!dir.path().join(META_DIR).exists());
}
