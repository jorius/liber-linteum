use crate::config::{
    AttachmentConfig, AttachmentPolicy, NimwAttachments, NimwVaultJson, ObsidianAppJson,
};
use crate::error::{Result, VaultError, io_err};
use crate::is_hidden_name;
use crate::path::VaultPath;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::{Path, PathBuf};

/// An open vault folder. Opening reads configuration but never writes (VLT-02).
#[derive(Debug)]
pub struct Vault {
    pub(crate) root: PathBuf,
    pub(crate) excludes: GlobSet,
    warnings: Vec<String>,
}

impl Vault {
    pub fn open(root: &Path) -> Result<Vault> {
        let root = dunce::canonicalize(root).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::NotFound(root.display().to_string()),
            _ => VaultError::Io {
                path: root.display().to_string(),
                source: e,
            },
        })?;
        if !root.is_dir() {
            return Err(VaultError::NotFound(format!(
                "{} is not a folder",
                root.display()
            )));
        }
        let mut warnings = Vec::new();

        let nimw: NimwVaultJson = read_json(&root, NIMW_JSON, &mut warnings);
        // Read once here only to report a broken file; the attachment policy
        // is re-read on every use (M2c §5.3).
        let _: ObsidianAppJson = read_json(&root, OBSIDIAN_JSON, &mut warnings);

        let mut builder = GlobSetBuilder::new();
        for pattern in &nimw.exclude {
            match Glob::new(pattern) {
                Ok(g) => {
                    builder.add(g);
                }
                Err(e) => warnings.push(format!(".nimw/vault.json: bad exclude {pattern:?}: {e}")),
            }
        }
        let excludes = builder.build().unwrap_or_else(|_| GlobSet::empty());

        Ok(Vault {
            root,
            excludes,
            warnings,
        })
    }

    /// Canonical absolute root (Windows `\\?\` stripped).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where new attachments go, re-read from disk so a config edit while the
    /// vault is open applies at once (M2c §5.3): Obsidian's
    /// `attachmentFolderPath` wins, then `.nimw/vault.json`, then the default.
    pub fn attachment_policy(&self) -> AttachmentPolicy {
        let (nimw, obsidian) = self.attachment_sources();
        obsidian
            .map(|(_, policy)| policy)
            .or_else(|| nimw.and_then(|a| a.policy()))
            .unwrap_or_default()
    }

    /// NIMW's own attachment setting (or the default) and Obsidian's, for the
    /// Settings dialog.
    pub fn attachment_config(&self) -> AttachmentConfig {
        let (nimw, obsidian) = self.attachment_sources();
        let (mode, path) = match nimw.filter(|a| a.policy().is_some()) {
            Some(a) => (a.mode, a.path),
            None => ("subfolder".to_string(), "attachments".to_string()),
        };
        AttachmentConfig {
            mode,
            path,
            obsidian: obsidian.map(|(value, _)| value),
        }
    }

    /// Stores NIMW's attachment setting in `.nimw/vault.json` (created on first
    /// need, VLT-02), keeping every other key. A file that isn't a JSON object
    /// is never overwritten.
    pub fn set_nimw_attachments(&self, mode: &str, path: &str) -> Result<()> {
        let invalid = |reason: &str| VaultError::InvalidConfig {
            file: NIMW_JSON.to_string(),
            reason: reason.to_string(),
        };
        let path = path.trim().trim_matches('/');
        let stored = match mode {
            "vault" | "same" => "",
            "subfolder" | "folder" => path,
            _ => return Err(invalid(&format!("unknown attachment mode {mode:?}"))),
        };
        let attachments = NimwAttachments {
            mode: mode.to_string(),
            path: stored.to_string(),
        };
        if (!stored.is_empty() || matches!(mode, "subfolder" | "folder"))
            && (attachments.policy().is_none() || stored.split('/').any(is_hidden_name))
        {
            return Err(invalid(&format!("invalid attachment folder {path:?}")));
        }
        self.update_json_object(NIMW_JSON, true, |map| {
            map.insert(
                "attachments".to_string(),
                serde_json::json!({ "mode": mode, "path": stored }),
            );
        })
    }

    /// Reads the JSON object at `rel` (under `.nimw/`), lets `edit` change it
    /// and writes it back atomically (compare-and-swap), keeping every key
    /// `edit` doesn't touch and adding `"version": 1`. A missing file is
    /// created only when `create` (VLT-02: `.nimw/` appears on first need);
    /// a file that isn't a JSON object is never overwritten, and one `edit`
    /// leaves as it was is not rewritten (final review I3: every write is
    /// an fsync).
    pub(crate) fn update_json_object(
        &self,
        rel: &str,
        create: bool,
        edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
    ) -> Result<()> {
        let file = VaultPath::new(rel)?;
        let (mut map, expected) = match self.read(&file) {
            Ok((bytes, hash)) => match serde_json::from_slice(&bytes) {
                Ok(serde_json::Value::Object(map)) => (map, Some(hash)),
                _ => {
                    return Err(VaultError::InvalidConfig {
                        file: rel.to_string(),
                        reason: "not a JSON object; fix or remove it first".to_string(),
                    });
                }
            },
            Err(VaultError::NotFound(_)) if create => (serde_json::Map::new(), None),
            Err(VaultError::NotFound(_)) => return Ok(()),
            Err(e) => return Err(e),
        };
        let before = expected.map(|_| map.clone());
        edit(&mut map);
        if before.as_ref() == Some(&map) {
            return Ok(());
        }
        map.entry("version").or_insert(1.into());
        let dir = self.fs_path(&VaultPath::new(".nimw")?)?;
        if !dir.is_dir() {
            std::fs::create_dir(&dir).map_err(|e| io_err(".nimw", e))?;
        }
        let mut text =
            serde_json::to_string_pretty(&serde_json::Value::Object(map)).expect("valid JSON");
        text.push('\n');
        self.write_cas(&file, text.as_bytes(), expected)?;
        Ok(())
    }

    /// NIMW's stored attachment setting and Obsidian's (value + policy) when
    /// usable. Errors read as "not set": `open` already reported them.
    fn attachment_sources(&self) -> (Option<NimwAttachments>, Option<(String, AttachmentPolicy)>) {
        let mut ignored = Vec::new();
        let nimw: NimwVaultJson = read_json(&self.root, NIMW_JSON, &mut ignored);
        let obsidian: ObsidianAppJson = read_json(&self.root, OBSIDIAN_JSON, &mut ignored);
        let obsidian = obsidian.attachment_folder_path.and_then(|value| {
            AttachmentPolicy::from_obsidian(&value).map(|policy| (value, policy))
        });
        (nimw.attachments, obsidian)
    }

    /// `indexPicks` from `.nimw/vault.json` (folder → page; GV-02), re-read on
    /// every call like the attachment policy. Unreadable: none.
    pub fn index_picks(&self) -> std::collections::HashMap<String, String> {
        let nimw: NimwVaultJson = read_json(&self.root, NIMW_JSON, &mut Vec::new());
        nimw.index_picks
    }

    /// Non-fatal configuration problems found while opening.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// True when a vault-relative path matches a user exclude glob.
    pub fn is_excluded(&self, rel: &str) -> bool {
        self.excludes.is_match(rel)
    }
}

pub(crate) const NIMW_JSON: &str = ".nimw/vault.json";
const OBSIDIAN_JSON: &str = ".obsidian/app.json";

pub(crate) fn read_json<T: serde::de::DeserializeOwned + Default>(
    root: &Path,
    rel: &str,
    warnings: &mut Vec<String>,
) -> T {
    let path = root.join(rel);
    let Ok(bytes) = std::fs::read(&path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(
                VaultError::InvalidConfig {
                    file: rel.to_string(),
                    reason: e.to_string(),
                }
                .to_string(),
            );
            T::default()
        }
    }
}
