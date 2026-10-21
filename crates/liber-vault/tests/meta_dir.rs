//! Rename to Liber Linteum: a vault's `.nimw/` folder becomes `.liber/` on
//! open, never merged and never deleted.

mod support;

#[cfg(unix)]
use liber_vault::WARN_UNMOVED;
use liber_vault::{LEGACY_META_DIR, META_DIR, Vault, WARN_BOTH, vault_icon_at};
use std::fs;
use std::path::Path;
use support::Spy;

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
    if liber_testkit::plain_disk_only() {
        return;
    }
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
    if liber_testkit::plain_disk_only() {
        return;
    }
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
    if liber_testkit::plain_disk_only() {
        return;
    }
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
        v.warnings().iter().any(|w| w == WARN_BOTH),
        "{:?}",
        v.warnings()
    );
}

#[cfg(unix)]
#[test]
fn rename_failure_keeps_nimw_and_warns() {
    // Plaintext folder permissions don't survive sealing.
    if liber_testkit::plain_disk_only() {
        return;
    }
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
    assert!(v.warnings().iter().any(|w| w.starts_with(WARN_UNMOVED)));
    Vault::open(dir.path()).unwrap();
    assert!(!dir.path().join(LEGACY_META_DIR).exists());
    assert!(dir.path().join(".liber/vault.json").is_file());
}

#[test]
fn a_file_named_like_the_legacy_folder_is_ignored() {
    if liber_testkit::plain_disk_only() {
        return;
    }
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

/// Puts a folder's mode back on drop, so a failed assert still lets the
/// temp dir be removed.
#[cfg(unix)]
struct ReadOnly<'a>(&'a Path);

#[cfg(unix)]
impl<'a> ReadOnly<'a> {
    fn new(p: &'a Path) -> Self {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o555)).unwrap();
        ReadOnly(p)
    }
}

#[cfg(unix)]
impl Drop for ReadOnly<'_> {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(self.0, fs::Permissions::from_mode(0o755));
    }
}

/// Rename review I1: while the move hasn't happened (read-only root, a folder
/// held open on Windows), the settings are read and written where they are;
/// a later writable open moves them with everything kept.
#[cfg(unix)]
#[test]
fn unmoved_legacy_folder_is_read_and_written_in_place() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        &legacy("vault.json"),
        r#"{"favorites":["A.md"]}"#,
    );
    write(
        dir.path(),
        &legacy("trash.json"),
        r#"{"items":{".trash/B.md":{"from":"Notes/B.md","at":1}}}"#,
    );
    write(dir.path(), "A.md", "# A");
    {
        let _ro = ReadOnly::new(dir.path());
        let v = Vault::open(dir.path()).unwrap();
        assert_eq!(v.favorites(), vec!["A.md".to_string()]);
        assert_eq!(
            v.bin_records(liber_vault::Bin::Trash)[".trash/B.md"].from,
            "Notes/B.md"
        );
        v.add_spelling_word("x").unwrap();
        assert!(v.spelling_stamp().is_some());
        assert!(!dir.path().join(META_DIR).exists());
        let raw = fs::read_to_string(dir.path().join(legacy("vault.json"))).unwrap();
        assert!(raw.contains("A.md") && raw.contains("\"x\""), "{raw}");
        assert_eq!(v.spelling_words(), vec!["x".to_string()]);
    }
    let v = Vault::open(dir.path()).unwrap();
    assert!(!dir.path().join(LEGACY_META_DIR).exists());
    assert_eq!(v.favorites(), vec!["A.md".to_string()]);
    assert_eq!(v.spelling_words(), vec!["x".to_string()]);
}

/// Rename review M2: with both folders, `.liber/` is the only source, so an
/// icon left in the old folder doesn't come back.
#[test]
fn both_exist_icon_comes_from_liber_only() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), &legacy("vault.json"), r#"{"icon":"🛡️"}"#);
    write(dir.path(), ".liber/vault.json", r#"{"favorites":[]}"#);
    let v = Vault::open(dir.path()).unwrap();
    assert_eq!(v.vault_icon(), None);
    assert_eq!(vault_icon_at(dir.path()), None);
}

/// E2: the move is a vault rename like any other, through `Storage`.
#[test]
fn legacy_folder_moves_through_storage() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        &legacy("vault.json"),
        r#"{"favorites":["A.md"]}"#,
    );
    let spy = Spy::open(dir.path());
    let renames = spy.renames.clone();
    let v = Vault::open_with(Box::new(spy)).unwrap();
    assert_eq!(
        *renames.lock().unwrap(),
        [(LEGACY_META_DIR.to_string(), META_DIR.to_string())]
    );
    assert_eq!(v.favorites(), vec!["A.md".to_string()]);
}

/// A legacy folder that is a symlink to a folder inside the vault counts as
/// the legacy folder, as `is_dir` (which follows links) did.
#[cfg(unix)]
#[test]
fn legacy_folder_linked_inside_the_vault_is_moved() {
    // No symlinks in an encrypted vault (E3).
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "cfg/vault.json", r#"{"favorites":["A.md"]}"#);
    std::os::unix::fs::symlink(dir.path().join("cfg"), dir.path().join(LEGACY_META_DIR)).unwrap();
    let v = Vault::open(dir.path()).unwrap();
    assert!(v.opened_legacy_settings());
    assert!(dir.path().join(META_DIR).is_dir());
    assert_eq!(v.favorites(), vec!["A.md".to_string()]);
}
