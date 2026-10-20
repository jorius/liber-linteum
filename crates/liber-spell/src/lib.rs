//! Spell checking with local Hunspell dictionaries: three bundled ones
//! (en_US, es, es_CO) and any the user imports from disk. Nothing here
//! touches the network; dictionaries load lazily and stay in memory.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use spellbook::Dictionary;
use unicode_normalization::UnicodeNormalization;

/// (id, .aff, .dic) of the dictionaries compiled into the app.
pub const BUNDLED: &[(&str, &str, &str)] = &[
    (
        "en_US",
        include_str!("../dictionaries/en_US/index.aff"),
        include_str!("../dictionaries/en_US/index.dic"),
    ),
    (
        "es",
        include_str!("../dictionaries/es/index.aff"),
        include_str!("../dictionaries/es/index.dic"),
    ),
    (
        "es_CO",
        include_str!("../dictionaries/es_CO/index.aff"),
        include_str!("../dictionaries/es_CO/index.dic"),
    ),
];

/// Largest .aff or .dic accepted from disk.
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Most suggestions returned for one word.
pub const MAX_SUGGESTIONS: usize = 7;

#[derive(Debug, thiserror::Error)]
pub enum SpellError {
    #[error("{0} is larger than 20 MB")]
    TooLarge(PathBuf),
    #[error("{0} can't be read")]
    Unreadable(PathBuf),
    #[error("not a Hunspell dictionary: {0}")]
    Invalid(String),
    #[error("unknown dictionary {0}")]
    Unknown(String),
}

#[derive(Default)]
pub struct Speller {
    loaded: RwLock<HashMap<String, Arc<Dictionary>>>,
}

fn nfc(word: &str) -> String {
    word.nfc().collect()
}

/// The spellings of `word` an added word may have been written in, as
/// Hunspell does for its own words: a Title or ALL-CAPS word also matches its
/// lower-case form, and an ALL-CAPS word its Title form (round 3b final
/// review #7). Mixed case (`lIber`) matches only itself.
fn case_forms(word: &str) -> Vec<String> {
    let mut forms = vec![word.to_string()];
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return forms;
    };
    let rest: String = chars.collect();
    let lower = word.to_lowercase();
    let all_caps = word.chars().any(char::is_alphabetic) && word == word.to_uppercase();
    let title = first.is_uppercase() && rest == rest.to_lowercase();
    if all_caps || title {
        forms.push(lower.clone());
    }
    if all_caps {
        let mut t = lower.chars();
        if let Some(f) = t.next() {
            forms.push(f.to_uppercase().chain(t).collect());
        }
    }
    forms
}

fn read(path: &Path) -> Result<String, SpellError> {
    let len = fs::metadata(path)
        .map_err(|_| SpellError::Unreadable(path.to_path_buf()))?
        .len();
    if len > MAX_FILE_BYTES {
        return Err(SpellError::TooLarge(path.to_path_buf()));
    }
    fs::read_to_string(path).map_err(|_| SpellError::Unreadable(path.to_path_buf()))
}

fn parse(aff: &str, dic: &str) -> Result<Dictionary, SpellError> {
    Dictionary::new(aff, dic).map_err(|e| SpellError::Invalid(e.to_string()))
}

/// Checks a pair picked from disk: both files within the size limit, and
/// they parse as a dictionary.
pub fn validate(aff: &Path, dic: &Path) -> Result<(), SpellError> {
    parse(&read(aff)?, &read(dic)?).map(drop)
}

impl Speller {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, id: &str, dict: Dictionary) {
        self.loaded
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), Arc::new(dict));
    }

    pub fn is_loaded(&self, id: &str) -> bool {
        self.loaded
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id)
    }

    /// Loads a bundled dictionary (a no-op when it is already loaded).
    pub fn load_bundled(&self, id: &str) -> Result<(), SpellError> {
        if self.is_loaded(id) {
            return Ok(());
        }
        let (_, aff, dic) = BUNDLED
            .iter()
            .find(|b| b.0 == id)
            .ok_or_else(|| SpellError::Unknown(id.to_string()))?;
        self.insert(id, parse(aff, dic)?);
        Ok(())
    }

    /// Loads (or reloads) an imported dictionary under `id`.
    pub fn load_files(&self, id: &str, aff: &Path, dic: &Path) -> Result<(), SpellError> {
        let dict = parse(&read(aff)?, &read(dic)?)?;
        self.insert(id, dict);
        Ok(())
    }

    pub fn unload(&self, id: &str) {
        self.loaded
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    fn active(&self, ids: &[String]) -> Vec<Arc<Dictionary>> {
        let loaded = self.loaded.read().unwrap_or_else(|e| e.into_inner());
        ids.iter()
            .filter_map(|id| loaded.get(id).cloned())
            .collect()
    }

    /// Whether each word is spelled right: accepted by any active (loaded)
    /// dictionary, or in `extra` (the vault's words and the session's
    /// ignores). Ids that aren't loaded are skipped; with no dictionary left,
    /// nothing is flagged (round 3b final review #2).
    pub fn check(&self, active: &[String], extra: &HashSet<String>, words: &[String]) -> Vec<bool> {
        let dicts = self.active(active);
        if dicts.is_empty() {
            return vec![true; words.len()];
        }
        let extra: HashSet<String> = extra.iter().map(|w| nfc(w)).collect();
        words
            .iter()
            .map(|word| {
                let word = nfc(word);
                case_forms(&word).iter().any(|f| extra.contains(f))
                    || dicts.iter().any(|d| d.check(&word))
            })
            .collect()
    }

    /// Up to seven suggestions, in the active dictionaries' order, without
    /// duplicates.
    pub fn suggest(&self, active: &[String], word: &str) -> Vec<String> {
        let word = nfc(word);
        let mut out: Vec<String> = Vec::new();
        for dict in self.active(active) {
            let mut found = Vec::new();
            dict.suggest(&word, &mut found);
            for s in found {
                if out.len() == MAX_SUGGESTIONS {
                    return out;
                }
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
        out
    }
}
