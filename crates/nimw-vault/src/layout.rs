//! M3a §7: pinned Global View card positions, per level, in
//! `.nimw/layout.json` (arch §3.1): `{ "version": 1, "levels": { "<level
//! key>": { "<card path>": { "x": 0, "y": 0 } } } }`. Level keys: `""` (the
//! vault), a folder path, `page:<path>`, `expand:<level key>`.

use crate::error::{Result, VaultError};
use crate::path::VaultPath;
use crate::vault::{Vault, read_json};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

const LAYOUT_JSON: &str = ".nimw/layout.json";

/// Where a card was dropped on the canvas (flow coordinates).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CardPosition {
    pub x: f64,
    pub y: f64,
}

/// An entry's position, when it is one (finite `x` and `y`).
fn position(value: &serde_json::Value) -> Option<CardPosition> {
    CardPosition::deserialize(value)
        .ok()
        .filter(|p| p.x.is_finite() && p.y.is_finite())
}

impl Vault {
    /// The pinned positions of one level (none when the file is missing or
    /// unreadable — the layout is a convenience, never an error). Read per
    /// entry (final review m8): a malformed level or entry, or one a later
    /// version adds, is skipped on its own.
    pub fn layout_level(&self, level: &str) -> BTreeMap<String, CardPosition> {
        let layout: serde_json::Value = read_json(self.root(), LAYOUT_JSON, &mut Vec::new());
        let Some(cards) = layout
            .get("levels")
            .and_then(|levels| levels.get(level))
            .and_then(serde_json::Value::as_object)
        else {
            return BTreeMap::new();
        };
        cards
            .iter()
            .filter_map(|(path, value)| Some((path.clone(), position(value)?)))
            .collect()
    }

    /// Stores a level's pinned positions (an empty map removes the level).
    /// The file is created on first need; other keys are kept, and so are
    /// the level's entries this version can't read as positions (m8).
    ///
    /// The file doesn't only grow (final review m10): positions of paths
    /// that no longer exist are dropped from the saved level, a level whose
    /// own folder or page is gone is not stored, and the levels of other
    /// deleted folders and pages are dropped (one `lstat` per level). Other
    /// levels' positions are pruned when those levels are saved (§7).
    pub fn set_layout_level(
        &self,
        level: &str,
        positions: &BTreeMap<String, CardPosition>,
    ) -> Result<()> {
        if positions
            .values()
            .any(|p| !p.x.is_finite() || !p.y.is_finite())
        {
            return Err(VaultError::InvalidConfig {
                file: LAYOUT_JSON.to_string(),
                reason: "card positions must be finite numbers".to_string(),
            });
        }
        let level_exists = self.level_exists(level);
        let saved: serde_json::Map<String, serde_json::Value> = positions
            .iter()
            .filter(|(path, _)| level_exists && self.path_exists(path))
            .map(|(path, p)| {
                let value = serde_json::to_value(p).expect("finite positions serialize");
                (path.clone(), value)
            })
            .collect();
        self.update_json_object(LAYOUT_JSON, !saved.is_empty(), |map| {
            let levels = levels_of(map);
            let mut cards: serde_json::Map<String, serde_json::Value> = match levels.get(level) {
                Some(serde_json::Value::Object(old)) => old
                    .iter()
                    .filter(|(_, value)| position(value).is_none())
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
                _ => serde_json::Map::new(),
            };
            cards.extend(saved.clone());
            if cards.is_empty() {
                levels.remove(level);
            } else {
                levels.insert(level.to_string(), serde_json::Value::Object(cards));
            }
            levels.retain(|key, _| self.level_exists(key));
        })
    }

    /// Follows a rename or move of `from` to `to` (file or folder): level
    /// keys and card paths at or below `from` move below `to`. Without a
    /// layout file nothing is written.
    pub fn remap_layout(&self, from: &str, to: &str) -> Result<()> {
        self.remap_layout_many(&[(from.to_string(), to.to_string())])
    }

    /// [`Vault::remap_layout`] for a batch of renames (e.g. one watcher
    /// batch): one read, every pair applied in one pass, and one write — only
    /// when a key or entry actually moved (final review I3: each write is an
    /// fsync, and another program moving 1,000 notes reports 1,000 renames).
    ///
    /// Nothing exists at a rename's destination before the rename, so keys
    /// and entries already at or below a `to` are leftovers of a deleted
    /// folder or page with that name: they are dropped and the moved ones
    /// win (final review m10). A remap that moved something also drops the
    /// levels of deleted folders and pages, as a level save does.
    pub fn remap_layout_many(&self, renames: &[(String, String)]) -> Result<()> {
        if renames.is_empty() {
            return Ok(());
        }
        let moves: HashMap<&str, &str> = renames
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        let destinations: HashSet<&str> = moves.values().copied().collect();
        let leftover = |path: &str| at_or_below(path, &destinations);
        self.update_json_object(LAYOUT_JSON, false, |map| {
            let Some(levels) = map
                .get_mut("levels")
                .and_then(serde_json::Value::as_object_mut)
            else {
                return;
            };
            let mut changed = false;
            for (key, cards) in std::mem::take(levels) {
                let cards = match cards {
                    serde_json::Value::Object(cards) => {
                        let mut kept = serde_json::Map::new();
                        for (path, pos) in cards {
                            match remap(&path, &moves) {
                                Some(moved) => {
                                    changed = true;
                                    kept.insert(moved, pos);
                                }
                                None if leftover(&path) => changed = true,
                                None => {
                                    kept.entry(path).or_insert(pos);
                                }
                            }
                        }
                        serde_json::Value::Object(kept)
                    }
                    other => other,
                };
                match remap_level_key(&key, &moves) {
                    Some(moved) => {
                        changed = true;
                        levels.insert(moved, cards);
                    }
                    None if leftover(level_path(&key)) => changed = true,
                    None => {
                        levels.entry(key).or_insert(cards);
                    }
                }
            }
            if changed {
                levels.retain(|key, _| self.level_exists(key));
            }
        })
    }

    /// Index-note picks (`.nimw/vault.json` `indexPicks`) follow a batch of
    /// renames, folder keys and page values alike (M3b §4); one write, and
    /// none when nothing changed. A pick whose page no longer sits directly
    /// in its folder — moved out, or hand-edited that way — is dropped, never
    /// carried along to the page's new folder (final review I4).
    pub fn remap_index_picks_many(&self, renames: &[(String, String)]) -> Result<()> {
        if renames.is_empty() {
            return Ok(());
        }
        let moves: HashMap<&str, &str> = renames
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        self.update_json_object(crate::vault::NIMW_JSON, false, |map| {
            let Some(picks) = map
                .get_mut("indexPicks")
                .and_then(serde_json::Value::as_object_mut)
            else {
                return;
            };
            for (folder, page) in std::mem::take(picks) {
                let folder = remap(&folder, &moves).unwrap_or(folder);
                let page = match page {
                    serde_json::Value::String(p) => {
                        let p = remap(&p, &moves).unwrap_or(p);
                        if !crate::vault::pick_holds(&folder, &p) {
                            continue;
                        }
                        serde_json::Value::String(p)
                    }
                    other => other,
                };
                picks.insert(folder, page);
            }
        })
    }

    /// Forgets the positions, levels and index-note picks of deleted pages
    /// and folders (and of what was inside them); one write per file, none
    /// when nothing named them.
    pub fn forget_layout(&self, removed: &[String]) -> Result<()> {
        let gone: HashSet<&str> = removed.iter().map(String::as_str).collect();
        if gone.is_empty() {
            return Ok(());
        }
        let layout = self.update_json_object(LAYOUT_JSON, false, |map| {
            let Some(levels) = map
                .get_mut("levels")
                .and_then(serde_json::Value::as_object_mut)
            else {
                return;
            };
            levels.retain(|key, _| !at_or_below(level_path(key), &gone));
            for cards in levels.values_mut() {
                if let Some(cards) = cards.as_object_mut() {
                    cards.retain(|path, _| !at_or_below(path, &gone));
                }
            }
        });
        let picks = self.update_json_object(crate::vault::NIMW_JSON, false, |map| {
            if let Some(picks) = map
                .get_mut("indexPicks")
                .and_then(serde_json::Value::as_object_mut)
            {
                picks.retain(|folder, page| {
                    !at_or_below(folder, &gone)
                        && page.as_str().is_none_or(|p| !at_or_below(p, &gone))
                });
            }
        });
        layout.and(picks)
    }

    /// True when `path` names something on disk (`""`: the vault).
    fn path_exists(&self, path: &str) -> bool {
        path.is_empty()
            || VaultPath::new(path)
                .is_ok_and(|p| p.to_fs_path(self.root()).symlink_metadata().is_ok())
    }

    /// True when a level key's folder or page still exists.
    fn level_exists(&self, key: &str) -> bool {
        self.path_exists(level_path(key))
    }
}

/// The folder or page a level key shows: `""`, `<folder>`, `page:<path>`,
/// `expand:<level key>`.
fn level_path(key: &str) -> &str {
    let mut key = key;
    while let Some(rest) = key.strip_prefix("expand:") {
        key = rest;
    }
    key.strip_prefix("page:").unwrap_or(key)
}

/// True when `path` or one of its folders is in `paths`.
fn at_or_below(path: &str, paths: &HashSet<&str>) -> bool {
    let mut prefix = path;
    loop {
        if paths.contains(prefix) {
            return true;
        }
        match prefix.rfind('/') {
            Some(i) => prefix = &prefix[..i],
            None => return false,
        }
    }
}

/// The `levels` object of a layout file (created if missing or not an object).
fn levels_of(
    map: &mut serde_json::Map<String, serde_json::Value>,
) -> &mut serde_json::Map<String, serde_json::Value> {
    let entry = map
        .entry("levels")
        .or_insert_with(|| serde_json::Value::Object(Default::default()));
    if !entry.is_object() {
        *entry = serde_json::Value::Object(Default::default());
    }
    entry.as_object_mut().expect("just made an object")
}

/// `path` moved by the nearest rename at or above it: a `from` equal to
/// `path`, or to one of its folders (whole components only, so `Alpha` never
/// touches `Alphabet`), is replaced by its `to`.
pub(crate) fn remap(path: &str, moves: &HashMap<&str, &str>) -> Option<String> {
    let mut prefix = path;
    loop {
        if let Some(to) = moves.get(prefix) {
            return Some(format!("{to}{}", &path[prefix.len()..]));
        }
        prefix = &prefix[..prefix.rfind('/')?];
    }
}

fn remap_level_key(key: &str, moves: &HashMap<&str, &str>) -> Option<String> {
    if let Some(rest) = key.strip_prefix("expand:") {
        return remap_level_key(rest, moves).map(|k| format!("expand:{k}"));
    }
    if let Some(rest) = key.strip_prefix("page:") {
        return remap(rest, moves).map(|p| format!("page:{p}"));
    }
    remap(key, moves)
}
