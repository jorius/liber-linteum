use crate::config::{AttachmentPolicy, NimwVaultJson, ObsidianAppJson};
use crate::error::{Result, VaultError};
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::{Path, PathBuf};

/// An open vault folder. Opening reads configuration but never writes (VLT-02).
#[derive(Debug)]
pub struct Vault {
    pub(crate) root: PathBuf,
    pub(crate) excludes: GlobSet,
    attachments: AttachmentPolicy,
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

        let nimw: NimwVaultJson = read_json(&root, ".nimw/vault.json", &mut warnings);
        let obsidian: ObsidianAppJson = read_json(&root, ".obsidian/app.json", &mut warnings);

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

        let attachments = nimw
            .attachments
            .as_ref()
            .and_then(|a| a.policy())
            .or_else(|| {
                obsidian
                    .attachment_folder_path
                    .as_deref()
                    .and_then(AttachmentPolicy::from_obsidian)
            })
            .unwrap_or_default();

        Ok(Vault {
            root,
            excludes,
            attachments,
            warnings,
        })
    }

    /// Canonical absolute root (Windows `\\?\` stripped).
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn attachment_policy(&self) -> &AttachmentPolicy {
        &self.attachments
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

fn read_json<T: serde::de::DeserializeOwned + Default>(
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
