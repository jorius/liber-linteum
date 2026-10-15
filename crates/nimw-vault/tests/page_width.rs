//! M4b part 2 §1: full page width per vault and per page in `.nimw/vault.json`.

use nimw_vault::{PageWidth, Vault};

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn file(dir: &tempfile::TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join(".nimw/vault.json")).unwrap()).unwrap()
}

#[test]
fn m4b2_nothing_set_reads_as_nothing_and_writes_nothing() {
    let (dir, vault) = fresh();
    let widths = vault.page_widths();
    assert_eq!(widths.vault, None);
    assert!(widths.pages.is_empty());
    // Clearing what isn't set never creates `.nimw/` (VLT-02).
    vault.set_page_width("A.md", None).unwrap();
    vault.set_vault_page_width(None).unwrap();
    assert!(!dir.path().join(".nimw").exists());
}

#[test]
fn m4b2_page_and_vault_widths_round_trip_and_keep_other_keys() {
    let (dir, vault) = fresh();
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{"exclude":["Private/**"],"future":{"x":1}}"#,
    )
    .unwrap();
    vault
        .set_page_width("Notes/A.md", Some(PageWidth::Full))
        .unwrap();
    vault
        .set_page_width("B.md", Some(PageWidth::Readable))
        .unwrap();
    vault.set_vault_page_width(Some(PageWidth::Full)).unwrap();
    let widths = vault.page_widths();
    assert_eq!(widths.vault, Some(PageWidth::Full));
    assert_eq!(widths.pages.get("Notes/A.md"), Some(&PageWidth::Full));
    assert_eq!(widths.pages.get("B.md"), Some(&PageWidth::Readable));
    let json = file(&dir);
    assert_eq!(json["pageWidth"], "full");
    assert_eq!(json["pageWidths"]["Notes/A.md"], "full");
    assert_eq!(json["exclude"][0], "Private/**");
    assert_eq!(json["future"]["x"], 1);
    // Clearing removes the entry, then the empty map.
    vault.set_page_width("Notes/A.md", None).unwrap();
    vault.set_page_width("B.md", None).unwrap();
    vault.set_vault_page_width(None).unwrap();
    let json = file(&dir);
    assert!(json.get("pageWidths").is_none(), "{json}");
    assert!(json.get("pageWidth").is_none(), "{json}");
}

#[test]
fn m4b2_page_widths_follow_renames_and_folder_moves() {
    let (_dir, vault) = fresh();
    vault
        .set_page_width("Notes/A.md", Some(PageWidth::Full))
        .unwrap();
    vault
        .set_page_width("Other.md", Some(PageWidth::Readable))
        .unwrap();
    vault
        .remap_page_widths_many(&[
            ("Notes".to_string(), "Archive/Notes".to_string()),
            ("Other.md".to_string(), "Renamed.md".to_string()),
        ])
        .unwrap();
    let widths = vault.page_widths();
    assert_eq!(
        widths.pages.get("Archive/Notes/A.md"),
        Some(&PageWidth::Full)
    );
    assert_eq!(widths.pages.get("Renamed.md"), Some(&PageWidth::Readable));
    assert_eq!(widths.pages.len(), 2);
}

#[test]
fn m4b2_a_malformed_width_hides_only_itself() {
    let (dir, _) = fresh();
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{"exclude":["Private/**"],"pageWidth":"huge","pageWidths":{"A.md":"full","B.md":3}}"#,
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let widths = vault.page_widths();
    assert_eq!(widths.vault, None);
    assert_eq!(widths.pages.get("A.md"), Some(&PageWidth::Full));
    assert!(!widths.pages.contains_key("B.md"));
    assert!(vault.is_excluded("Private/x.md"), "excludes still apply");
}

/// Final review M10: a deleted page's width doesn't outlive it (a new page at
/// the same path starts at the default); a deleted folder takes its pages'.
#[test]
fn m4b2_widths_of_deleted_pages_and_folders_are_forgotten() {
    let (dir, vault) = fresh();
    for (path, width) in [
        ("Notes/A.md", PageWidth::Full),
        ("Notes/Sub/B.md", PageWidth::Readable),
        ("Notes2/C.md", PageWidth::Full),
        ("D.md", PageWidth::Full),
    ] {
        vault.set_page_width(path, Some(width)).unwrap();
    }
    vault
        .forget_page_widths(&["Notes".to_string(), "D.md".to_string()])
        .unwrap();
    let widths = vault.page_widths();
    assert_eq!(
        widths.pages.into_iter().collect::<Vec<_>>(),
        vec![("Notes2/C.md".to_string(), PageWidth::Full)]
    );
    vault
        .forget_page_widths(&["Notes2/C.md".to_string()])
        .unwrap();
    assert!(file(&dir).get("pageWidths").is_none());
    // Nothing to forget writes nothing (VLT-02).
    let (bare, vault) = fresh();
    vault.forget_page_widths(&["A.md".to_string()]).unwrap();
    assert!(!bare.path().join(".nimw").exists());
}
