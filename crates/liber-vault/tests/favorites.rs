//! Favorites (M5b §19) in `.liber/vault.json`: `favorites` lists vault paths in
//! the order they were added; entries follow renames (into the Trash and the
//! Archive too) and are forgotten on delete.

use liber_vault::Vault;

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn s(items: &[&str]) -> Vec<String> {
    items.iter().map(|p| p.to_string()).collect()
}

#[test]
fn nothing_set_writes_nothing() {
    let (dir, vault) = fresh();
    assert!(vault.favorites().is_empty());
    vault.set_favorites(&[]).unwrap();
    vault.forget_favorites(&s(&["A.md"])).unwrap();
    vault
        .remap_favorites_many(&[("A".to_string(), "B".to_string())])
        .unwrap();
    assert!(!dir.path().join(".liber").exists());
}

#[test]
fn favorites_keep_their_order_and_other_keys() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    vault.set_vault_icon(Some("🌌")).unwrap();
    vault.set_favorites(&s(&["B.md", "A", "C.md"])).unwrap();
    assert_eq!(vault.favorites(), s(&["B.md", "A", "C.md"]));
    assert_eq!(vault.vault_icon().as_deref(), Some("🌌"));
    // An emptied list removes the key.
    vault.set_favorites(&[]).unwrap();
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join(".liber/vault.json")).unwrap())
            .unwrap();
    assert!(json.get("favorites").is_none());
    // Hand-edited junk: non-strings are left out, a non-list reads as none.
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{"favorites":["A.md",4,null,"B"]}"#,
    )
    .unwrap();
    assert_eq!(vault.favorites(), s(&["A.md", "B"]));
    std::fs::write(dir.path().join(".liber/vault.json"), r#"{"favorites":"A"}"#).unwrap();
    assert!(vault.favorites().is_empty());
}

#[test]
fn favorites_follow_renames_and_moves_in_place() {
    let (_dir, vault) = fresh();
    vault
        .set_favorites(&s(&["Lore/Dragons.md", "Maps", "Alphabet.md", "Lore"]))
        .unwrap();
    vault
        .remap_favorites_many(&[
            ("Lore".to_string(), "World".to_string()),
            ("Alpha".to_string(), "Beta".to_string()),
        ])
        .unwrap();
    // Whole components only: `Alpha` never touches `Alphabet.md`.
    assert_eq!(
        vault.favorites(),
        s(&["World/Dragons.md", "Maps", "Alphabet.md", "World"])
    );
    // Into the Trash and back, keeping the place in the list.
    vault
        .remap_favorites_many(&[("Maps".to_string(), ".trash/Maps".to_string())])
        .unwrap();
    assert_eq!(vault.favorites()[1], ".trash/Maps");
    vault
        .remap_favorites_many(&[(".trash/Maps".to_string(), "Maps".to_string())])
        .unwrap();
    assert_eq!(vault.favorites()[1], "Maps");
}

#[test]
fn deleted_entries_and_everything_inside_are_forgotten() {
    let (_dir, vault) = fresh();
    vault
        .set_favorites(&s(&["World", "World/Dragons.md", "Worldly.md", "Maps"]))
        .unwrap();
    vault.forget_favorites(&s(&["World"])).unwrap();
    assert_eq!(vault.favorites(), s(&["Worldly.md", "Maps"]));
}
