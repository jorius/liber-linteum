//! Folder and vault icons (M5b §4) in `.liber/vault.json`: `folderIcons` maps
//! folder paths to an emoji and follows renames, forgotten on delete; `icon`
//! is the vault's own. Page icons live in the note's frontmatter instead.

use liber_vault::{Vault, vault_icon_at};

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

#[test]
fn nothing_set_writes_nothing() {
    let (dir, vault) = fresh();
    assert!(vault.folder_icons().is_empty());
    assert_eq!(vault.vault_icon(), None);
    vault.set_folder_icon("A", None).unwrap();
    vault.set_vault_icon(None).unwrap();
    vault.forget_folder_icons(&["A".to_string()]).unwrap();
    vault
        .remap_folder_icons_many(&[("A".to_string(), "B".to_string())])
        .unwrap();
    assert!(!dir.path().join(".liber").exists());
    assert_eq!(vault_icon_at(dir.path()), None);
}

#[test]
fn folder_icons_follow_renames_and_are_forgotten() {
    let (_dir, vault) = fresh();
    vault.set_folder_icon("Lore", Some("🐉")).unwrap();
    vault.set_folder_icon("Lore/Maps", Some("🗺️")).unwrap();
    vault
        .remap_folder_icons_many(&[("Lore".to_string(), "World".to_string())])
        .unwrap();
    let icons: Vec<_> = vault.folder_icons().into_iter().collect();
    assert_eq!(
        icons,
        vec![
            ("World".to_string(), "🐉".to_string()),
            ("World/Maps".to_string(), "🗺️".to_string())
        ]
    );
    vault.forget_folder_icons(&["World".to_string()]).unwrap();
    assert!(vault.folder_icons().is_empty());
}

#[test]
fn the_vault_icon_round_trips_and_is_read_without_opening() {
    let (dir, vault) = fresh();
    vault.set_vault_icon(Some("🌌")).unwrap();
    assert_eq!(vault.vault_icon().as_deref(), Some("🌌"));
    assert_eq!(vault_icon_at(dir.path()).as_deref(), Some("🌌"));
    vault.set_vault_icon(None).unwrap();
    assert_eq!(vault.vault_icon(), None);
    // Hand-edited junk reads as no icon.
    std::fs::write(dir.path().join(".liber/vault.json"), r#"{"icon":42}"#).unwrap();
    assert_eq!(vault.vault_icon(), None);
}
