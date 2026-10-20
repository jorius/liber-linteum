//! Quick notes (M4c §2, §7): the notes still named after their first line
//! (`autoNamed`) and the vault's scratch folder (`scratchpadFolder`) live in
//! `.liber/vault.json`, never in the notes.

use liber_vault::{DEFAULT_SCRATCH_FOLDER, Vault};

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn file(dir: &tempfile::TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join(".liber/vault.json")).unwrap()).unwrap()
}

fn write(dir: &tempfile::TempDir, json: &str) {
    std::fs::create_dir_all(dir.path().join(".liber")).unwrap();
    std::fs::write(dir.path().join(".liber/vault.json"), json).unwrap();
}

#[test]
fn m4c_auto_named_round_trip_keeps_other_keys() {
    let (dir, vault) = fresh();
    write(&dir, r#"{"version":1,"pageWidth":"full"}"#);
    vault.set_auto_named("Quick note 1.md", true).unwrap();
    vault.set_auto_named("Quick note 2.md", true).unwrap();
    vault.set_auto_named("Quick note 2.md", true).unwrap();
    assert_eq!(
        vault.auto_named().into_iter().collect::<Vec<_>>(),
        ["Quick note 1.md", "Quick note 2.md"]
    );
    assert_eq!(
        file(&dir)["autoNamed"],
        serde_json::json!(["Quick note 1.md", "Quick note 2.md"])
    );
    vault.set_auto_named("Quick note 1.md", false).unwrap();
    vault
        .forget_auto_named(&["Quick note 2.md".to_string()])
        .unwrap();
    assert!(vault.auto_named().is_empty());
    assert_eq!(
        file(&dir),
        serde_json::json!({"version": 1, "pageWidth": "full"})
    );
}

#[test]
fn m4c_forgetting_a_folder_drops_the_notes_inside_it_and_nothing_else() {
    let (_dir, vault) = fresh();
    for p in ["F/a.md", "F/b.md", "Fx.md", "G/F/c.md"] {
        vault.set_auto_named(p, true).unwrap();
    }
    vault.forget_auto_named(&["F".to_string()]).unwrap();
    assert_eq!(
        vault.auto_named().into_iter().collect::<Vec<_>>(),
        ["Fx.md", "G/F/c.md"]
    );
}

#[test]
fn m4c_unchanged_lists_are_not_rewritten() {
    let (dir, vault) = fresh();
    vault.set_auto_named("a.md", false).unwrap();
    vault.forget_auto_named(&["a.md".to_string()]).unwrap();
    vault.set_scratch_folder(DEFAULT_SCRATCH_FOLDER).unwrap();
    vault
        .follow_scratch_folder(&[("Other".to_string(), "Inbox".to_string())])
        .unwrap();
    assert!(!dir.path().join(".liber").exists());
    // Renaming the default folder does name it.
    vault
        .follow_scratch_folder(&[("Scratchpad".to_string(), "Inbox".to_string())])
        .unwrap();
    assert_eq!(vault.scratch_folder(), "Inbox");
}

#[test]
fn m4c_hand_edited_garbage_is_ignored() {
    let (dir, vault) = fresh();
    write(&dir, r#"{"autoNamed":["a.md",3,null,"b.md"]}"#);
    assert_eq!(
        vault.auto_named().into_iter().collect::<Vec<_>>(),
        ["a.md", "b.md"]
    );
    for bad in [
        r#""../x""#,
        r#"".hid""#,
        "3",
        r#""""#,
        r#""a/b""#,
        r#""a\\b""#,
    ] {
        write(&dir, &format!(r#"{{"scratchpadFolder":{bad}}}"#));
        assert_eq!(vault.scratch_folder(), "Scratchpad", "{bad}");
    }
    // A list that isn't one is replaced on the next write.
    write(&dir, r#"{"autoNamed":"oops","x":1}"#);
    vault.set_auto_named("c.md", true).unwrap();
    assert_eq!(
        file(&dir),
        serde_json::json!({"autoNamed": ["c.md"], "version": 1, "x": 1})
    );
}

#[test]
fn m4c_scratch_folder_defaults_is_set_and_follows_top_level_renames() {
    let (dir, vault) = fresh();
    assert_eq!(vault.scratch_folder(), "Scratchpad");
    vault.set_scratch_folder("Inbox").unwrap();
    assert_eq!(vault.scratch_folder(), "Inbox");
    vault
        .follow_scratch_folder(&[("Inbox".to_string(), "Drafts".to_string())])
        .unwrap();
    assert_eq!(vault.scratch_folder(), "Drafts");
    // Moved into another folder: the setting stays (a new one is made on use).
    vault
        .follow_scratch_folder(&[("Drafts".to_string(), "Archive/Drafts".to_string())])
        .unwrap();
    assert_eq!(vault.scratch_folder(), "Drafts");
    // Other renames leave it alone.
    vault
        .follow_scratch_folder(&[("Draftsy".to_string(), "Other".to_string())])
        .unwrap();
    assert_eq!(vault.scratch_folder(), "Drafts");
    // The default clears the key.
    vault.set_scratch_folder("Scratchpad").unwrap();
    assert!(file(&dir).get("scratchpadFolder").is_none());
}
