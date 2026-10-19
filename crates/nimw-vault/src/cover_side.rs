//! Side covers (M4b part 3 §3), kept in `.nimw/vault.json` so notes are never
//! written: `coverSides` maps page paths to where their cover sits ("left" or
//! "right"; no entry is the header band, the default), `coverWidths` to the
//! strip width in px the user dragged it to. Entries follow renames and are
//! forgotten on delete, like `coverHeights` (see `cover_height.rs`).

use crate::Result;
use crate::vault::{NIMW_JSON, Vault, read_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The narrowest strip, in px.
pub const MIN_COVER_WIDTH: u32 = 160;
/// The widest strip stored, in px. The UI also caps what it shows at 45% of
/// the window, without changing what is stored.
pub const MAX_COVER_WIDTH: u32 = 2000;

const SIDES: &str = "coverSides";
const WIDTHS: &str = "coverWidths";

/// Where a page's cover sits: the header band (default) or a tall strip
/// beside the text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverSide {
    #[default]
    Top,
    Left,
    Right,
}

impl CoverSide {
    pub fn as_str(self) -> &'static str {
        match self {
            CoverSide::Top => "top",
            CoverSide::Left => "left",
            CoverSide::Right => "right",
        }
    }
}

/// A stored width: a positive number (a hand-edited fraction is rounded),
/// clamped to the range; anything else is left out.
fn parse_width(value: &serde_json::Value) -> Option<u32> {
    let px = value.as_f64().filter(|px| px.is_finite() && *px > 0.0)?;
    Some(clamp_width(px.round().min(f64::from(u32::MAX)) as u32))
}

fn clamp_width(px: u32) -> u32 {
    px.clamp(MIN_COVER_WIDTH, MAX_COVER_WIDTH)
}

impl Vault {
    /// Pages whose cover sits beside the text, re-read on every call;
    /// unreadable entries (and a hand-written "top") are left out.
    pub fn cover_sides(&self) -> BTreeMap<String, CoverSide> {
        self.page_entries(SIDES, |v| {
            serde_json::from_value::<CoverSide>(v.clone())
                .ok()
                .filter(|s| *s != CoverSide::Top)
        })
    }

    /// Pages with their own strip width, re-read on every call.
    pub fn cover_widths(&self) -> BTreeMap<String, u32> {
        self.page_entries(WIDTHS, parse_width)
    }

    /// Sets one page's cover placement; `Top` (the default) clears the entry.
    /// Clearing what isn't set writes nothing (VLT-02).
    pub fn set_cover_side(&self, path: &str, side: CoverSide) -> Result<()> {
        let value = (side != CoverSide::Top).then(|| side.as_str().into());
        self.set_page_entry(SIDES, path, value)
    }

    /// Sets (`Some`, clamped to 160–2000 px) or clears (`None`) one page's
    /// strip width.
    pub fn set_cover_width(&self, path: &str, width: Option<u32>) -> Result<()> {
        self.set_page_entry(WIDTHS, path, width.map(|px| clamp_width(px).into()))
    }

    /// Forgets the placements of deleted pages and folders; one write, none
    /// when nothing was set.
    pub fn forget_cover_sides(&self, removed: &[String]) -> Result<()> {
        self.forget_page_entries(SIDES, removed)
    }

    /// Forgets the strip widths of deleted pages and folders.
    pub fn forget_cover_widths(&self, removed: &[String]) -> Result<()> {
        self.forget_page_entries(WIDTHS, removed)
    }

    /// Placements follow a batch of renames (files and folders).
    pub fn remap_cover_sides_many(&self, renames: &[(String, String)]) -> Result<()> {
        self.remap_page_entries(SIDES, renames)
    }

    /// Strip widths follow a batch of renames (files and folders).
    pub fn remap_cover_widths_many(&self, renames: &[(String, String)]) -> Result<()> {
        self.remap_page_entries(WIDTHS, renames)
    }

    /// The readable entries of one page-keyed map.
    pub(crate) fn page_entries<T>(
        &self,
        key: &str,
        parse: impl Fn(&serde_json::Value) -> Option<T>,
    ) -> BTreeMap<String, T> {
        let value: serde_json::Value = read_json(self.root(), NIMW_JSON, &mut Vec::new());
        let mut out = BTreeMap::new();
        if let Some(pages) = value.get(key).and_then(|v| v.as_object()) {
            for (path, entry) in pages {
                if let Some(entry) = parse(entry) {
                    out.insert(path.clone(), entry);
                }
            }
        }
        out
    }

    /// Sets (`Some`) or clears (`None`) one entry of a page-keyed map,
    /// keeping every other key; an emptied map is removed.
    pub(crate) fn set_page_entry(
        &self,
        key: &str,
        path: &str,
        value: Option<serde_json::Value>,
    ) -> Result<()> {
        self.update_json_object(NIMW_JSON, value.is_some(), |map| {
            let pages = map
                .entry(key)
                .or_insert_with(|| serde_json::Value::Object(Default::default()));
            if !pages.is_object() {
                *pages = serde_json::Value::Object(Default::default());
            }
            let pages = pages.as_object_mut().expect("an object");
            match &value {
                Some(value) => {
                    pages.insert(path.to_string(), value.clone());
                }
                None => {
                    pages.remove(path);
                }
            }
            if pages.is_empty() {
                map.remove(key);
            }
        })
    }
}
