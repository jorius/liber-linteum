//! M2c §5.3 / §7.1: where attachments go (Obsidian → `.nimw/vault.json` →
//! default), NIMW's own setting written without losing other keys, folders
//! created on demand and streamed create-only copies.

use nimw_testkit::copy_fixture;
use nimw_vault::{AttachmentPolicy, Hash, Vault, VaultError, VaultPath};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

#[test]
fn m2c_obsidian_setting_wins_over_nimw_and_is_re_read() {
    let dir = copy_fixture("obsidian-basic"); // app.json: "./assets"
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{ "attachments": { "mode": "same" } }"#,
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Subfolder("assets".into())
    );
    let config = vault.attachment_config();
    assert_eq!(config.obsidian.as_deref(), Some("./assets"));
    assert_eq!((config.mode.as_str(), config.path.as_str()), ("same", ""));

    // Obsidian's key removed while the vault is open: NIMW's setting applies.
    std::fs::write(dir.path().join(".obsidian/app.json"), "{}").unwrap();
    assert_eq!(vault.attachment_policy(), AttachmentPolicy::SameAsNote);
    assert_eq!(vault.attachment_config().obsidian, None);
}

#[test]
fn m2c_default_is_attachments_next_to_the_page() {
    let (_dir, vault) = fresh();
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Subfolder("attachments".into())
    );
    let config = vault.attachment_config();
    assert_eq!(
        (config.mode.as_str(), config.path.as_str()),
        ("subfolder", "attachments")
    );
    assert_eq!(config.obsidian, None);
}

#[test]
fn m2c_folder_mode_and_dirs_per_policy() {
    let (_dir, vault) = fresh();
    let page = vp("Projects/Rex/Notes.md");
    let dir_for = |p: &AttachmentPolicy| p.dir_for(&page).ok().map(|d| d.to_string());
    assert_eq!(dir_for(&AttachmentPolicy::VaultRoot).as_deref(), Some(""));
    assert_eq!(
        dir_for(&AttachmentPolicy::SameAsNote).as_deref(),
        Some("Projects/Rex")
    );
    assert_eq!(
        dir_for(&AttachmentPolicy::Subfolder("assets/img".into())).as_deref(),
        Some("Projects/Rex/assets/img")
    );
    assert_eq!(
        dir_for(&AttachmentPolicy::Folder(vp("Media"))).as_deref(),
        Some("Media")
    );
    vault
        .set_nimw_attachments("folder", "Media/Img", None)
        .unwrap();
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Folder(vp("Media/Img"))
    );
}

#[test]
fn m2c_set_nimw_attachments_keeps_other_keys_and_creates_nimw_lazily() {
    let (dir, vault) = fresh();
    assert!(
        !dir.path().join(".nimw").exists(),
        "VLT-02: nothing written on open"
    );
    vault.set_nimw_attachments("same", "", None).unwrap();
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join(".nimw/vault.json")).unwrap())
            .unwrap();
    assert_eq!(json["attachments"]["mode"], "same");
    assert_eq!(json["version"], 1);

    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{ "version": 1, "exclude": ["Drafts/**"], "viewMode": "drill", "future": {"x": 1} }"#,
    )
    .unwrap();
    vault
        .set_nimw_attachments("subfolder", "files", None)
        .unwrap();
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join(".nimw/vault.json")).unwrap())
            .unwrap();
    assert_eq!(json["exclude"][0], "Drafts/**");
    assert_eq!(json["viewMode"], "drill");
    assert_eq!(json["future"]["x"], 1);
    assert_eq!(json["attachments"]["path"], "files");
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Subfolder("files".into())
    );
}

#[test]
fn m2c_set_nimw_attachments_refuses_bad_values_and_never_clobbers_broken_json() {
    let (dir, vault) = fresh();
    for (mode, path) in [
        ("folder", "../out"),
        ("folder", ""),
        ("weird", "x"),
        ("subfolder", "a//b"),
    ] {
        assert!(
            matches!(
                vault.set_nimw_attachments(mode, path, None),
                Err(VaultError::InvalidConfig { .. })
            ),
            "{mode} {path}"
        );
    }
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(dir.path().join(".nimw/vault.json"), "{ not json").unwrap();
    assert!(matches!(
        vault.set_nimw_attachments("same", "", None),
        Err(VaultError::InvalidConfig { .. })
    ));
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".nimw/vault.json")).unwrap(),
        "{ not json"
    );
}

#[test]
fn m2c_create_dir_all_reports_what_it_created() {
    let (dir, vault) = fresh();
    std::fs::create_dir(dir.path().join("A")).unwrap();
    let created = vault.create_dir_all(&vp("A/B/C")).unwrap();
    assert_eq!(
        created.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
        ["A/B", "A/B/C"]
    );
    assert!(dir.path().join("A/B/C").is_dir());
    assert!(vault.create_dir_all(&vp("A/B/C")).unwrap().is_empty());
    assert!(vault.create_dir_all(&VaultPath::root()).unwrap().is_empty());
    std::fs::write(dir.path().join("file"), b"x").unwrap();
    assert!(matches!(
        vault.create_dir_all(&vp("file/sub")),
        Err(VaultError::AlreadyExists(_))
    ));
}

#[test]
fn m2c_import_file_streams_a_create_only_copy() {
    let (dir, vault) = fresh();
    let outside = tempfile::tempdir().unwrap();
    let src = outside.path().join("photo.png");
    let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&src, &bytes).unwrap();
    let hash = vault.import_file(&src, &vp("photo.png")).unwrap();
    assert_eq!(hash, Hash::of(&bytes));
    assert_eq!(std::fs::read(dir.path().join("photo.png")).unwrap(), bytes);
    // Never overwrites, leaves no temp file behind.
    std::fs::write(&src, b"other").unwrap();
    assert!(matches!(
        vault.import_file(&src, &vp("photo.png")),
        Err(VaultError::AlreadyExists(_))
    ));
    assert_eq!(std::fs::read(dir.path().join("photo.png")).unwrap(), bytes);
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, ["photo.png"]);
    // Missing parent folder.
    assert!(matches!(
        vault.import_file(&src, &vp("no/such/x.png")),
        Err(VaultError::NotFound(_))
    ));
}

/// M4b §5: NIMW's own setting can override Obsidian's when the user says so;
/// `.obsidian/app.json` is never written.
#[test]
fn m4b_nimw_override_wins_over_obsidian_until_turned_off() {
    let dir = copy_fixture("obsidian-basic"); // app.json: "./assets"
    let app_json = std::fs::read(dir.path().join(".obsidian/app.json")).unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert!(!vault.attachment_config().override_obsidian);

    vault.set_nimw_attachments("same", "", Some(true)).unwrap();
    assert_eq!(vault.attachment_policy(), AttachmentPolicy::SameAsNote);
    let config = vault.attachment_config();
    assert!(config.override_obsidian);
    assert_eq!(config.obsidian.as_deref(), Some("./assets"));

    // Changing the place keeps the override (None leaves the flag as is).
    vault.set_nimw_attachments("folder", "Media", None).unwrap();
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Folder(VaultPath::new("Media").unwrap())
    );
    assert!(vault.attachment_config().override_obsidian);

    // Off: Obsidian's applies again; NIMW's choice is kept for next time.
    vault
        .set_nimw_attachments("folder", "Media", Some(false))
        .unwrap();
    assert_eq!(
        vault.attachment_policy(),
        AttachmentPolicy::Subfolder("assets".into())
    );
    let config = vault.attachment_config();
    assert!(!config.override_obsidian);
    assert_eq!(
        (config.mode.as_str(), config.path.as_str()),
        ("folder", "Media")
    );
    let stored: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join(".nimw/vault.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(stored["attachments"]["overrideObsidian"], false);
    assert_eq!(
        std::fs::read(dir.path().join(".obsidian/app.json")).unwrap(),
        app_json,
        "Obsidian's file is never written"
    );
}
