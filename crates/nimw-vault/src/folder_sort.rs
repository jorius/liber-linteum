//! Folder sort orders (M5b round 2): `.nimw/vault.json` `folderSorts` maps a
//! folder path (`""` for the vault root) to how its entries are listed. They
//! follow renames and are forgotten on delete, like `folderIcons`; the
//! default (name, A→Z) is never stored.

use crate::Result;
use crate::vault::Vault;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const KEY: &str = "folderSorts";

/// How a folder's entries are listed. Folders always come first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FolderSort {
    #[default]
    NameAsc,
    NameDesc,
    ModifiedDesc,
    ModifiedAsc,
    CreatedDesc,
}

impl Vault {
    /// Folders with an order of their own, re-read on every call.
    pub fn folder_sorts(&self) -> BTreeMap<String, FolderSort> {
        self.page_entries(KEY, |v| serde_json::from_value(v.clone()).ok())
    }

    /// Sets one folder's order; the default clears the entry.
    pub fn set_folder_sort(&self, path: &str, sort: FolderSort) -> Result<()> {
        let value = (sort != FolderSort::NameAsc)
            .then(|| serde_json::to_value(sort).expect("a plain enum"));
        self.set_page_entry(KEY, path, value)
    }

    /// Forgets the orders of deleted folders (and of folders inside them).
    pub fn forget_folder_sorts(&self, removed: &[String]) -> Result<()> {
        self.forget_page_entries(KEY, removed)
    }

    /// Orders follow a batch of renames.
    pub fn remap_folder_sorts_many(&self, renames: &[(String, String)]) -> Result<()> {
        self.remap_page_entries(KEY, renames)
    }
}

#[cfg(test)]
mod tests {
    use super::FolderSort;
    use crate::Vault;

    #[test]
    fn m5b_r2_folder_sorts_are_kept_follow_renames_and_are_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault.set_folder_sort("", FolderSort::ModifiedDesc).unwrap();
        vault.set_folder_sort("A/B", FolderSort::NameDesc).unwrap();
        vault.set_folder_sort("C", FolderSort::NameAsc).unwrap();
        let raw = std::fs::read_to_string(dir.path().join(".nimw/vault.json")).unwrap();
        assert!(raw.contains("\"modified-desc\""), "{raw}");
        assert!(!raw.contains("\"C\""), "the default isn't stored: {raw}");
        vault
            .remap_folder_sorts_many(&[("A".into(), "Z".into())])
            .unwrap();
        assert_eq!(
            vault.folder_sorts().into_iter().collect::<Vec<_>>(),
            [
                (String::new(), FolderSort::ModifiedDesc),
                ("Z/B".to_string(), FolderSort::NameDesc)
            ]
        );
        vault.forget_folder_sorts(&["Z".into()]).unwrap();
        assert_eq!(vault.folder_sorts().len(), 1);
    }
}
