use crate::path::VaultPath;
use serde::Deserialize;

/// Where new attachments go (Q-ED-1). Resolved from Obsidian's
/// `attachmentFolderPath` when the vault has it (M2c §5.3: Obsidian wins), else
/// `.nimw/vault.json`, else the default `attachments/` subfolder.
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

/// `.nimw/vault.json` (arch §3.1). Unknown fields are ignored here (and kept
/// when NIMW writes the file, see `Vault::set_nimw_attachments`).
#[derive(Debug, Default, Deserialize)]
pub(crate) struct NimwVaultJson {
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub attachments: Option<NimwAttachments>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct NimwAttachments {
    pub mode: String,
    #[serde(default)]
    pub path: String,
}

impl NimwAttachments {
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

/// NIMW's attachment setting as stored (or the default), plus Obsidian's
/// `attachmentFolderPath` when the vault has a usable one — which then wins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentConfig {
    /// `vault` | `same` | `subfolder` | `folder`.
    pub mode: String,
    pub path: String,
    pub obsidian: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ObsidianAppJson {
    #[serde(rename = "attachmentFolderPath")]
    pub attachment_folder_path: Option<String>,
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
    fn q_ed_1_nimw_attachment_modes() {
        let p = |mode: &str, path: &str| {
            NimwAttachments {
                mode: mode.into(),
                path: path.into(),
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
