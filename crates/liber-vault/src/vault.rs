use crate::config::{
    AttachmentConfig, AttachmentPolicy, LiberAttachments, LiberVaultJson, ObsidianAppJson,
};
use crate::error::{Result, VaultError, io_err};
use crate::is_hidden_name;
use crate::path::VaultPath;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// An open vault folder. Opening reads configuration but never writes (VLT-02).
#[derive(Debug)]
pub struct Vault {
    pub(crate) root: PathBuf,
    pub(crate) excludes: GlobSet,
    warnings: Vec<String>,
    /// Serializes read-modify-write updates of `.liber/*.json` (m11).
    json_lock: Mutex<()>,
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
        crate::meta_dir::migrate(&root, &mut warnings);

        let liber = read_liber_json(&root, &mut warnings);
        // Read once here only to report a broken file; the attachment policy
        // is re-read on every use (M2c §5.3).
        let _: ObsidianAppJson = read_json(&root, OBSIDIAN_JSON, &mut warnings);

        let mut builder = GlobSetBuilder::new();
        for pattern in &liber.exclude {
            match Glob::new(pattern) {
                Ok(g) => {
                    builder.add(g);
                }
                Err(e) => warnings.push(format!(".liber/vault.json: bad exclude {pattern:?}: {e}")),
            }
        }
        let excludes = builder.build().unwrap_or_else(|_| GlobSet::empty());

        Ok(Vault {
            root,
            excludes,
            warnings,
            json_lock: Mutex::new(()),
        })
    }

    /// Canonical absolute root (Windows `\\?\` stripped).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where new attachments go, re-read from disk so a config edit while the
    /// vault is open applies at once (M2c §5.3): `.liber/vault.json` when it
    /// overrides Obsidian (M4b §5), else Obsidian's `attachmentFolderPath`,
    /// then `.liber/vault.json`, then the default.
    pub fn attachment_policy(&self) -> AttachmentPolicy {
        let (liber, obsidian) = self.attachment_sources();
        let overrides = liber.as_ref().is_some_and(|a| a.override_obsidian);
        match liber.and_then(|a| a.policy()) {
            Some(policy) if overrides => policy,
            ours => obsidian
                .map(|(_, policy)| policy)
                .or(ours)
                .unwrap_or_default(),
        }
    }

    /// Liber Linteum's own attachment setting (or the default) and Obsidian's, for the
    /// Settings dialog.
    pub fn attachment_config(&self) -> AttachmentConfig {
        let (liber, obsidian) = self.attachment_sources();
        let override_obsidian = liber.as_ref().is_some_and(|a| a.override_obsidian);
        let (mode, path) = match liber.filter(|a| a.policy().is_some()) {
            Some(a) => (a.mode, a.path),
            None => ("subfolder".to_string(), "attachments".to_string()),
        };
        AttachmentConfig {
            mode,
            path,
            obsidian: obsidian.map(|(value, _)| value),
            override_obsidian,
        }
    }

    /// Stores Liber Linteum's attachment setting in `.liber/vault.json` (created on first
    /// need, VLT-02), keeping every other key. A file that isn't a JSON object
    /// is never overwritten. `override_obsidian`: whether Liber Linteum's place wins
    /// over Obsidian's (M4b §5); `None` keeps what is stored.
    pub fn set_liber_attachments(
        &self,
        mode: &str,
        path: &str,
        override_obsidian: Option<bool>,
    ) -> Result<()> {
        let invalid = |reason: &str| VaultError::InvalidConfig {
            file: LIBER_JSON.to_string(),
            reason: reason.to_string(),
        };
        let path = path.trim().trim_matches('/');
        let stored = match mode {
            "vault" | "same" => "",
            "subfolder" | "folder" => path,
            _ => return Err(invalid(&format!("unknown attachment mode {mode:?}"))),
        };
        let attachments = LiberAttachments {
            mode: mode.to_string(),
            path: stored.to_string(),
            override_obsidian: false,
        };
        if (!stored.is_empty() || matches!(mode, "subfolder" | "folder"))
            && (attachments.policy().is_none() || stored.split('/').any(is_hidden_name))
        {
            return Err(invalid(&format!("invalid attachment folder {path:?}")));
        }
        self.update_json_object(LIBER_JSON, true, |map| {
            let kept = map
                .get("attachments")
                .and_then(|a| a.get("overrideObsidian"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let mut value = serde_json::json!({ "mode": mode, "path": stored });
            let over = override_obsidian.unwrap_or(kept);
            if override_obsidian.is_some() || kept {
                value["overrideObsidian"] = serde_json::Value::Bool(over);
            }
            map.insert("attachments".to_string(), value);
        })
    }

    /// Reads the JSON object at `rel` (under `.liber/`), lets `edit` change it
    /// and writes it back atomically (compare-and-swap), keeping every key
    /// `edit` doesn't touch and adding `"version": 1`. A missing file is
    /// created only when `create` (VLT-02: `.liber/` appears on first need);
    /// a file that isn't a JSON object is never overwritten, and one `edit`
    /// leaves as it was is not rewritten (final review I3: every write is
    /// an fsync).
    ///
    /// Updates are serialized within the process (final review m11: the
    /// IPC threads save layout levels while the watcher remaps them), and a
    /// compare-and-swap lost to another program is retried once: `edit` is
    /// then applied again to what that program wrote.
    pub(crate) fn update_json_object(
        &self,
        rel: &str,
        create: bool,
        mut edit: impl FnMut(&mut serde_json::Map<String, serde_json::Value>),
    ) -> Result<()> {
        let _serialized = self.json_lock.lock().unwrap_or_else(|e| e.into_inner());
        match self.try_update_json_object(rel, create, &mut edit) {
            Err(VaultError::Conflict { .. } | VaultError::AlreadyExists(_)) => {
                self.try_update_json_object(rel, create, &mut edit)
            }
            done => done,
        }
    }

    fn try_update_json_object(
        &self,
        rel: &str,
        create: bool,
        edit: &mut impl FnMut(&mut serde_json::Map<String, serde_json::Value>),
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
        let dir = self.fs_path(&VaultPath::new(".liber")?)?;
        if !dir.is_dir() {
            std::fs::create_dir(&dir).map_err(|e| io_err(".liber", e))?;
        }
        let mut text =
            serde_json::to_string_pretty(&serde_json::Value::Object(map)).expect("valid JSON");
        text.push('\n');
        self.write_cas(&file, text.as_bytes(), expected)?;
        Ok(())
    }

    /// Liber Linteum's stored attachment setting and Obsidian's (value + policy) when
    /// usable. Errors read as "not set": `open` already reported them.
    fn attachment_sources(&self) -> (Option<LiberAttachments>, Option<(String, AttachmentPolicy)>) {
        let mut ignored = Vec::new();
        let liber = read_liber_json(&self.root, &mut ignored);
        let obsidian: ObsidianAppJson = read_json(&self.root, OBSIDIAN_JSON, &mut ignored);
        let obsidian = obsidian.attachment_folder_path.and_then(|value| {
            AttachmentPolicy::from_obsidian(&value).map(|policy| (value, policy))
        });
        (liber.attachments, obsidian)
    }

    /// `indexPicks` from `.liber/vault.json` (folder → page; GV-02), re-read on
    /// every call like the attachment policy. Unreadable: none.
    pub fn index_picks(&self) -> std::collections::HashMap<String, String> {
        let liber = read_liber_json(&self.root, &mut Vec::new());
        liber.index_picks
    }

    /// Picks (`Some`) or clears (`None`) `folder`'s index note in
    /// `.liber/vault.json` (M3b §4), keeping every other key. Clearing a pick
    /// that isn't there writes nothing, and a vault without the file gets one
    /// only for a pick (VLT-02). Picks whose page isn't directly in their
    /// folder (hand-edited) are dropped on the way (final review I4).
    pub fn set_index_pick(&self, folder: &str, page: Option<&str>) -> Result<()> {
        self.update_json_object(LIBER_JSON, page.is_some(), |map| {
            let picks = map
                .entry("indexPicks")
                .or_insert_with(|| serde_json::Value::Object(Default::default()));
            if !picks.is_object() {
                *picks = serde_json::Value::Object(Default::default());
            }
            let picks = picks.as_object_mut().expect("an object");
            match page {
                Some(page) => {
                    picks.insert(folder.to_string(), page.into());
                }
                None => {
                    picks.remove(folder);
                }
            }
            picks.retain(|folder, page| page.as_str().is_none_or(|p| pick_holds(folder, p)));
            if picks.is_empty() {
                map.remove("indexPicks");
            }
        })
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

pub(crate) const LIBER_JSON: &str = ".liber/vault.json";
pub(crate) const OBSIDIAN_JSON: &str = ".obsidian/app.json";

/// True when an index-note pick can hold: `page` sits directly in `folder`
/// (GV-02, M3b §6; final review I4).
pub(crate) fn pick_holds(folder: &str, page: &str) -> bool {
    page.rsplit_once('/')
        .is_some_and(|(parent, _)| parent == folder)
}

/// `.liber/vault.json`, field by field (final review m9).
fn read_liber_json(root: &Path, warnings: &mut Vec<String>) -> LiberVaultJson {
    let value: serde_json::Value = read_json(root, LIBER_JSON, warnings);
    LiberVaultJson::from_value(&value, warnings)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    const LAYOUT: &str = ".liber/layout.json";

    fn vault_with_layout(text: &str) -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".liber")).unwrap();
        std::fs::write(dir.path().join(LAYOUT), text).unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        (dir, vault)
    }

    fn json(dir: &tempfile::TempDir) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.path().join(LAYOUT)).unwrap()).unwrap()
    }

    /// Final review m11: another program writing the file between our read
    /// and our write is a conflict; the update is re-applied once to what
    /// it wrote, so neither change is lost.
    #[test]
    fn m11_an_outside_write_between_read_and_write_is_retried_once() {
        let (dir, vault) = vault_with_layout(r#"{"version":1,"a":1}"#);
        let mut calls = 0;
        vault
            .update_json_object(LAYOUT, false, |map| {
                calls += 1;
                if calls == 1 {
                    std::fs::write(dir.path().join(LAYOUT), r#"{"version":1,"a":2}"#).unwrap();
                }
                map.insert("b".into(), 3.into());
            })
            .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(
            json(&dir),
            serde_json::json!({ "version": 1, "a": 2, "b": 3 })
        );
    }

    /// Only once: a file that keeps changing under us is still an error.
    #[test]
    fn m11_a_second_conflict_is_reported() {
        let (dir, vault) = vault_with_layout(r#"{"version":1}"#);
        let mut calls = 0;
        let result = vault.update_json_object(LAYOUT, false, |map| {
            calls += 1;
            std::fs::write(
                dir.path().join(LAYOUT),
                format!(r#"{{"version":1,"n":{calls}}}"#),
            )
            .unwrap();
            map.insert("b".into(), 3.into());
        });
        assert!(
            matches!(result, Err(VaultError::Conflict { .. })),
            "{result:?}"
        );
        assert_eq!(calls, 2);
    }
}
