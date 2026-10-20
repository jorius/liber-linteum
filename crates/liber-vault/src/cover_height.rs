//! Cover height per page (cover resize), kept in `.liber/vault.json` so notes
//! are never written: `coverHeights` maps page paths to the height in px the
//! user dragged their cover band to. Pages without an entry use the app's
//! default. Entries follow renames and are forgotten on delete, like
//! `pageWidths` (see `page_width.rs`).

use crate::Result;
use crate::vault::{LIBER_JSON, Vault, read_json};
use std::collections::BTreeMap;

/// The smallest cover band, in px: the M4b header band.
pub const MIN_COVER_HEIGHT: u32 = 132;
/// The tallest cover height stored, in px. The UI also caps what it shows at
/// 60% of the window, without changing what is stored.
pub const MAX_COVER_HEIGHT: u32 = 2000;

const KEY: &str = "coverHeights";

fn clamp(px: u32) -> u32 {
    px.clamp(MIN_COVER_HEIGHT, MAX_COVER_HEIGHT)
}

/// A stored height: a positive number (a hand-edited fraction is rounded),
/// clamped to the range; anything else is left out.
fn parse(value: &serde_json::Value) -> Option<u32> {
    let px = value.as_f64().filter(|px| px.is_finite() && *px > 0.0)?;
    Some(clamp(px.round().min(f64::from(u32::MAX)) as u32))
}

impl Vault {
    /// Pages with their own cover height, re-read on every call; unreadable
    /// entries are left out, one by one.
    pub fn cover_heights(&self) -> BTreeMap<String, u32> {
        let value: serde_json::Value = read_json(self.storage(), LIBER_JSON, &mut Vec::new());
        let mut out = BTreeMap::new();
        if let Some(pages) = value.get(KEY).and_then(|v| v.as_object()) {
            for (path, height) in pages {
                if let Some(height) = parse(height) {
                    out.insert(path.clone(), height);
                }
            }
        }
        out
    }

    /// Sets (`Some`, clamped to 132–2000 px) or clears (`None`) one page's
    /// cover height, keeping every other key; clearing what isn't set writes
    /// nothing (VLT-02).
    pub fn set_cover_height(&self, path: &str, height: Option<u32>) -> Result<()> {
        self.update_json_object(LIBER_JSON, height.is_some(), |map| {
            let pages = map
                .entry(KEY)
                .or_insert_with(|| serde_json::Value::Object(Default::default()));
            if !pages.is_object() {
                *pages = serde_json::Value::Object(Default::default());
            }
            let pages = pages.as_object_mut().expect("an object");
            match height {
                Some(px) => {
                    pages.insert(path.to_string(), clamp(px).into());
                }
                None => {
                    pages.remove(path);
                }
            }
            if pages.is_empty() {
                map.remove(KEY);
            }
        })
    }

    /// Forgets the cover heights of deleted pages, and of every page inside a
    /// deleted folder (a new page at the same path starts at the default);
    /// one write, none when nothing was set.
    pub fn forget_cover_heights(&self, removed: &[String]) -> Result<()> {
        self.forget_page_entries(KEY, removed)
    }

    /// Cover heights follow a batch of renames (files and folders); one
    /// write, none when nothing moved.
    pub fn remap_cover_heights_many(&self, renames: &[(String, String)]) -> Result<()> {
        self.remap_page_entries(KEY, renames)
    }
}
