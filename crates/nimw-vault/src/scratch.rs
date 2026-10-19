//! Quick notes (M4c §2, §7), kept in `.nimw/vault.json` so notes are never
//! written: `autoNamed` lists the notes still named after their first line
//! (vault paths), and `scratchpadFolder` names the vault's scratch folder,
//! a top-level folder (`Scratchpad` when unset).

use crate::Result;
use crate::is_hidden_name;
use crate::vault::{NIMW_JSON, Vault, read_json};
use serde_json::Value;
use std::collections::BTreeSet;

/// The scratch folder's name when the vault sets none.
pub const DEFAULT_SCRATCH_FOLDER: &str = "Scratchpad";

const AUTO_NAMED: &str = "autoNamed";
const SCRATCH_FOLDER: &str = "scratchpadFolder";

/// Characters a folder name the app creates can't hold (the session's name
/// rule, M1a amendment 9).
const REFUSED: &[char] = &[
    '/', '\\', '#', '|', '^', '[', ']', ':', '*', '"', '<', '>', '?',
];

/// A name usable as the scratch folder: one visible top-level folder name.
fn usable_folder(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed == name
        && !is_hidden_name(name)
        && !name.contains(REFUSED)
        && !name.chars().any(char::is_control)
}

/// `path` is `root` or inside it.
fn under(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl Vault {
    /// Notes still named after their first line, re-read on every call;
    /// entries that aren't strings are left out.
    pub fn auto_named(&self) -> BTreeSet<String> {
        let value: Value = read_json(self.root(), NIMW_JSON, &mut Vec::new());
        value
            .get(AUTO_NAMED)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Flags (`on`) or unflags one note, keeping every other key; nothing is
    /// written when nothing changes, and an emptied list is removed.
    pub fn set_auto_named(&self, path: &str, on: bool) -> Result<()> {
        self.edit_auto_named(on, |set| {
            if on {
                set.insert(path.to_string());
            } else {
                set.remove(path);
            }
        })
    }

    /// Unflags the notes at or inside any of `paths` (deleted, renamed or
    /// moved); one write, none when nothing was flagged.
    pub fn forget_auto_named(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.edit_auto_named(false, |set| {
            set.retain(|p| !paths.iter().any(|gone| under(p, gone)));
        })
    }

    /// The vault's scratch folder: `scratchpadFolder`, else `Scratchpad`; a
    /// value that isn't one visible top-level name reads as the default.
    pub fn scratch_folder(&self) -> String {
        let value: Value = read_json(self.root(), NIMW_JSON, &mut Vec::new());
        value
            .get(SCRATCH_FOLDER)
            .and_then(Value::as_str)
            .filter(|name| usable_folder(name))
            .unwrap_or(DEFAULT_SCRATCH_FOLDER)
            .to_string()
    }

    /// Names the scratch folder (the caller has validated `name`); the
    /// default clears the key.
    pub fn set_scratch_folder(&self, name: &str) -> Result<()> {
        let custom = name != DEFAULT_SCRATCH_FOLDER;
        self.update_json_object(NIMW_JSON, custom, |map| {
            if custom {
                map.insert(SCRATCH_FOLDER.to_string(), name.into());
            } else {
                map.remove(SCRATCH_FOLDER);
            }
        })
    }

    /// The scratch folder follows a rename to another top-level name (in the
    /// app or seen by the watcher); a move into a folder leaves the setting,
    /// and the next quick note creates the folder again.
    pub fn follow_scratch_folder(&self, renames: &[(String, String)]) -> Result<()> {
        let current = self.scratch_folder();
        let Some((_, to)) = renames.iter().find(|(from, _)| *from == current) else {
            return Ok(());
        };
        if usable_folder(to) {
            self.set_scratch_folder(to)
        } else {
            Ok(())
        }
    }

    /// Applies `edit` to the `autoNamed` set; a value that isn't a list is
    /// replaced.
    fn edit_auto_named(&self, create: bool, edit: impl Fn(&mut BTreeSet<String>)) -> Result<()> {
        self.update_json_object(NIMW_JSON, create, |map| {
            let mut set: BTreeSet<String> = map
                .get(AUTO_NAMED)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let before = set.clone();
            edit(&mut set);
            if set == before && map.get(AUTO_NAMED).is_some_and(Value::is_array) {
                return;
            }
            if set.is_empty() {
                map.remove(AUTO_NAMED);
            } else {
                map.insert(
                    AUTO_NAMED.to_string(),
                    Value::Array(set.into_iter().map(Value::from).collect()),
                );
            }
        })
    }
}
