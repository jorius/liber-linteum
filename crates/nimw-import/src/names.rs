//! Vault names for an export's files and folders (M7 §5): Notion's ids
//! stripped, the vault's name rules applied, duplicates numbered.

use crate::strip_notion_id;
use nimw_session::{device_name, sanitize_file_name};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

/// The longest name written, in bytes (under every file system's limit).
const MAX_NAME_BYTES: usize = 200;

/// `Name.ext` → (`Name`, `Some("ext")`) for a short alphanumeric extension.
pub(crate) fn split_ext(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(i)
            if i > 0
                && name.len() - i - 1 <= 10
                && name[i + 1..].chars().all(|c| c.is_ascii_alphanumeric())
                && i + 1 < name.len() =>
        {
            (&name[..i], Some(&name[i + 1..]))
        }
        _ => (name, None),
    }
}

/// One export name as a vault name: id stripped, refused characters as `-`,
/// no trailing dots or spaces, no Windows device name, at most 200 bytes.
pub fn clean_component(raw: &str, is_file: bool) -> String {
    let stripped = strip_notion_id(raw);
    let (stem, ext) = if is_file {
        split_ext(&stripped)
    } else {
        (stripped.as_str(), None)
    };
    let mut stem = sanitize_file_name(stem)
        .trim_end_matches(['.', ' '])
        .to_string();
    // One byte kept for the `-` a device name gets.
    let room = MAX_NAME_BYTES - 1 - ext.map_or(0, |e| e.len() + 1);
    if stem.len() > room {
        let mut cut = room;
        while !stem.is_char_boundary(cut) {
            cut -= 1;
        }
        stem.truncate(cut);
        stem = stem.trim_end_matches(['.', ' ']).to_string();
    }
    if stem.is_empty() {
        stem = "Untitled".to_string();
    }
    // After the cut: cutting can leave a device name (`CON   …x` → `CON`).
    if device_name(&stem) {
        stem.push('-');
    }
    match ext {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem,
    }
}

/// How two names clash: case and Unicode form ignored (macOS, Windows).
fn key(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

/// Export paths to vault paths, one folder at a time.
#[derive(Debug, Default)]
pub struct NameMap {
    map: HashMap<String, String>,
    taken: HashMap<String, HashSet<String>>,
}

impl NameMap {
    /// The vault path of `orig` (an export path), giving it one — and its
    /// folders — on first sight. Call in a stable order.
    pub fn assign(&mut self, orig: &[String], is_file: bool) -> String {
        let joined = orig.join("/");
        if let Some(done) = self.map.get(&joined) {
            return done.clone();
        }
        let folder = match orig.split_last() {
            Some((_, parent)) if !parent.is_empty() => self.assign(parent, false),
            _ => String::new(),
        };
        let raw = orig.last().map_or("", String::as_str);
        let path = self.claim(&folder, &clean_component(raw, is_file), is_file);
        self.map.insert(joined, path.clone());
        path
    }

    /// A free name in `folder` for `name` (already clean): `name`, else
    /// `Name 1.ext`, `Name 2.ext`…; returns its vault path.
    pub fn claim(&mut self, folder: &str, name: &str, is_file: bool) -> String {
        let taken = self.taken.entry(folder.to_string()).or_default();
        let (stem, ext) = if is_file {
            split_ext(name)
        } else {
            (name, None)
        };
        let free = (0..)
            .map(|i| match (i, ext) {
                (0, _) => name.to_string(),
                (_, Some(ext)) => format!("{stem} {i}.{ext}"),
                (_, None) => format!("{stem} {i}"),
            })
            .find(|n| !taken.contains(&key(n)))
            .expect("a free name");
        taken.insert(key(&free));
        if folder.is_empty() {
            free
        } else {
            format!("{folder}/{free}")
        }
    }

    /// The vault path given to `orig`, if any.
    pub fn get(&self, orig: &[String]) -> Option<&str> {
        self.map.get(&orig.join("/")).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

    fn p(s: &str) -> Vec<String> {
        s.split('/').map(String::from).collect()
    }

    #[test]
    fn m7_cleans_one_name() {
        assert_eq!(
            clean_component(&format!("Plan: Q4? {ID}.md"), true),
            "Plan- Q4-.md"
        );
        assert_eq!(
            clean_component(&format!("Projects {ID}"), false),
            "Projects"
        );
        assert_eq!(clean_component(".hidden.md", true), "-hidden.md");
        assert_eq!(clean_component("Trailing... .md", true), "Trailing.md");
        assert_eq!(clean_component("CON.md", true), "CON-.md");
        assert_eq!(clean_component("v1.2 notes", false), "v1.2 notes");
        assert_eq!(clean_component(".md", true), "-md");
    }

    #[test]
    fn m7_cuts_long_names_on_a_character() {
        let long = format!("{}.md", "é".repeat(150));
        let out = clean_component(&long, true);
        assert!(out.len() <= MAX_NAME_BYTES, "{}", out.len());
        assert!(out.ends_with(".md"));
    }

    #[test]
    fn b6_review_m6_a_cut_never_leaves_a_device_name() {
        let raw = format!("CON{}x", " ".repeat(240));
        assert_eq!(clean_component(&raw, false), "CON-");
        assert_eq!(clean_component(&format!("{raw}.md"), true), "CON-.md");
    }

    #[test]
    fn m7_numbers_duplicates_in_one_folder_only() {
        let mut names = NameMap::default();
        assert_eq!(
            names.assign(&p(&format!("Notes {ID}.md")), true),
            "Notes.md"
        );
        let other = "ffffffffffffffffffffffffffffffff";
        assert_eq!(
            names.assign(&p(&format!("Notes {other}.md")), true),
            "Notes 1.md"
        );
        assert_eq!(names.assign(&p("NOTES.md"), true), "NOTES 2.md");
        assert_eq!(
            names.assign(&p(&format!("A {ID}/Notes {other}.md")), true),
            "A/Notes.md"
        );
    }

    #[test]
    fn m7_unicode_forms_collide() {
        let mut names = NameMap::default();
        assert_eq!(names.assign(&p("Cafe\u{301}.md"), true), "Cafe\u{301}.md");
        assert_eq!(names.assign(&p("Caf\u{e9}.md"), true), "Caf\u{e9} 1.md");
    }

    #[test]
    fn m7_a_page_and_its_folder_coexist() {
        let mut names = NameMap::default();
        assert_eq!(names.assign(&p(&format!("Home {ID}.md")), true), "Home.md");
        assert_eq!(
            names.assign(&p(&format!("Home {ID}/Child {ID}.md")), true),
            "Home/Child.md"
        );
        assert_eq!(names.get(&p(&format!("Home {ID}"))), Some("Home"));
    }

    #[test]
    fn m7_claims_generated_names() {
        let mut names = NameMap::default();
        names.assign(&p("Tasks/Row.md"), true);
        assert_eq!(names.claim("Tasks", "Row.md", true), "Tasks/Row 1.md");
        assert_eq!(names.claim("", "Tasks.md", true), "Tasks.md");
    }
}
