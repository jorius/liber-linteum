//! Round 3b final review #4: the dictionaries compiled into the app ship
//! with their licences, and the notices name them and spellbook.

use std::path::Path;

#[test]
fn every_bundled_dictionary_licence_is_noticed_and_shipped() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let notices = std::fs::read_to_string(root.join("THIRD-PARTY-NOTICES.md")).unwrap();
    let conf =
        std::fs::read_to_string(root.join("apps/desktop/src-tauri/tauri.conf.json")).unwrap();
    assert!(notices.contains("spellbook"), "spellbook is credited");
    let dicts = root.join("crates/liber-spell/dictionaries");
    let mut seen = 0;
    for entry in std::fs::read_dir(&dicts).unwrap() {
        let dir = entry.unwrap().path();
        if !dir.join("LICENSE").is_file() {
            continue;
        }
        seen += 1;
        let id = dir.file_name().unwrap().to_string_lossy().into_owned();
        let rel = format!("crates/liber-spell/dictionaries/{id}/LICENSE");
        assert!(notices.contains(&rel), "THIRD-PARTY-NOTICES.md names {rel}");
        assert!(conf.contains(&rel), "tauri.conf.json bundles {rel}");
    }
    assert_eq!(seen, liber_spell::BUNDLED.len());
}
