//! Favorites (M5b §19), kept in `.liber/vault.json`: `favorites` lists vault
//! paths of pages and folders in the order they were added. Entries follow
//! renames and moves (into the Trash and the Archive too, so Restore and
//! Unarchive bring them back) and are forgotten when deleted from the vault.
//! Paths are stored as given; callers validate them.

use crate::Result;
use crate::layout::remap;
use crate::vault::{LIBER_JSON, Vault, read_json};
use serde_json::Value;
use std::collections::HashMap;

const KEY: &str = "favorites";

fn list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

impl Vault {
    /// The favorites, re-read on every call; entries that aren't strings are
    /// left out.
    pub fn favorites(&self) -> Vec<String> {
        let value: Value = read_json(self.root(), LIBER_JSON, &mut Vec::new());
        list(value.get(KEY))
    }

    /// Replaces the list, keeping every other key; an empty list removes it.
    pub fn set_favorites(&self, paths: &[String]) -> Result<()> {
        self.edit_favorites(!paths.is_empty(), |list| *list = paths.to_vec())
    }

    /// Entries follow a batch of renames (whole components only), keeping
    /// their place; one write, none when nothing moved.
    pub fn remap_favorites_many(&self, renames: &[(String, String)]) -> Result<()> {
        if renames.is_empty() {
            return Ok(());
        }
        let moves: HashMap<&str, &str> = renames
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        self.edit_favorites(false, |list| {
            for path in list.iter_mut() {
                if let Some(to) = remap(path, &moves) {
                    *path = to;
                }
            }
        })
    }

    /// Forgets deleted entries and everything inside deleted folders.
    pub fn forget_favorites(&self, removed: &[String]) -> Result<()> {
        if removed.is_empty() {
            return Ok(());
        }
        self.edit_favorites(false, |list| {
            list.retain(|path| {
                !removed.iter().any(|gone| {
                    path == gone
                        || path
                            .strip_prefix(gone.as_str())
                            .is_some_and(|rest| rest.starts_with('/'))
                })
            });
        })
    }

    fn edit_favorites(&self, create: bool, edit: impl Fn(&mut Vec<String>)) -> Result<()> {
        self.update_json_object(LIBER_JSON, create, |map| {
            let mut items = list(map.get(KEY));
            edit(&mut items);
            if items.is_empty() {
                map.remove(KEY);
            } else {
                map.insert(
                    KEY.to_string(),
                    Value::Array(items.into_iter().map(Value::from).collect()),
                );
            }
        })
    }
}
