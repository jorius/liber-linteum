//! Cover resize: each page's cover height in `.liber/vault.json`
//! (`coverHeights`), never in the note; it follows renames and is forgotten
//! with the page, exactly like `pageWidths`.

use liber_vault::{MAX_COVER_HEIGHT, MIN_COVER_HEIGHT, PageWidth, Vault};

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn file(dir: &tempfile::TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join(".liber/vault.json")).unwrap()).unwrap()
}

#[test]
fn cover_nothing_set_reads_as_nothing_and_writes_nothing() {
    let (dir, vault) = fresh();
    assert!(vault.cover_heights().is_empty());
    // Clearing what isn't set never creates `.liber/` (VLT-02).
    vault.set_cover_height("A.md", None).unwrap();
    vault.forget_cover_heights(&["A.md".to_string()]).unwrap();
    vault
        .remap_cover_heights_many(&[("A.md".to_string(), "B.md".to_string())])
        .unwrap();
    assert!(!dir.path().join(".liber").exists());
}

#[test]
fn cover_heights_round_trip_and_keep_other_keys() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{"exclude":["Private/**"],"future":{"x":1}}"#,
    )
    .unwrap();
    vault.set_cover_height("Notes/A.md", Some(240)).unwrap();
    vault.set_cover_height("B.md", Some(320)).unwrap();
    vault.set_page_width("B.md", Some(PageWidth::Full)).unwrap();
    let heights = vault.cover_heights();
    assert_eq!(heights.get("Notes/A.md"), Some(&240));
    assert_eq!(heights.get("B.md"), Some(&320));
    let json = file(&dir);
    assert_eq!(json["coverHeights"]["Notes/A.md"], 240);
    assert_eq!(json["pageWidths"]["B.md"], "full");
    assert_eq!(json["exclude"][0], "Private/**");
    assert_eq!(json["future"]["x"], 1);
    // Setting again replaces; clearing removes the entry, then the empty map.
    vault.set_cover_height("B.md", Some(400)).unwrap();
    assert_eq!(vault.cover_heights().get("B.md"), Some(&400));
    vault.set_cover_height("Notes/A.md", None).unwrap();
    vault.set_cover_height("B.md", None).unwrap();
    let json = file(&dir);
    assert!(json.get("coverHeights").is_none(), "{json}");
    assert_eq!(json["pageWidths"]["B.md"], "full", "widths untouched");
}

#[test]
fn cover_heights_are_clamped_to_the_allowed_range() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    assert_eq!((MIN_COVER_HEIGHT, MAX_COVER_HEIGHT), (132, 2000));
    vault.set_cover_height("Low.md", Some(20)).unwrap();
    vault.set_cover_height("High.md", Some(90_000)).unwrap();
    let heights = vault.cover_heights();
    assert_eq!(heights.get("Low.md"), Some(&132));
    assert_eq!(heights.get("High.md"), Some(&2000));
    assert_eq!(file(&dir)["coverHeights"]["High.md"], 2000);
}

#[test]
fn cover_heights_follow_renames_and_folder_moves() {
    let (_dir, vault) = fresh();
    vault.set_cover_height("Notes/A.md", Some(240)).unwrap();
    vault.set_cover_height("Other.md", Some(300)).unwrap();
    vault.set_cover_height("Kept.md", Some(200)).unwrap();
    vault
        .remap_cover_heights_many(&[
            ("Notes".to_string(), "Archive/Notes".to_string()),
            ("Other.md".to_string(), "Renamed.md".to_string()),
        ])
        .unwrap();
    let heights = vault.cover_heights();
    assert_eq!(
        heights.into_iter().collect::<Vec<_>>(),
        vec![
            ("Archive/Notes/A.md".to_string(), 240),
            ("Kept.md".to_string(), 200),
            ("Renamed.md".to_string(), 300),
        ]
    );
}

#[test]
fn cover_a_malformed_height_hides_only_itself() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _) = fresh();
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{"exclude":["Private/**"],"coverHeights":{"A.md":250,"B.md":"tall","C.md":-4,"D.md":5000,"E.md":180.6}}"#,
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let heights = vault.cover_heights();
    assert_eq!(heights.get("A.md"), Some(&250));
    assert!(!heights.contains_key("B.md"));
    assert!(!heights.contains_key("C.md"));
    // A hand-edited number out of range or with a fraction still reads, clamped and rounded.
    assert_eq!(heights.get("D.md"), Some(&2000));
    assert_eq!(heights.get("E.md"), Some(&181));
    assert!(vault.is_excluded("Private/x.md"), "excludes still apply");
}

#[test]
fn cover_heights_of_deleted_pages_and_folders_are_forgotten() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    for (path, height) in [
        ("Notes/A.md", 240),
        ("Notes/Sub/B.md", 300),
        ("Notes2/C.md", 280),
        ("D.md", 360),
    ] {
        vault.set_cover_height(path, Some(height)).unwrap();
    }
    vault
        .forget_cover_heights(&["Notes".to_string(), "D.md".to_string()])
        .unwrap();
    assert_eq!(
        vault.cover_heights().into_iter().collect::<Vec<_>>(),
        vec![("Notes2/C.md".to_string(), 280)]
    );
    vault
        .forget_cover_heights(&["Notes2/C.md".to_string()])
        .unwrap();
    assert!(file(&dir).get("coverHeights").is_none());
}
