//! Spelling settings kept in `.nimw/vault.json`: `spelling.dictionaries`
//! overrides the app's dictionaries for this vault (absent = use the app's),
//! and `spellingWords` holds the words added to the dictionary, NFC, sorted
//! and unique. They live in the vault so an encrypted vault keeps them too.

use crate::Result;
use crate::vault::{NIMW_JSON, Vault, read_json};
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

const OVERRIDE: &str = "spelling";
const WORDS: &str = "spellingWords";

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    })
}

impl Vault {
    /// This vault's dictionaries, or `None` to use the app's.
    pub fn spelling_dictionaries(&self) -> Option<Vec<String>> {
        let value: Value = read_json(self.root(), NIMW_JSON, &mut Vec::new());
        strings(value.get(OVERRIDE).and_then(|o| o.get("dictionaries")))
    }

    /// Sets the override; `None` removes it.
    pub fn set_spelling_dictionaries(&self, ids: Option<&[String]>) -> Result<()> {
        self.update_json_object(NIMW_JSON, ids.is_some(), |map| match ids {
            Some(ids) => {
                let mut o = Map::new();
                o.insert("dictionaries".into(), Value::from(ids.to_vec()));
                map.insert(OVERRIDE.into(), Value::Object(o));
            }
            None => {
                map.remove(OVERRIDE);
            }
        })
    }

    pub fn spelling_words(&self) -> Vec<String> {
        let value: Value = read_json(self.root(), NIMW_JSON, &mut Vec::new());
        strings(value.get(WORDS)).unwrap_or_default()
    }

    pub fn add_spelling_word(&self, word: &str) -> Result<()> {
        let word: String = word.nfc().collect();
        self.edit_words(true, |words| words.push(word.clone()))
    }

    pub fn remove_spelling_word(&self, word: &str) -> Result<()> {
        let word: String = word.nfc().collect();
        self.edit_words(false, |words| words.retain(|w| *w != word))
    }

    fn edit_words(&self, create: bool, edit: impl Fn(&mut Vec<String>)) -> Result<()> {
        self.update_json_object(NIMW_JSON, create, |map| {
            let mut words = strings(map.get(WORDS)).unwrap_or_default();
            edit(&mut words);
            words.sort();
            words.dedup();
            if words.is_empty() {
                map.remove(WORDS);
            } else {
                map.insert(WORDS.into(), Value::from(words));
            }
        })
    }
}
