//! M3a §7: pinned Global View card positions, per level, in
//! `.nimw/layout.json` (arch §3.1): `{ "version": 1, "levels": { "<level
//! key>": { "<card path>": { "x": 0, "y": 0 } } } }`. Level keys: `""` (the
//! vault), a folder path, `page:<path>`, `expand:<level key>`.

use crate::error::{Result, VaultError};
use crate::vault::{Vault, read_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const LAYOUT_JSON: &str = ".nimw/layout.json";

/// Where a card was dropped on the canvas (flow coordinates).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CardPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Default, Deserialize)]
struct LayoutJson {
    #[serde(default)]
    levels: BTreeMap<String, BTreeMap<String, CardPosition>>,
}

impl Vault {
    /// The pinned positions of one level (none when the file is missing or
    /// unreadable — the layout is a convenience, never an error).
    pub fn layout_level(&self, level: &str) -> BTreeMap<String, CardPosition> {
        let layout: LayoutJson = read_json(self.root(), LAYOUT_JSON, &mut Vec::new());
        layout.levels.get(level).cloned().unwrap_or_default()
    }

    /// Stores a level's pinned positions (an empty map removes the level).
    /// The file is created on first need; other levels and keys are kept.
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
        let value = serde_json::to_value(positions).expect("positions serialize");
        self.update_json_object(LAYOUT_JSON, !positions.is_empty(), |map| {
            let levels = levels_of(map);
            if positions.is_empty() {
                levels.remove(level);
            } else {
                levels.insert(level.to_string(), value);
            }
        })
    }

    /// Follows a rename or move of `from` to `to` (file or folder): level
    /// keys and card paths at or below `from` move below `to`. Without a
    /// layout file nothing is written.
    pub fn remap_layout(&self, from: &str, to: &str) -> Result<()> {
        self.update_json_object(LAYOUT_JSON, false, |map| {
            let levels = levels_of(map);
            let old = std::mem::take(levels);
            for (key, cards) in old {
                let key = remap_level_key(&key, from, to).unwrap_or(key);
                let cards = match cards {
                    serde_json::Value::Object(cards) => serde_json::Value::Object(
                        cards
                            .into_iter()
                            .map(|(path, pos)| (remap(&path, from, to).unwrap_or(path), pos))
                            .collect(),
                    ),
                    other => other,
                };
                match (levels.get_mut(&key), cards) {
                    (
                        Some(serde_json::Value::Object(existing)),
                        serde_json::Value::Object(moved),
                    ) => {
                        existing.extend(moved);
                    }
                    (_, cards) => {
                        levels.insert(key, cards);
                    }
                }
            }
        })
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

/// `path` with `from` (itself or as a folder prefix) replaced by `to`.
fn remap(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    let rest = path.strip_prefix(from)?.strip_prefix('/')?;
    Some(format!("{to}/{rest}"))
}

fn remap_level_key(key: &str, from: &str, to: &str) -> Option<String> {
    if let Some(rest) = key.strip_prefix("expand:") {
        return remap_level_key(rest, from, to).map(|k| format!("expand:{k}"));
    }
    if let Some(rest) = key.strip_prefix("page:") {
        return remap(rest, from, to).map(|p| format!("page:{p}"));
    }
    remap(key, from, to)
}
