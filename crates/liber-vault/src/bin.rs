//! Records of the vault's Trash and Archive (M5b §5): where each item came
//! from and when it went, in `.liber/trash.json` and `.liber/archive.json`
//! (`{"items": {"<path now>": {"from": "<path before>", "at": <ms>}}}`), so
//! notes are never written.

use crate::Result;
use crate::vault::{Vault, read_json};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Which bin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bin {
    Trash,
    Archive,
}

impl Bin {
    fn file(self) -> &'static str {
        match self {
            Bin::Trash => ".liber/trash.json",
            Bin::Archive => ".liber/archive.json",
        }
    }
}

/// Where an item was before it went into a bin, and when (ms since epoch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinRecord {
    pub from: String,
    pub at: u64,
}

impl Vault {
    /// The bin's records by the item's path now; malformed entries are left out.
    pub fn bin_records(&self, bin: Bin) -> BTreeMap<String, BinRecord> {
        let value: Value = read_json(self.storage(), bin.file(), &mut Vec::new());
        let Some(items) = value.get("items").and_then(Value::as_object) else {
            return BTreeMap::new();
        };
        items
            .iter()
            .filter_map(|(path, v)| {
                Some((
                    path.clone(),
                    BinRecord {
                        from: v.get("from")?.as_str()?.to_string(),
                        at: v.get("at").and_then(Value::as_u64).unwrap_or(0),
                    },
                ))
            })
            .collect()
    }

    /// Records (`Some`) or forgets (`None`) the item now at `path`.
    pub fn set_bin_record(&self, bin: Bin, path: &str, record: Option<&BinRecord>) -> Result<()> {
        self.update_json_object(bin.file(), record.is_some(), |map| {
            let items = map
                .entry("items")
                .or_insert_with(|| json!({}))
                .as_object_mut();
            let Some(items) = items else { return };
            match record {
                Some(r) => {
                    items.insert(path.to_string(), json!({ "from": r.from, "at": r.at }));
                }
                None => {
                    items.remove(path);
                }
            }
        })
    }

    /// Forgets several records in one write (none when none is there).
    pub fn forget_bin_records(&self, bin: Bin, paths: &[String]) -> Result<()> {
        self.update_json_object(bin.file(), false, |map| {
            if let Some(items) = map.get_mut("items").and_then(Value::as_object_mut) {
                for p in paths {
                    items.remove(p);
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip_and_keep_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert!(vault.bin_records(Bin::Trash).is_empty());
        let r = BinRecord {
            from: "P/a.md".into(),
            at: 7,
        };
        vault
            .set_bin_record(Bin::Trash, ".trash/a.md", Some(&r))
            .unwrap();
        vault
            .set_bin_record(Bin::Trash, ".trash/b.md", Some(&r))
            .unwrap();
        vault
            .set_bin_record(Bin::Trash, ".trash/a.md", None)
            .unwrap();
        let got = vault.bin_records(Bin::Trash);
        assert_eq!(got.keys().collect::<Vec<_>>(), [".trash/b.md"]);
        assert_eq!(got[".trash/b.md"], r);
        assert!(vault.bin_records(Bin::Archive).is_empty());
        // Forgetting with no file writes nothing.
        vault
            .set_bin_record(Bin::Archive, ".archive/x.md", None)
            .unwrap();
        assert!(!dir.path().join(".liber/archive.json").exists());
    }
}
