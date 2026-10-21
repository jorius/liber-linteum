//! Spelling in `.liber/vault.json`: `spelling.dictionaries` overrides the app's
//! dictionaries for this vault, and `spellingWords` holds the words added to
//! the dictionary (kept in the vault, so an encrypted vault keeps them too).

use liber_vault::Vault;

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn s(items: &[&str]) -> Vec<String> {
    items.iter().map(|p| p.to_string()).collect()
}

fn json(dir: &tempfile::TempDir) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.path().join(".liber/vault.json")).unwrap()).unwrap()
}

#[test]
fn override_round_trips_and_clears() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    assert_eq!(vault.spelling_dictionaries(), None);
    vault.set_vault_icon(Some("🌌")).unwrap();
    vault
        .set_spelling_dictionaries(Some(&s(&["es_CO", "en_US"])))
        .unwrap();
    assert_eq!(vault.spelling_dictionaries(), Some(s(&["es_CO", "en_US"])));
    vault.set_spelling_dictionaries(None).unwrap();
    assert_eq!(vault.spelling_dictionaries(), None);
    let json = json(&dir);
    assert!(json.get("spelling").is_none());
    assert_eq!(json["icon"], "🌌");
}

#[test]
fn an_empty_override_means_no_dictionaries() {
    let (_dir, vault) = fresh();
    vault.set_spelling_dictionaries(Some(&[])).unwrap();
    assert_eq!(vault.spelling_dictionaries(), Some(vec![]));
}

#[test]
fn words_are_sorted_unique_nfc() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    for w in ["zeta", "Ioque", "cancio\u{301}n", "zeta", "canción"] {
        vault.add_spelling_word(w).unwrap();
    }
    assert_eq!(vault.spelling_words(), s(&["Ioque", "canción", "zeta"]));
    assert_eq!(json(&dir)["spellingWords"][1], "canción");
}

#[test]
fn removing_the_last_word_drops_the_key() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    vault.add_spelling_word("Ioque").unwrap();
    vault.remove_spelling_word("Ioque").unwrap();
    assert!(vault.spelling_words().is_empty());
    assert!(json(&dir).get("spellingWords").is_none());
}

#[test]
fn reading_nothing_writes_nothing() {
    let (dir, vault) = fresh();
    assert!(vault.spelling_words().is_empty());
    vault.remove_spelling_word("x").unwrap();
    vault.set_spelling_dictionaries(None).unwrap();
    assert!(!dir.path().join(".liber").exists());
}
