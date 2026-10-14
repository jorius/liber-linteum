//! M3a §7: pinned Global View card positions in `.nimw/layout.json`.

use nimw_vault::{CardPosition, Vault};
use std::collections::BTreeMap;

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn at(x: f64, y: f64) -> CardPosition {
    CardPosition { x, y }
}

fn positions(list: &[(&str, f64, f64)]) -> BTreeMap<String, CardPosition> {
    list.iter()
        .map(|(p, x, y)| (p.to_string(), at(*x, *y)))
        .collect()
}

fn file(dir: &tempfile::TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join(".nimw/layout.json")).unwrap()).unwrap()
}

/// Creates pages (`*.md`) and folders (anything else) in the vault: saves
/// and remaps drop positions of paths that don't exist.
fn touch(dir: &tempfile::TempDir, paths: &[&str]) {
    for p in paths {
        let full = dir.path().join(p);
        if p.ends_with(".md") {
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, "# page\n").unwrap();
        } else {
            std::fs::create_dir_all(full).unwrap();
        }
    }
}

#[test]
fn gv_31_positions_are_saved_per_level_lazily_and_read_back() {
    let (dir, vault) = fresh();
    touch(&dir, &["Alpha", "Notes/a.md", "Notes/b.md"]);
    assert!(vault.layout_level("").is_empty());
    assert!(
        !dir.path().join(".nimw").exists(),
        "VLT-02: reading writes nothing"
    );
    vault
        .set_layout_level("", &positions(&[("Alpha", 10.0, 20.5)]))
        .unwrap();
    vault
        .set_layout_level("page:Notes/a.md", &positions(&[("Notes/b.md", -3.0, 4.0)]))
        .unwrap();
    assert_eq!(vault.layout_level(""), positions(&[("Alpha", 10.0, 20.5)]));
    let json = file(&dir);
    assert_eq!(json["version"], 1);
    assert_eq!(json["levels"][""]["Alpha"]["x"], 10.0);
    assert_eq!(json["levels"]["page:Notes/a.md"]["Notes/b.md"]["y"], 4.0);
}

#[test]
fn gv_32_an_empty_level_is_removed_and_unknown_keys_survive() {
    let (dir, vault) = fresh();
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/layout.json"),
        r#"{"version":1,"future":{"keep":true},"levels":{"Alpha":{"Alpha/x.md":{"x":1,"y":2}},"":{"Alpha":{"x":0,"y":0}}}}"#,
    )
    .unwrap();
    vault.set_layout_level("Alpha", &BTreeMap::new()).unwrap();
    let json = file(&dir);
    assert!(json["levels"].get("Alpha").is_none());
    assert_eq!(json["levels"][""]["Alpha"]["x"], 0.0);
    assert_eq!(json["future"]["keep"], true);
}

#[test]
fn m3a_layout_follows_renames_of_folders_and_pages() {
    let (dir, vault) = fresh();
    touch(
        &dir,
        &[
            "Alpha/a.md",
            "Alpha/Sub/c.md",
            "Beta/b.md",
            "Alphabet/z.md",
            "Projects",
        ],
    );
    vault
        .set_layout_level("", &positions(&[("Alpha", 1.0, 1.0), ("Beta", 2.0, 2.0)]))
        .unwrap();
    vault
        .set_layout_level(
            "Alpha",
            &positions(&[("Alpha/a.md", 3.0, 3.0), ("Alpha/Sub", 4.0, 4.0)]),
        )
        .unwrap();
    vault
        .set_layout_level("page:Alpha/a.md", &positions(&[("Beta/b.md", 5.0, 5.0)]))
        .unwrap();
    vault
        .set_layout_level("expand:Alpha", &positions(&[("Alpha/Sub/c.md", 6.0, 6.0)]))
        .unwrap();
    vault
        .set_layout_level("Alphabet", &positions(&[("Alphabet/z.md", 7.0, 7.0)]))
        .unwrap();

    std::fs::rename(dir.path().join("Alpha"), dir.path().join("Projects/Alpha")).unwrap();
    vault.remap_layout("Alpha", "Projects/Alpha").unwrap();
    let level = |k: &str| vault.layout_level(k);
    assert_eq!(
        level(""),
        positions(&[("Beta", 2.0, 2.0), ("Projects/Alpha", 1.0, 1.0)])
    );
    assert_eq!(
        level("Projects/Alpha"),
        positions(&[
            ("Projects/Alpha/Sub", 4.0, 4.0),
            ("Projects/Alpha/a.md", 3.0, 3.0)
        ])
    );
    assert_eq!(
        level("page:Projects/Alpha/a.md"),
        positions(&[("Beta/b.md", 5.0, 5.0)])
    );
    assert_eq!(
        level("expand:Projects/Alpha"),
        positions(&[("Projects/Alpha/Sub/c.md", 6.0, 6.0)])
    );
    assert!(level("Alpha").is_empty());
    assert_eq!(
        level("Alphabet"),
        positions(&[("Alphabet/z.md", 7.0, 7.0)]),
        "a sibling sharing the prefix is untouched"
    );
    let _ = dir;
}

/// Final review I3: a remap that moves nothing never rewrites (and fsyncs)
/// the file; a batch of renames is applied in one pass.
#[test]
fn m3a_a_remap_that_matches_nothing_leaves_the_file_untouched() {
    let (dir, vault) = fresh();
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    // Compact on purpose: any write would pretty-print it.
    let compact = r#"{"version":1,"levels":{"":{"a.md":{"x":1,"y":2},"b.md":{"x":3,"y":4}}}}"#;
    std::fs::write(dir.path().join(".nimw/layout.json"), compact).unwrap();
    let text = || std::fs::read_to_string(dir.path().join(".nimw/layout.json")).unwrap();

    vault.remap_layout("Other/x.md", "Other2/x.md").unwrap();
    vault
        .remap_layout_many(&[
            ("Other/y.md".to_string(), "Other2/y.md".to_string()),
            ("ab.md".to_string(), "c.md".to_string()),
        ])
        .unwrap();
    assert_eq!(text(), compact);

    vault
        .remap_layout_many(&[
            ("a.md".to_string(), "Moved/a.md".to_string()),
            ("b.md".to_string(), "Moved/b.md".to_string()),
            ("zzz.md".to_string(), "Moved/zzz.md".to_string()),
        ])
        .unwrap();
    assert_eq!(
        vault.layout_level(""),
        positions(&[("Moved/a.md", 1.0, 2.0), ("Moved/b.md", 3.0, 4.0)])
    );
}

/// Final review m10: nothing can live at a rename's destination before the
/// rename, so keys and entries already there are leftovers of a deleted
/// folder or page with that name: the moved positions replace them.
#[test]
fn m3a_moved_positions_win_over_leftovers_at_the_destination() {
    let (dir, vault) = fresh();
    touch(&dir, &["A/a.md"]);
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    // `B` was deleted earlier; its level and entries are still in the file.
    std::fs::write(
        dir.path().join(".nimw/layout.json"),
        r#"{"version":1,"levels":{
            "":{"A":{"x":1,"y":1},"B":{"x":9,"y":9}},
            "A":{"A/a.md":{"x":2,"y":2}},
            "B":{"B/a.md":{"x":8,"y":8},"B/old.md":{"x":7,"y":7}},
            "page:B/old.md":{"A/a.md":{"x":6,"y":6}}
        }}"#,
    )
    .unwrap();
    std::fs::rename(dir.path().join("A"), dir.path().join("B")).unwrap();
    vault.remap_layout("A", "B").unwrap();
    assert_eq!(vault.layout_level(""), positions(&[("B", 1.0, 1.0)]));
    assert_eq!(vault.layout_level("B"), positions(&[("B/a.md", 2.0, 2.0)]));
    assert!(vault.layout_level("page:B/old.md").is_empty());
    assert!(vault.layout_level("A").is_empty());
}

/// Final review m10: the file doesn't only grow. A layout write (a level
/// save, or a remap that moved something) drops the levels of folders and
/// pages that no longer exist, and a level save drops that level's
/// positions for paths that no longer exist. Reads and no-op remaps never
/// write just to prune.
#[test]
fn m3a_writes_prune_levels_and_positions_of_deleted_paths() {
    let (dir, vault) = fresh();
    touch(&dir, &["Alpha/a.md", "b.md"]);
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/layout.json"),
        r#"{"version":1,"levels":{
            "":{"Alpha":{"x":1,"y":1},"Gone":{"x":2,"y":2}},
            "Alpha":{"Alpha/a.md":{"x":3,"y":3},"Alpha/gone.md":{"x":4,"y":4}},
            "Gone":{"Gone/x.md":{"x":5,"y":5}},
            "page:gone.md":{"b.md":{"x":6,"y":6}},
            "expand:Gone":{"Gone/x.md":{"x":7,"y":7}},
            "expand:Alpha":{"Alpha/a.md":{"x":8,"y":8}},
            "page:b.md":{"Alpha":{"x":9,"y":9}}
        }}"#,
    )
    .unwrap();
    let before = std::fs::read_to_string(dir.path().join(".nimw/layout.json")).unwrap();
    vault.remap_layout("Nothing", "Here").unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".nimw/layout.json")).unwrap(),
        before,
        "a no-op remap doesn't write to prune"
    );

    vault
        .set_layout_level(
            "",
            &positions(&[("Alpha", 1.0, 1.0), ("b.md", 2.0, 2.0), ("Gone", 3.0, 3.0)]),
        )
        .unwrap();
    let json = file(&dir);
    let mut keys: Vec<&String> = json["levels"].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["", "Alpha", "expand:Alpha", "page:b.md"]);
    assert_eq!(
        vault.layout_level(""),
        positions(&[("Alpha", 1.0, 1.0), ("b.md", 2.0, 2.0)])
    );
    assert_eq!(
        vault.layout_level("Alpha"),
        positions(&[("Alpha/a.md", 3.0, 3.0), ("Alpha/gone.md", 4.0, 4.0)]),
        "other levels' positions are pruned when that level is saved"
    );

    // Saving a level whose own folder or page is gone stores nothing.
    vault
        .set_layout_level("page:gone.md", &positions(&[("b.md", 1.0, 1.0)]))
        .unwrap();
    assert!(vault.layout_level("page:gone.md").is_empty());
}

#[test]
fn m3a_remap_without_a_layout_writes_nothing_and_bad_numbers_are_refused() {
    let (dir, vault) = fresh();
    vault.remap_layout("a.md", "b.md").unwrap();
    assert!(!dir.path().join(".nimw").exists());
    assert!(
        vault
            .set_layout_level("", &positions(&[("x", f64::NAN, 0.0)]))
            .is_err()
    );
    assert!(!dir.path().join(".nimw").exists());
}
