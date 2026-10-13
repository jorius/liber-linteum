use nimw_testkit::{copy_fixture, fixture_path, snapshot};
use nimw_vault::{AttachmentPolicy, EntryKind, Vault, VaultError, VaultPath};

fn paths(vault: &Vault) -> Vec<String> {
    vault
        .scan()
        .unwrap()
        .entries
        .iter()
        .map(|e| e.path.to_string())
        .collect()
}

#[test]
fn vlt_01_open_reads_obsidian_attachment_setting() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    assert_eq!(
        vault.attachment_policy(),
        &AttachmentPolicy::Subfolder("assets".into())
    );
    assert!(vault.warnings().is_empty(), "{:?}", vault.warnings());
}

#[test]
fn vlt_01_open_missing_folder_is_not_found() {
    let err = Vault::open(std::path::Path::new("/definitely/not/here")).unwrap_err();
    assert!(matches!(err, VaultError::NotFound(_)), "{err:?}");
}

#[test]
fn vlt_05_scan_skips_hidden_entries_and_sorts() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let p = paths(&vault);
    assert!(
        p.iter()
            .all(|x| !x.contains(".obsidian") && !x.contains(".trash"))
    );
    let mut sorted = p.clone();
    sorted.sort();
    assert_eq!(p, sorted);
    assert!(p.contains(&"Character Design/assets/rex-cover.png".to_string()));
    assert!(p.contains(&"Character Design/DMC".to_string()));
}

#[test]
fn vlt_05_scan_reports_kinds_and_sizes() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let scan = vault.scan().unwrap();
    let welcome = scan
        .entries
        .iter()
        .find(|e| e.path.as_str() == "Welcome.md")
        .unwrap();
    assert_eq!(welcome.kind, EntryKind::File);
    assert!(welcome.size > 0 && welcome.mtime_ns > 0);
    let dir = scan
        .entries
        .iter()
        .find(|e| e.path.as_str() == "Game Design")
        .unwrap();
    assert_eq!(dir.kind, EntryKind::Dir);
}

#[test]
fn vlt_05_exclude_globs_and_bad_config_are_handled() {
    let dir = copy_fixture("obsidian-basic");
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{ "version": 1, "exclude": ["Game Design", "Game Design/**", "**/*.mp3", "[bad"],
            "attachments": { "mode": "same" } }"#,
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let p = paths(&vault);
    assert!(!p.iter().any(|x| x.starts_with("Game Design")), "{p:?}");
    assert!(!p.iter().any(|x| x.ends_with(".mp3")));
    assert_eq!(vault.attachment_policy(), &AttachmentPolicy::SameAsNote);
    assert_eq!(
        vault.warnings().len(),
        1,
        "bad glob reported: {:?}",
        vault.warnings()
    );

    std::fs::write(dir.path().join(".nimw/vault.json"), "{ not json").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert!(vault.warnings()[0].contains(".nimw/vault.json"));
    assert_eq!(
        vault.attachment_policy(),
        &AttachmentPolicy::Subfolder("assets".into())
    );
}

#[test]
fn vlt_02_open_and_scan_write_nothing() {
    for name in ["obsidian-basic", "ambiguous-names", "edge-cases"] {
        let dir = copy_fixture(name);
        let before = snapshot(dir.path());
        let vault = Vault::open(dir.path()).unwrap();
        vault.scan().unwrap();
        assert_eq!(snapshot(dir.path()), before, "{name} changed");
        assert!(!dir.path().join(".nimw").exists());
    }
}

#[cfg(unix)]
#[test]
fn review_focus_symlinks_outside_vault_and_folder_symlinks_are_skipped() {
    let dir = copy_fixture("ambiguous-names");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), "# secret").unwrap();
    let root = dir.path();
    std::os::unix::fs::symlink(outside.path().join("secret.md"), root.join("leak.md")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("leakdir")).unwrap();
    std::os::unix::fs::symlink(root.join("Projects"), root.join("loop")).unwrap();
    std::os::unix::fs::symlink(root.join("Ideas.md"), root.join("alias.md")).unwrap();
    let vault = Vault::open(root).unwrap();
    let scan = vault.scan().unwrap();
    let p: Vec<_> = scan.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(!p.contains(&"leak.md"));
    assert!(
        !p.iter()
            .any(|x| x.starts_with("leakdir") || x.starts_with("loop"))
    );
    assert!(p.contains(&"alias.md"), "in-vault file symlink is kept");
    assert_eq!(scan.skipped.len(), 3, "{:?}", scan.skipped);
}

#[test]
fn vault_path_maps_back_from_fs() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let fs = VaultPath::new("Game Design/Game 1.md")
        .unwrap()
        .to_fs_path(vault.root());
    assert!(fs.is_file());
}

#[test]
fn scan_from_list_dir_and_stat() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let dir = VaultPath::new("Character Design").unwrap();
    let sub: Vec<_> = vault
        .scan_from(&dir)
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.path.to_string())
        .collect();
    assert!(sub.contains(&"Character Design/DMC/Sparda.md".to_string()));
    assert!(sub.iter().all(|p| p.starts_with("Character Design/")));
    let children: Vec<_> = vault
        .list_dir(&dir)
        .unwrap()
        .into_iter()
        .map(|e| e.path.to_string())
        .collect();
    assert_eq!(
        children,
        vec![
            "Character Design/DMC",
            "Character Design/My characters.md",
            "Character Design/assets",
            "Character Design/rex-draft.md"
        ]
    );
    let st = vault
        .stat(&VaultPath::new("Welcome.md").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(st.kind, EntryKind::File);
    assert!(
        vault
            .stat(&VaultPath::new("nope.md").unwrap())
            .unwrap()
            .is_none()
    );
    assert!(
        vault
            .stat(&VaultPath::new(".obsidian/app.json").unwrap())
            .unwrap()
            .is_none()
    );
}

/// Final review I3: one unreadable subfolder is a warning, not a failed open.
#[cfg(unix)]
#[test]
fn vlt_01_unreadable_subfolder_is_skipped_not_fatal() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "# a").unwrap();
    let locked = dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("secret.md"), "# s").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::read_dir(&locked).is_ok(); // running as root
    let vault = Vault::open(dir.path()).unwrap();
    let scan = vault.scan();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    if readable {
        return;
    }
    let scan = scan.expect("scan must not fail on one unreadable folder");
    let names: Vec<_> = scan.entries.iter().map(|e| e.path.to_string()).collect();
    assert_eq!(names, vec!["a.md", "locked"]);
    assert!(
        scan.skipped.iter().any(|s| s.contains("locked")),
        "{:?}",
        scan.skipped
    );
}
