//! Side covers (M4b part 3 §3): each page's cover placement (`coverSides`)
//! and strip width (`coverWidths`) in `.nimw/vault.json`, never in the note;
//! both follow renames and are forgotten with the page, like `coverHeights`.

use nimw_vault::{CoverSide, MAX_COVER_WIDTH, MIN_COVER_WIDTH, Vault};

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn file(dir: &tempfile::TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join(".nimw/vault.json")).unwrap()).unwrap()
}

#[test]
fn nothing_set_reads_as_nothing_and_writes_nothing() {
    let (dir, vault) = fresh();
    assert!(vault.cover_sides().is_empty());
    assert!(vault.cover_widths().is_empty());
    // Top is the default: setting it, or clearing a width, writes nothing (VLT-02).
    vault.set_cover_side("A.md", CoverSide::Top).unwrap();
    vault.set_cover_width("A.md", None).unwrap();
    vault.forget_cover_sides(&["A.md".to_string()]).unwrap();
    vault.forget_cover_widths(&["A.md".to_string()]).unwrap();
    let renames = [("A.md".to_string(), "B.md".to_string())];
    vault.remap_cover_sides_many(&renames).unwrap();
    vault.remap_cover_widths_many(&renames).unwrap();
    assert!(!dir.path().join(".nimw").exists());
}

#[test]
fn sides_and_widths_round_trip_and_keep_other_keys() {
    let (dir, vault) = fresh();
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{"exclude":["Private/**"],"coverHeights":{"A.md":240}}"#,
    )
    .unwrap();
    vault.set_cover_side("A.md", CoverSide::Left).unwrap();
    vault
        .set_cover_side("Notes/B.md", CoverSide::Right)
        .unwrap();
    vault.set_cover_width("A.md", Some(320)).unwrap();
    assert_eq!(
        vault.cover_sides().into_iter().collect::<Vec<_>>(),
        vec![
            ("A.md".to_string(), CoverSide::Left),
            ("Notes/B.md".to_string(), CoverSide::Right),
        ]
    );
    assert_eq!(vault.cover_widths().get("A.md"), Some(&320));
    let json = file(&dir);
    assert_eq!(json["coverSides"]["A.md"], "left");
    assert_eq!(json["coverSides"]["Notes/B.md"], "right");
    assert_eq!(json["coverWidths"]["A.md"], 320);
    assert_eq!(json["coverHeights"]["A.md"], 240);
    assert_eq!(json["exclude"][0], "Private/**");
    // Back to the top clears the entry, then the empty map.
    vault.set_cover_side("A.md", CoverSide::Top).unwrap();
    vault.set_cover_side("Notes/B.md", CoverSide::Top).unwrap();
    vault.set_cover_width("A.md", None).unwrap();
    let json = file(&dir);
    assert!(json.get("coverSides").is_none(), "{json}");
    assert!(json.get("coverWidths").is_none(), "{json}");
    assert_eq!(json["coverHeights"]["A.md"], 240, "heights untouched");
}

#[test]
fn widths_are_clamped_to_the_allowed_range() {
    let (dir, vault) = fresh();
    assert_eq!((MIN_COVER_WIDTH, MAX_COVER_WIDTH), (160, 2000));
    vault.set_cover_width("Low.md", Some(20)).unwrap();
    vault.set_cover_width("High.md", Some(90_000)).unwrap();
    let widths = vault.cover_widths();
    assert_eq!(widths.get("Low.md"), Some(&160));
    assert_eq!(widths.get("High.md"), Some(&2000));
    assert_eq!(file(&dir)["coverWidths"]["High.md"], 2000);
}

#[test]
fn malformed_entries_hide_only_themselves() {
    let (dir, _) = fresh();
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{"coverSides":{"A.md":"left","B.md":"diagonal","C.md":3,"D.md":"top","E.md":"right"},
            "coverWidths":{"A.md":300,"B.md":"wide","C.md":-4,"D.md":5000,"E.md":180.6}}"#,
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(
        vault.cover_sides().into_iter().collect::<Vec<_>>(),
        vec![
            ("A.md".to_string(), CoverSide::Left),
            ("E.md".to_string(), CoverSide::Right),
        ]
    );
    let widths = vault.cover_widths();
    assert_eq!(widths.get("A.md"), Some(&300));
    assert!(!widths.contains_key("B.md"));
    assert!(!widths.contains_key("C.md"));
    assert_eq!(widths.get("D.md"), Some(&2000));
    assert_eq!(widths.get("E.md"), Some(&181));
}

#[test]
fn sides_and_widths_follow_renames_and_folder_moves() {
    let (_dir, vault) = fresh();
    vault.set_cover_side("Notes/A.md", CoverSide::Left).unwrap();
    vault.set_cover_side("Other.md", CoverSide::Right).unwrap();
    vault.set_cover_width("Notes/A.md", Some(240)).unwrap();
    let renames = [
        ("Notes".to_string(), "Archive/Notes".to_string()),
        ("Other.md".to_string(), "Renamed.md".to_string()),
    ];
    vault.remap_cover_sides_many(&renames).unwrap();
    vault.remap_cover_widths_many(&renames).unwrap();
    assert_eq!(
        vault.cover_sides().into_iter().collect::<Vec<_>>(),
        vec![
            ("Archive/Notes/A.md".to_string(), CoverSide::Left),
            ("Renamed.md".to_string(), CoverSide::Right),
        ]
    );
    assert_eq!(
        vault.cover_widths().into_iter().collect::<Vec<_>>(),
        vec![("Archive/Notes/A.md".to_string(), 240)]
    );
}

#[test]
fn sides_and_widths_of_deleted_pages_and_folders_are_forgotten() {
    let (dir, vault) = fresh();
    for path in ["Notes/A.md", "Notes/Sub/B.md", "Notes2/C.md", "D.md"] {
        vault.set_cover_side(path, CoverSide::Left).unwrap();
        vault.set_cover_width(path, Some(300)).unwrap();
    }
    let removed = ["Notes".to_string(), "D.md".to_string()];
    vault.forget_cover_sides(&removed).unwrap();
    vault.forget_cover_widths(&removed).unwrap();
    assert_eq!(
        vault.cover_sides().into_keys().collect::<Vec<_>>(),
        vec!["Notes2/C.md".to_string()]
    );
    assert_eq!(
        vault.cover_widths().into_keys().collect::<Vec<_>>(),
        vec!["Notes2/C.md".to_string()]
    );
    let last = ["Notes2/C.md".to_string()];
    vault.forget_cover_sides(&last).unwrap();
    vault.forget_cover_widths(&last).unwrap();
    let json = file(&dir);
    assert!(json.get("coverSides").is_none() && json.get("coverWidths").is_none());
}
