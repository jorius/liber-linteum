use std::collections::HashSet;
use std::fs;

use nimw_spell::{BUNDLED, SpellError, Speller, validate};

fn w(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn loaded(ids: &[&str]) -> Speller {
    let s = Speller::new();
    for id in ids {
        s.load_bundled(id).unwrap();
    }
    s
}

#[test]
fn bundled_dictionaries_parse() {
    let s = Speller::new();
    for (id, _, _) in BUNDLED {
        s.load_bundled(id).unwrap();
    }
    assert_eq!(
        BUNDLED.iter().map(|b| b.0).collect::<Vec<_>>(),
        ["en_US", "es", "es_CO"]
    );
}

#[test]
fn checks_per_language() {
    let s = loaded(&["en_US", "es", "es_CO"]);
    let none = HashSet::new();
    assert_eq!(
        s.check(
            &w(&["en_US"]),
            &none,
            &w(&["receive", "recieve", "don't", "don’t"])
        ),
        [true, false, true, true]
    );
    assert_eq!(
        s.check(
            &w(&["es"]),
            &none,
            &w(&["canción", "cancion", "cancio\u{301}n", "parcero"])
        ),
        [true, false, true, false]
    );
    assert_eq!(s.check(&w(&["es_CO"]), &none, &w(&["parcero"])), [true]);
}

#[test]
fn any_active_dictionary_accepts() {
    let s = loaded(&["en_US", "es"]);
    assert_eq!(
        s.check(
            &w(&["es", "en_US"]),
            &HashSet::new(),
            &w(&["canción", "receive", "recieve"])
        ),
        [true, true, false]
    );
}

#[test]
fn extra_words_accept_nfc() {
    let s = loaded(&["en_US"]);
    let extra: HashSet<String> = ["Ioque".to_string(), "cancio\u{301}n".to_string()].into();
    assert_eq!(
        s.check(&w(&["en_US"]), &extra, &w(&["Ioque", "canción", "Wayuu"])),
        [true, true, false]
    );
}

#[test]
fn suggestions_are_capped_and_ordered() {
    let s = loaded(&["en_US", "es"]);
    let got = s.suggest(&w(&["es", "en_US"]), "cancion");
    assert_eq!(got.first().map(String::as_str), Some("canción"));
    assert!(got.len() <= 7, "{got:?}");
    let unique: HashSet<_> = got.iter().collect();
    assert_eq!(unique.len(), got.len(), "{got:?}");
}

#[test]
fn unknown_active_ids_are_skipped() {
    let s = loaded(&["en_US"]);
    assert_eq!(
        s.check(
            &w(&["nope", "en_US", "es"]),
            &HashSet::new(),
            &w(&["receive"])
        ),
        [true]
    );
    assert!(s.suggest(&w(&["nope"]), "recieve").is_empty());
}

#[test]
fn validate_refuses_large_and_broken() {
    let dir = tempfile::tempdir().unwrap();
    let (aff, dic) = (dir.path().join("x.aff"), dir.path().join("x.dic"));

    fs::write(&aff, BUNDLED[0].1).unwrap();
    fs::write(&dic, BUNDLED[0].2).unwrap();
    validate(&aff, &dic).unwrap();

    fs::write(&dic, vec![b'a'; 20 * 1024 * 1024 + 1]).unwrap();
    assert!(matches!(validate(&aff, &dic), Err(SpellError::TooLarge(p)) if p == dic));

    fs::write(&dic, "x").unwrap();
    assert!(matches!(validate(&aff, &dic), Err(SpellError::Invalid(_))));

    let missing = dir.path().join("none.dic");
    assert!(matches!(validate(&aff, &missing), Err(SpellError::Unreadable(p)) if p == missing));
}

#[test]
fn load_files_registers_an_imported_dictionary() {
    let dir = tempfile::tempdir().unwrap();
    let (aff, dic) = (dir.path().join("index.aff"), dir.path().join("index.dic"));
    fs::write(&aff, BUNDLED[0].1).unwrap();
    fs::write(&dic, BUNDLED[0].2).unwrap();
    let s = Speller::new();
    s.load_files("user:mine", &aff, &dic).unwrap();
    assert_eq!(
        s.check(&w(&["user:mine"]), &HashSet::new(), &w(&["receive"])),
        [true]
    );
    assert!(matches!(
        s.load_bundled("nope"),
        Err(SpellError::Unknown(_))
    ));
}
