//! How links to new attachments are written (M4b part 3 §8): Liber Linteum's own
//! choice in `.liber/vault.json` (`attachmentLinkFormat`), else Obsidian's
//! `newLinkFormat` in `.obsidian/app.json`, else the shortest name. Obsidian's
//! file is only read.

use crate::Result;
use crate::config::ObsidianAppJson;
use crate::vault::{LIBER_JSON, OBSIDIAN_JSON, Vault, read_json};
use serde::{Deserialize, Serialize};

/// The text written between `![[` and `]]` (or the `file:` URL) for a new
/// attachment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkFormat {
    /// `![[x.png]]`: the shortest name that still finds the file.
    Shortest,
    /// `![[Assets/Comisiones/x.png]]`: the full path in the vault.
    Vault,
    /// `![[../Assets/x.png]]`: relative to the note's folder.
    Relative,
    /// `![](file:///D:/Mind_PC/Assets/x.png)`: the absolute path on disk.
    Absolute,
}

impl LinkFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkFormat::Shortest => "shortest",
            LinkFormat::Vault => "vault",
            LinkFormat::Relative => "relative",
            LinkFormat::Absolute => "absolute",
        }
    }

    pub fn parse(value: &str) -> Option<LinkFormat> {
        Some(match value {
            "shortest" => LinkFormat::Shortest,
            "vault" => LinkFormat::Vault,
            "relative" => LinkFormat::Relative,
            "absolute" => LinkFormat::Absolute,
            _ => return None,
        })
    }

    /// Obsidian's `newLinkFormat`: its `absolute` is the full vault path.
    fn from_obsidian(value: &str) -> Option<LinkFormat> {
        Some(match value {
            "shortest" => LinkFormat::Shortest,
            "absolute" => LinkFormat::Vault,
            "relative" => LinkFormat::Relative,
            _ => return None,
        })
    }
}

/// Liber Linteum's own choice and Obsidian's, as stored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LinkFormats {
    pub own: Option<LinkFormat>,
    pub obsidian: Option<LinkFormat>,
}

impl LinkFormats {
    /// What new attachments use.
    pub fn effective(self) -> LinkFormat {
        self.own.or(self.obsidian).unwrap_or(LinkFormat::Shortest)
    }
}

const KEY: &str = "attachmentLinkFormat";

impl Vault {
    /// Both settings, re-read on every call; unreadable ones count as unset.
    pub fn link_formats(&self) -> LinkFormats {
        let liber: serde_json::Value = read_json(self.storage(), LIBER_JSON, &mut Vec::new());
        let obsidian: ObsidianAppJson = read_json(self.storage(), OBSIDIAN_JSON, &mut Vec::new());
        LinkFormats {
            own: liber
                .get(KEY)
                .and_then(serde_json::Value::as_str)
                .and_then(LinkFormat::parse),
            obsidian: obsidian
                .new_link_format
                .as_deref()
                .and_then(LinkFormat::from_obsidian),
        }
    }

    /// Sets (`Some`) or clears (`None`) Liber Linteum's own format, keeping every other
    /// key; clearing what isn't set writes nothing (VLT-02).
    pub fn set_link_format(&self, format: Option<LinkFormat>) -> Result<()> {
        self.update_json_object(LIBER_JSON, format.is_some(), |map| match format {
            Some(f) => {
                map.insert(KEY.to_string(), f.as_str().into());
            }
            None => {
                map.remove(KEY);
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(obsidian: Option<&str>) -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        if let Some(app) = obsidian {
            std::fs::create_dir(dir.path().join(".obsidian")).unwrap();
            std::fs::write(dir.path().join(".obsidian/app.json"), app).unwrap();
        }
        let v = Vault::open(dir.path()).unwrap();
        (dir, v)
    }

    #[test]
    fn shortest_by_default_and_nothing_written_to_clear() {
        let (dir, v) = vault(None);
        assert_eq!(v.link_formats(), LinkFormats::default());
        assert_eq!(v.link_formats().effective(), LinkFormat::Shortest);
        v.set_link_format(None).unwrap();
        assert!(!dir.path().join(".liber").exists(), "VLT-02");
    }

    #[test]
    fn obsidians_new_link_format_applies_until_liber_has_its_own() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let (dir, v) = vault(Some(r#"{ "newLinkFormat": "absolute", "x": 1 }"#));
        assert_eq!(v.link_formats().obsidian, Some(LinkFormat::Vault));
        assert_eq!(v.link_formats().effective(), LinkFormat::Vault);
        v.set_link_format(Some(LinkFormat::Absolute)).unwrap();
        assert_eq!(v.link_formats().effective(), LinkFormat::Absolute);
        v.set_link_format(None).unwrap();
        assert_eq!(v.link_formats().effective(), LinkFormat::Vault);
        // Obsidian's file is only read.
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".obsidian/app.json")).unwrap(),
            r#"{ "newLinkFormat": "absolute", "x": 1 }"#
        );
    }

    #[test]
    fn the_setting_keeps_other_keys_and_ignores_unknown_values() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let (dir, v) = vault(Some(r#"{ "newLinkFormat": "weird" }"#));
        std::fs::create_dir(dir.path().join(".liber")).unwrap();
        std::fs::write(
            dir.path().join(".liber/vault.json"),
            r#"{ "exclude": ["Private"], "attachmentLinkFormat": "nonsense" }"#,
        )
        .unwrap();
        assert_eq!(v.link_formats(), LinkFormats::default());
        v.set_link_format(Some(LinkFormat::Relative)).unwrap();
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join(".liber/vault.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(json["attachmentLinkFormat"], "relative");
        assert_eq!(json["exclude"][0], "Private");
        assert_eq!(LinkFormat::parse("vault"), Some(LinkFormat::Vault));
        assert_eq!(LinkFormat::parse("default"), None);
    }
}
