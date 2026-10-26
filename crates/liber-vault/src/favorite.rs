//! Favorites (M5b §19), kept in `.liber/vault.json`: `favorites` lists vault
//! paths of pages and folders in the order they were added. Entries follow
//! renames and moves (into the Trash and the Archive too, so Restore and
//! Unarchive bring them back) and are forgotten when deleted from the vault.
//! Paths are stored as given; callers validate them.
//!
//! The sidebar's Open list (0.1.2) lives beside them as `open`: the pages and
//! files open for editing, in the order they were opened. It follows renames
//! and forgets deletions the same way.

use crate::Result;
use crate::layout::remap;
use crate::vault::{LIBER_JSON, Vault, read_json};
use serde_json::Value;
use std::collections::HashMap;

const KEY: &str = "favorites";
const OPEN: &str = "open";

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
        let value: Value = read_json(self.storage(), LIBER_JSON, &mut Vec::new());
        list(value.get(KEY))
    }

    /// Replaces the list, keeping every other key; an empty list removes it.
    pub fn set_favorites(&self, paths: &[String]) -> Result<()> {
        self.edit_lists(&[KEY], !paths.is_empty(), |list| *list = paths.to_vec())
    }

    /// The Open list, re-read on every call.
    pub fn open_pages(&self) -> Vec<String> {
        let value: Value = read_json(self.storage(), LIBER_JSON, &mut Vec::new());
        list(value.get(OPEN))
    }

    /// Replaces the Open list, keeping every other key; empty removes it.
    pub fn set_open_pages(&self, paths: &[String]) -> Result<()> {
        self.edit_lists(&[OPEN], !paths.is_empty(), |list| *list = paths.to_vec())
    }

    /// Entries (favorites and the Open list) follow a batch of renames (whole
    /// components only), keeping their place; one write, none when nothing
    /// moved.
    pub fn remap_favorites_many(&self, renames: &[(String, String)]) -> Result<()> {
        if renames.is_empty() {
            return Ok(());
        }
        let moves: HashMap<&str, &str> = renames
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        self.edit_lists(&[KEY, OPEN], false, |list| {
            for path in list.iter_mut() {
                if let Some(to) = remap(path, &moves) {
                    *path = to;
                }
            }
        })
    }

    /// Forgets deleted entries (favorites and the Open list) and everything
    /// inside deleted folders.
    pub fn forget_favorites(&self, removed: &[String]) -> Result<()> {
        if removed.is_empty() {
            return Ok(());
        }
        self.edit_lists(&[KEY, OPEN], false, |list| {
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

    fn edit_lists(
        &self,
        keys: &[&str],
        create: bool,
        edit: impl Fn(&mut Vec<String>),
    ) -> Result<()> {
        self.update_json_object(LIBER_JSON, create, |map| {
            for key in keys {
                let mut items = list(map.get(*key));
                edit(&mut items);
                if items.is_empty() {
                    map.remove(*key);
                } else {
                    map.insert(
                        key.to_string(),
                        Value::Array(items.into_iter().map(Value::from).collect()),
                    );
                }
            }
        })
    }
}
