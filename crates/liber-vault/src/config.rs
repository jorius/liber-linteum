use crate::path::VaultPath;
use crate::vault::LIBER_JSON;
use serde::Deserialize;
use serde_json::Value;

/// Where new attachments go (Q-ED-1). Resolved from `.liber/vault.json` when it
/// says to override Obsidian (M4b §5), else Obsidian's `attachmentFolderPath`
/// when the vault has it (M2c §5.3), else `.liber/vault.json`, else the default
/// `attachments/` subfolder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentPolicy {
    /// Vault root.
    VaultRoot,
    /// One fixed folder in the vault.
    Folder(VaultPath),
    /// Same folder as the note.
    SameAsNote,
    /// A subfolder with this name next to the note.
    Subfolder(String),
}

impl Default for AttachmentPolicy {
    fn default() -> Self {
        AttachmentPolicy::Subfolder("attachments".to_string())
    }
}

impl AttachmentPolicy {
    /// The folder new attachments of `page` go to.
    pub fn dir_for(&self, page: &VaultPath) -> crate::Result<VaultPath> {
        let here = page.parent().unwrap_or_else(VaultPath::root);
        match self {
            AttachmentPolicy::VaultRoot => Ok(VaultPath::root()),
            AttachmentPolicy::Folder(folder) => Ok(folder.clone()),
            AttachmentPolicy::SameAsNote => Ok(here),
            AttachmentPolicy::Subfolder(sub) => here.join(sub),
        }
    }

    /// Obsidian `attachmentFolderPath`: `/` root, `./` same folder, `./x` subfolder, `x` folder.
    pub(crate) fn from_obsidian(value: &str) -> Option<AttachmentPolicy> {
        let v = value.trim();
        if v == "/" || v.is_empty() {
            Some(AttachmentPolicy::VaultRoot)
        } else if v == "./" || v == "." {
            Some(AttachmentPolicy::SameAsNote)
        } else if let Some(sub) = v.strip_prefix("./") {
            let sub = sub.trim_end_matches('/');
            VaultPath::new(sub).ok()?;
            Some(AttachmentPolicy::Subfolder(sub.to_string()))
        } else {
            let folder = v.trim_matches('/');
            VaultPath::new(folder).ok().map(AttachmentPolicy::Folder)
        }
    }
}

/// `.liber/vault.json` (arch §3.1). Unknown fields are ignored here (and kept
/// when Liber Linteum writes the file, see `Vault::set_liber_attachments`).
#[derive(Debug, Default)]
pub(crate) struct LiberVaultJson {
    pub exclude: Vec<String>,
    pub attachments: Option<LiberAttachments>,
    /// Folder → the page picked as its card preview (GV-02, picked in M3b).
    pub index_picks: std::collections::HashMap<String, String>,
}

impl LiberVaultJson {
    /// Reads each field on its own (final review m9): a malformed or
    /// future-shaped field — or one bad item of `exclude` or `indexPicks` —
    /// is reported and ignored, and never takes the other fields with it.
    /// Above all `exclude`, which keeps private folders out of the index.
    pub(crate) fn from_value(value: &Value, warnings: &mut Vec<String>) -> LiberVaultJson {
        let mut warn = |what: String| warnings.push(format!("{LIBER_JSON}: {what}"));
        let mut out = LiberVaultJson::default();
        let Some(map) = value.as_object() else {
            if !value.is_null() {
                warn("not a JSON object".to_string());
            }
            return out;
        };
        match map.get("exclude") {
            None | Some(Value::Null) => {}
            Some(Value::String(glob)) => out.exclude.push(glob.clone()),
            Some(Value::Array(globs)) => {
                for glob in globs {
                    match glob.as_str() {
                        Some(glob) => out.exclude.push(glob.to_string()),
                        None => warn(format!("bad exclude {glob}: not a glob")),
                    }
                }
            }
            Some(other) => warn(format!("exclude ignored: {other} is not a list of globs")),
        }
        match map.get("attachments") {
            None | Some(Value::Null) => {}
            Some(value) => match LiberAttachments::deserialize(value) {
                Ok(attachments) => out.attachments = Some(attachments),
                Err(e) => warn(format!("attachments ignored: {e}")),
            },
        }
        match map.get("indexPicks") {
            None | Some(Value::Null) => {}
            Some(Value::Object(picks)) => {
                for (folder, page) in picks {
                    match page.as_str() {
                        Some(page) => {
                            out.index_picks.insert(folder.clone(), page.to_string());
                        }
                        None => warn(format!("indexPicks {folder:?} ignored: not a page path")),
                    }
                }
            }
            Some(other) => warn(format!("indexPicks ignored: {other} is not an object")),
        }
        out
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct LiberAttachments {
    pub mode: String,
    #[serde(default)]
    pub path: String,
    /// Liber Linteum's place wins over Obsidian's `attachmentFolderPath` (M4b §5).
    #[serde(default, rename = "overrideObsidian")]
    pub override_obsidian: bool,
}

impl LiberAttachments {
    pub(crate) fn policy(&self) -> Option<AttachmentPolicy> {
        match self.mode.as_str() {
            "vault" if self.path.trim_matches('/').is_empty() => Some(AttachmentPolicy::VaultRoot),
            "vault" => VaultPath::new(self.path.trim_matches('/'))
                .ok()
                .map(AttachmentPolicy::Folder),
            "folder" => VaultPath::new(self.path.trim_matches('/'))
                .ok()
                .map(AttachmentPolicy::Folder),
            "same" => Some(AttachmentPolicy::SameAsNote),
            "subfolder" => {
                let sub = self.path.trim_matches('/');
                let sub = if sub.is_empty() { "attachments" } else { sub };
                VaultPath::new(sub).ok()?;
                Some(AttachmentPolicy::Subfolder(sub.to_string()))
            }
            _ => None,
        }
    }
}

/// Liber Linteum's attachment setting as stored (or the default), plus Obsidian's
/// `attachmentFolderPath` when the vault has a usable one — which then wins,
/// unless Liber Linteum's says to override it (M4b §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentConfig {
    /// `vault` | `same` | `subfolder` | `folder`.
    pub mode: String,
    pub path: String,
    pub obsidian: Option<String>,
    pub override_obsidian: bool,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ObsidianAppJson {
    #[serde(rename = "attachmentFolderPath")]
    pub attachment_folder_path: Option<String>,
    /// `shortest` | `relative` | `absolute` (M4b part 3 §8).
    #[serde(rename = "newLinkFormat")]
    pub new_link_format: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q_ed_1_obsidian_attachment_folder_path_forms() {
        use AttachmentPolicy::*;
        assert_eq!(AttachmentPolicy::from_obsidian("/"), Some(VaultRoot));
        assert_eq!(AttachmentPolicy::from_obsidian("./"), Some(SameAsNote));
        assert_eq!(
            AttachmentPolicy::from_obsidian("./assets"),
            Some(Subfolder("assets".into()))
        );
        assert_eq!(
            AttachmentPolicy::from_obsidian("Media/Img"),
            Some(Folder(VaultPath::new("Media/Img").unwrap()))
        );
        assert_eq!(AttachmentPolicy::from_obsidian("../outside"), None);
        assert_eq!(AttachmentPolicy::default(), Subfolder("attachments".into()));
    }

    #[test]
    fn q_ed_1_liber_attachment_modes() {
        let p = |mode: &str, path: &str| {
            LiberAttachments {
                mode: mode.into(),
                path: path.into(),
                override_obsidian: false,
            }
            .policy()
        };
        assert_eq!(p("vault", ""), Some(AttachmentPolicy::VaultRoot));
        assert_eq!(
            p("vault", "Files"),
            Some(AttachmentPolicy::Folder(VaultPath::new("Files").unwrap()))
        );
        assert_eq!(p("same", ""), Some(AttachmentPolicy::SameAsNote));
        assert_eq!(
            p("subfolder", ""),
            Some(AttachmentPolicy::Subfolder("attachments".into()))
        );
        assert_eq!(p("weird", "x"), None);
    }
}
