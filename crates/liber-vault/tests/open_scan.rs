use liber_testkit::{copy_fixture, fixture_path, snapshot};
use liber_vault::{AttachmentPolicy, EntryKind, Vault, VaultError, VaultPath};

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
        AttachmentPolicy::Subfolder("assets".into())
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
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{ "version": 1, "exclude": ["Game Design", "Game Design/**", "**/*.mp3", "[bad"],
            "attachments": { "mode": "same" } }"#,
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let p = paths(&vault);
    assert!(!p.iter().any(|x| x.starts_with("Game Design")), "{p:?}");
    assert!(!p.iter().any(|x| x.ends_with(".mp3")));
    // M2c §5.3: Obsidian's `./assets` wins over Liber Linteum's `same`.
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Subfolder("assets".into())
    );
    assert_eq!(
        vault.warnings().len(),
        1,
        "bad glob reported: {:?}",
        vault.warnings()
    );

    std::fs::write(dir.path().join(".liber/vault.json"), "{ not json").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert!(vault.warnings()[0].contains(".liber/vault.json"));
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Subfolder("assets".into())
    );
}

/// Final review m9: `.liber/vault.json` is read field by field. A malformed
/// or future-shaped field (e.g. an `indexPicks` entry that isn't a path)
/// is reported and ignored on its own; it never takes `exclude` (which
/// keeps private folders out of the index) or `attachments` with it.
#[test]
fn m3a_a_malformed_field_in_vault_json_never_disables_the_excludes() {
    let dir = tempfile::tempdir().unwrap();
    for page in ["Private/secret.md", "Notes/a.md"] {
        let path = dir.path().join(page);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "# page\n").unwrap();
    }
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    let open = |json: &str| {
        std::fs::write(dir.path().join(".liber/vault.json"), json).unwrap();
        Vault::open(dir.path()).unwrap()
    };
    let hidden = |vault: &Vault| !paths(vault).iter().any(|p| p.ends_with("secret.md"));

    let vault = open(
        r#"{ "version": 1, "exclude": ["Private/**", 7], "attachments": { "mode": "same" },
             "indexPicks": { "Notes": "Notes/a.md", "A": null, "B": { "page": "x.md" } } }"#,
    );
    assert!(vault.is_excluded("Private/secret.md"));
    assert!(hidden(&vault), "{:?}", paths(&vault));
    assert_eq!(vault.attachment_policy(), AttachmentPolicy::SameAsNote);
    assert_eq!(
        vault.index_picks(),
        [("Notes".to_string(), "Notes/a.md".to_string())].into()
    );
    let warnings = vault.warnings().join("\n");
    assert!(
        warnings.contains("indexPicks") && warnings.contains("exclude"),
        "{warnings}"
    );

    let vault =
        open(r#"{ "exclude": ["Private/**"], "attachments": { "mode": 3 }, "indexPicks": [] }"#);
    assert!(hidden(&vault), "{:?}", paths(&vault));
    assert_eq!(vault.attachment_policy(), AttachmentPolicy::default());
    assert!(vault.index_picks().is_empty());

    let vault = open(r#"{ "exclude": "Private/**", "attachments": "same" }"#);
    assert!(hidden(&vault), "a single glob is a list of one");
}

#[test]
fn vlt_02_open_and_scan_write_nothing() {
    for name in ["obsidian-basic", "ambiguous-names", "edge-cases"] {
        let dir = copy_fixture(name);
        let before = snapshot(dir.path());
        let vault = Vault::open(dir.path()).unwrap();
        vault.scan().unwrap();
        assert_eq!(snapshot(dir.path()), before, "{name} changed");
        assert!(!dir.path().join(".liber").exists());
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
    let fs = vault
        .os_path(
            &VaultPath::new("Game Design/Game 1.md").unwrap(),
            liber_vault::OsUse::Open,
        )
        .unwrap();
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

/// M5b §5.3: the root `.archive` is the one hidden folder the vault reads
/// (archived pages stay indexed); `.trash` and other dot folders stay hidden.
#[test]
fn m5b_archive_is_scanned_stat_ed_and_served_but_other_hidden_folders_are_not() {
    let dir = tempfile::tempdir().unwrap();
    for f in [
        ".archive/P/a.md",
        ".archive/.x/h.md",
        ".trash/b.md",
        ".obsidian/c.md",
        "P/.archive/d.md",
        "e.md",
    ] {
        let full = dir.path().join(f);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, "x").unwrap();
    }
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(
        paths(&vault),
        [".archive", ".archive/P", ".archive/P/a.md", "P", "e.md"]
    );
    let vp = |s: &str| VaultPath::new(s).unwrap();
    assert!(vault.stat(&vp(".archive/P/a.md")).unwrap().is_some());
    assert!(vault.stat(&vp(".trash/b.md")).unwrap().is_none());
    assert!(vault.stat(&vp("P/.archive/d.md")).unwrap().is_none());
    let visible = liber_vault::Reach::Visible;
    assert!(vault.open_read(&vp(".archive/P/a.md"), visible).is_ok());
    assert!(vault.open_read(&vp(".archive/.x/h.md"), visible).is_err());
    assert!(liber_vault::is_hidden_path(".trash/b.md"));
    assert!(!liber_vault::is_hidden_path(".archive"));
    assert!(liber_vault::is_hidden_path(".archive/.x"));
}

/// E2: the walk runs on `Storage`, and every skip message keeps the text it
/// had (scan reports them as they are).
#[cfg(unix)]
#[test]
fn e2_scan_skip_messages_keep_their_text() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir(root.join("Projects")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("leakdir")).unwrap();
    std::os::unix::fs::symlink(root.join("Projects"), root.join("loop")).unwrap();
    std::fs::write(root.join("a\\b.md"), "x").unwrap();
    let locked = root.join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::read_dir(&locked).is_ok(); // running as root
    let vault = Vault::open(root).unwrap();
    let scan = vault.scan();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut skipped = scan.unwrap().skipped;
    skipped.sort();
    let mut expected = vec![
        format!("{}: invalid name", vault.root().join("a\\b.md").display()),
        "leakdir: symlink points outside the vault".to_string(),
        "loop: symlinked folder not followed".to_string(),
    ];
    if !readable {
        let denied = std::io::Error::from_raw_os_error(13); // EACCES
        expected.push(format!("locked: folder not readable ({denied})"));
    }
    expected.sort();
    assert_eq!(skipped, expected);
}
