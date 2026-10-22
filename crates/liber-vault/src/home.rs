//! A vault's home: what shows when it opens, kept in `.liber/vault.json` as
//! `home`: `{"kind": "page", "path": "<vault path>"}` (a page or text file)
//! or `{"kind": "globalView"}`. No key is "nothing chosen": the editor asks
//! for a page, as before homes existed.
//!
//! A page home follows renames and moves (its folder's too). It is cleared
//! when the page is deleted, or moved into the Trash or the Archive: a page
//! there can't be a home, and Restore or Unarchive doesn't bring it back.
//! Paths are stored as given; callers validate them.

use crate::Result;
use crate::layout::remap;
use crate::vault::{LIBER_JSON, Vault, read_json};
use crate::{ARCHIVE_DIR, TRASH_DIR};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const KEY: &str = "home";

/// What a vault opens to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Home {
    /// A page (or text file) of the vault, opened in the editor.
    Page { path: String },
    /// The Global View, at the vault's level.
    GlobalView,
}

/// In the vault's Trash or Archive, or one of them itself.
fn in_bin(path: &str) -> bool {
    [TRASH_DIR, ARCHIVE_DIR].iter().any(|dir| {
        path.strip_prefix(dir)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// `path` is `gone` or inside it.
fn within(path: &str, gone: &str) -> bool {
    path == gone
        || path
            .strip_prefix(gone)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// A stored home this version can read: anything else reads as none (and is
/// left alone until the user picks another).
fn parse(value: Option<&Value>) -> Option<Home> {
    let home = Home::deserialize(value?).ok()?;
    match &home {
        Home::Page { path } if path.is_empty() => None,
        _ => Some(home),
    }
}

impl Vault {
    /// The vault's home, re-read on every call; none when unset or unreadable.
    pub fn home(&self) -> Option<Home> {
        let value: Value = read_json(self.storage(), LIBER_JSON, &mut Vec::new());
        parse(value.get(KEY))
    }

    /// Sets (`Some`) or clears (`None`) the home, keeping every other key.
    /// Clearing what isn't set writes nothing (VLT-02).
    pub fn set_home(&self, home: Option<&Home>) -> Result<()> {
        self.update_json_object(LIBER_JSON, home.is_some(), |map| match home {
            Some(home) => {
                map.insert(
                    KEY.to_string(),
                    serde_json::to_value(home).expect("a home serializes"),
                );
            }
            None => {
                map.remove(KEY);
            }
        })
    }

    /// A page home follows a batch of renames (whole components only, so a
    /// folder's rename takes it along); one that lands in the Trash or the
    /// Archive is cleared. One write, none when nothing changed.
    pub fn remap_home_many(&self, renames: &[(String, String)]) -> Result<()> {
        if renames.is_empty() {
            return Ok(());
        }
        let Some(Home::Page { path }) = self.home() else {
            return Ok(());
        };
        let moves: HashMap<&str, &str> = renames
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        let Some(to) = remap(&path, &moves) else {
            return Ok(());
        };
        let next = (!in_bin(&to)).then_some(Home::Page { path: to });
        self.edit_home(&path, next)
    }

    /// Clears a page home that was deleted, or was inside a deleted folder.
    pub fn forget_home(&self, removed: &[String]) -> Result<()> {
        if removed.is_empty() {
            return Ok(());
        }
        let Some(Home::Page { path }) = self.home() else {
            return Ok(());
        };
        if removed.iter().any(|gone| within(&path, gone)) {
            self.edit_home(&path, None)?;
        }
        Ok(())
    }

    /// Replaces the page home `was` with `next`, unless another program
    /// changed it since it was read.
    fn edit_home(&self, was: &str, next: Option<Home>) -> Result<()> {
        self.update_json_object(LIBER_JSON, false, |map| {
            let still = matches!(parse(map.get(KEY)), Some(Home::Page { path }) if path == was);
            if !still {
                return;
            }
            match &next {
                Some(home) => {
                    map.insert(
                        KEY.to_string(),
                        serde_json::to_value(home).expect("a home serializes"),
                    );
                }
                None => {
                    map.remove(KEY);
                }
            }
        })
    }
}
