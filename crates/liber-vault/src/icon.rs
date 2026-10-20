//! Folder and vault icons (M5b §4), kept in `.liber/vault.json` so folders
//! (which have no frontmatter) and the vault can carry an emoji:
//! `folderIcons` maps folder paths to one, following renames and forgotten
//! on delete like `coverHeights`; `icon` is the vault's own. Values are
//! stored as given; callers check they are emoji (`liber_markdown::is_icon`).

use crate::Result;
use crate::vault::{LIBER_JSON, Vault, read_json};
use std::collections::BTreeMap;
use std::path::Path;

const FOLDERS: &str = "folderIcons";
const VAULT: &str = "icon";

/// A stored icon: a short string; anything else reads as none.
fn parse(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .map(str::to_string)
}

/// The icon of the vault at `root`, read without opening it (the recent
/// vaults list); a vault not reopened since the rename is read where its
/// settings still are, without moving anything.
pub fn vault_icon_at(root: &Path) -> Option<String> {
    let value: serde_json::Value = read_json(root, LIBER_JSON, &mut Vec::new());
    value.get(VAULT).and_then(parse)
}

impl Vault {
    /// Folders with an icon, re-read on every call.
    pub fn folder_icons(&self) -> BTreeMap<String, String> {
        self.page_entries(FOLDERS, parse)
    }

    /// Sets (`Some`) or clears (`None`) one folder's icon.
    pub fn set_folder_icon(&self, path: &str, icon: Option<&str>) -> Result<()> {
        self.set_page_entry(FOLDERS, path, icon.map(Into::into))
    }

    /// Forgets the icons of deleted folders (and of folders inside them).
    pub fn forget_folder_icons(&self, removed: &[String]) -> Result<()> {
        self.forget_page_entries(FOLDERS, removed)
    }

    /// Folder icons follow a batch of renames.
    pub fn remap_folder_icons_many(&self, renames: &[(String, String)]) -> Result<()> {
        self.remap_page_entries(FOLDERS, renames)
    }

    /// The vault's own icon.
    pub fn vault_icon(&self) -> Option<String> {
        vault_icon_at(self.root())
    }

    /// Sets or clears the vault's icon; clearing what isn't set writes
    /// nothing.
    pub fn set_vault_icon(&self, icon: Option<&str>) -> Result<()> {
        self.update_json_object(LIBER_JSON, icon.is_some(), |map| match icon {
            Some(icon) => {
                map.insert(VAULT.to_string(), icon.into());
            }
            None => {
                map.remove(VAULT);
            }
        })
    }
}
