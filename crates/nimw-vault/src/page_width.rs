//! Full page width per vault and per page (M4b part 2 §1), kept in
//! `.nimw/vault.json` so notes are never written: `pageWidth` is the vault's
//! default, `pageWidths` maps page paths to their own width.

use crate::Result;
use crate::layout::remap;
use crate::vault::{NIMW_JSON, Vault, read_json};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// How wide a page reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageWidth {
    /// The readable measure (760 px in Live Preview).
    Readable,
    /// The text spans the editor.
    Full,
}

impl PageWidth {
    fn parse(value: &serde_json::Value) -> Option<PageWidth> {
        serde_json::from_value(value.clone()).ok()
    }

    fn as_str(self) -> &'static str {
        match self {
            PageWidth::Readable => "readable",
            PageWidth::Full => "full",
        }
    }
}

/// The vault's width settings; unreadable entries are left out, one by one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageWidths {
    /// The vault's default (`None`: the app setting).
    pub vault: Option<PageWidth>,
    /// Pages with their own width.
    pub pages: BTreeMap<String, PageWidth>,
}

impl Vault {
    /// The vault's page-width settings, re-read on every call.
    pub fn page_widths(&self) -> PageWidths {
        let value: serde_json::Value = read_json(self.root(), NIMW_JSON, &mut Vec::new());
        let mut out = PageWidths {
            vault: value.get("pageWidth").and_then(PageWidth::parse),
            ..PageWidths::default()
        };
        if let Some(pages) = value.get("pageWidths").and_then(|v| v.as_object()) {
            for (path, width) in pages {
                if let Some(width) = PageWidth::parse(width) {
                    out.pages.insert(path.clone(), width);
                }
            }
        }
        out
    }

    /// Sets (`Some`) or clears (`None`) one page's width, keeping every other
    /// key; clearing what isn't set writes nothing (VLT-02).
    pub fn set_page_width(&self, path: &str, width: Option<PageWidth>) -> Result<()> {
        self.update_json_object(NIMW_JSON, width.is_some(), |map| {
            let pages = map
                .entry("pageWidths")
                .or_insert_with(|| serde_json::Value::Object(Default::default()));
            if !pages.is_object() {
                *pages = serde_json::Value::Object(Default::default());
            }
            let pages = pages.as_object_mut().expect("an object");
            match width {
                Some(w) => {
                    pages.insert(path.to_string(), w.as_str().into());
                }
                None => {
                    pages.remove(path);
                }
            }
            if pages.is_empty() {
                map.remove("pageWidths");
            }
        })
    }

    /// Sets (`Some`) or clears (`None`) the vault's default width.
    pub fn set_vault_page_width(&self, width: Option<PageWidth>) -> Result<()> {
        self.update_json_object(NIMW_JSON, width.is_some(), |map| match width {
            Some(w) => {
                map.insert("pageWidth".to_string(), w.as_str().into());
            }
            None => {
                map.remove("pageWidth");
            }
        })
    }

    /// Forgets the widths of deleted pages, and of every page inside a deleted
    /// folder (final review M10: a new page at the same path starts at the
    /// default); one write, none when nothing was set.
    pub fn forget_page_widths(&self, removed: &[String]) -> Result<()> {
        self.forget_page_entries("pageWidths", removed)
    }

    /// Page widths follow a batch of renames (files and folders); one write,
    /// none when nothing moved.
    pub fn remap_page_widths_many(&self, renames: &[(String, String)]) -> Result<()> {
        self.remap_page_entries("pageWidths", renames)
    }

    /// Drops the entries of `key` (a page-path map in `.nimw/vault.json`) for
    /// deleted pages and for every page inside a deleted folder; one write,
    /// none when nothing was set. Shared by page widths and cover heights.
    pub(crate) fn forget_page_entries(&self, key: &str, removed: &[String]) -> Result<()> {
        if removed.is_empty() {
            return Ok(());
        }
        let gone = |path: &str| {
            removed.iter().any(|r| {
                path == r
                    || path
                        .strip_prefix(r.as_str())
                        .is_some_and(|rest| rest.starts_with('/'))
            })
        };
        self.update_json_object(NIMW_JSON, false, |map| {
            let Some(pages) = map.get_mut(key).and_then(serde_json::Value::as_object_mut) else {
                return;
            };
            pages.retain(|path, _| !gone(path));
            if pages.is_empty() {
                map.remove(key);
            }
        })
    }

    /// The entries of `key` (a page-path map in `.nimw/vault.json`) follow a
    /// batch of renames (files and folders); one write, none when nothing
    /// moved. Shared by page widths and cover heights.
    pub(crate) fn remap_page_entries(&self, key: &str, renames: &[(String, String)]) -> Result<()> {
        if renames.is_empty() {
            return Ok(());
        }
        let moves: HashMap<&str, &str> = renames
            .iter()
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        self.update_json_object(NIMW_JSON, false, |map| {
            let Some(pages) = map.get_mut(key).and_then(serde_json::Value::as_object_mut) else {
                return;
            };
            for (path, value) in std::mem::take(pages) {
                let path = remap(&path, &moves).unwrap_or(path);
                pages.insert(path, value);
            }
        })
    }
}
