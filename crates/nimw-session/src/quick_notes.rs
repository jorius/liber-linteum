//! Quick notes (M4c §2, §7): created in a scratch folder (the global
//! Scratchpad's root, or a vault's `scratchpadFolder`) and named after their
//! first line until the user renames them. The flag lives in
//! `.nimw/vault.json` `autoNamed`; any rename other than ours drops it.

use crate::attachments::sanitize_file_name;
use crate::session::validate_name;
use crate::{RenameOutcome, Result, SessionError, SessionEvent, VaultSession};
use nimw_markdown::first_line_text;
use nimw_vault::{EntryKind, VaultError, VaultPath};
use std::collections::HashSet;

/// Longest name taken from a first line, in characters.
pub const MAX_QUICK_NAME: usize = 60;

/// What [`VaultSession::auto_name`] did.
#[derive(Debug)]
pub struct AutoName {
    /// Where the note is now.
    pub path: VaultPath,
    /// The rename, when there was one.
    pub renamed: Option<RenameOutcome>,
    /// Still named after its first line.
    pub auto_named: bool,
}

/// The file name (without `.md`) a note's text gives it: its first line's
/// visible text, refused characters as `-`, at most 60 characters. `None`
/// when nothing usable is left, or for a Windows device name.
pub fn quick_note_stem(text: &str) -> Option<String> {
    let line = first_line_text(text)?;
    let clean = sanitize_file_name(&line);
    let cut: String = clean.chars().take(MAX_QUICK_NAME).collect();
    let stem = cut.trim_end().to_string();
    let usable = stem.chars().any(|c| c != '-' && !c.is_whitespace());
    (usable && !device_name(&stem)).then_some(stem)
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (with any
/// extension): Windows can't hold a file of that name.
fn device_name(stem: &str) -> bool {
    let base = stem
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let numbered = |prefix: &str| {
        base.len() == 4 && base.starts_with(prefix) && matches!(base.as_bytes()[3], b'1'..=b'9')
    };
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT")
}

/// `name` (or `name 1`, `name 2`…) + `.md`, the first not in `taken`
/// (lower-case names).
fn free_name(stem: &str, taken: &HashSet<String>) -> String {
    (0..)
        .map(|i| {
            if i == 0 {
                format!("{stem}.md")
            } else {
                format!("{stem} {i}.md")
            }
        })
        .find(|name| !taken.contains(&name.to_lowercase()))
        .expect("a free name")
}

impl VaultSession {
    /// A new empty quick note in `dir` (created with its parents when
    /// missing): `base.md`, else `base 1.md`, `base 2.md`…; flagged as
    /// named after its first line. A flag that can't be saved is reported,
    /// and the note stays.
    pub fn create_quick_note(&self, dir: &VaultPath, base: &str) -> Result<VaultPath> {
        let base = validate_name(base)?.to_string();
        self.ensure_folder(dir)?;
        let mut i = 0usize;
        let path = loop {
            let name = if i == 0 {
                base.clone()
            } else {
                format!("{base} {i}")
            };
            match self.create_page(dir, &name) {
                Err(SessionError::Vault(VaultError::AlreadyExists(_))) => i += 1,
                other => break other?,
            }
        };
        if let Err(e) = self.vault.set_auto_named(path.as_str(), true) {
            self.emit(SessionEvent::Warning(format!(
                "{path} won't be named after its first line: {e}"
            )));
        }
        Ok(path)
    }

    /// Renames a flagged note after its saved first line (same folder,
    /// numbered when taken, the note itself not counting). Unflagged notes,
    /// a first line with nothing usable, or a name that differs only in
    /// letter case leave it as it is.
    pub fn auto_name(&self, path: &VaultPath, rewrite_links: bool) -> Result<AutoName> {
        let unchanged = |auto_named| AutoName {
            path: path.clone(),
            renamed: None,
            auto_named,
        };
        if !self.vault.auto_named().contains(path.as_str()) {
            return Ok(unchanged(false));
        }
        let (bytes, _) = self.vault.read(path)?;
        let Some(stem) = quick_note_stem(&String::from_utf8_lossy(&bytes)) else {
            return Ok(unchanged(true));
        };
        let dir = path.parent().unwrap_or_else(VaultPath::root);
        let own = path.file_name().to_lowercase();
        let taken: HashSet<String> = self
            .index()
            .stats()?
            .into_keys()
            .filter_map(|p| VaultPath::new(&p).ok())
            .filter(|p| p.parent().unwrap_or_else(VaultPath::root) == dir)
            .map(|p| p.file_name().to_lowercase())
            .filter(|name| *name != own)
            .collect();
        let name = free_name(&stem, &taken);
        if name.to_lowercase() == own {
            return Ok(unchanged(true));
        }
        let to = dir.join(&name)?;
        let outcome = self.rename(path, &to, rewrite_links)?;
        // The rename dropped the flag with the old path; ours keeps it.
        if let Err(e) = self.vault.set_auto_named(to.as_str(), true) {
            self.emit(SessionEvent::Warning(format!(
                "{to} won't be named after its first line any more: {e}"
            )));
        }
        Ok(AutoName {
            path: to,
            renamed: Some(outcome),
            auto_named: true,
        })
    }

    /// Names the vault's scratch folder (Settings → This vault). When the
    /// current folder exists and `name` is free, the folder is renamed on
    /// disk (links rewritten as `rewrite_links` says) and the outcome
    /// returned; an existing folder named `name` is adopted. A file of that
    /// name is `AlreadyExists`; a hidden name or a refused character is
    /// `InvalidName`.
    pub fn set_scratch_folder(
        &self,
        name: &str,
        rewrite_links: bool,
    ) -> Result<Option<RenameOutcome>> {
        let valid = validate_name(name)?;
        if valid != name {
            return Err(SessionError::InvalidName(name.to_string()));
        }
        let target = VaultPath::new(name)?;
        let current = self.vault.scratch_folder();
        let mut outcome = None;
        if current != name {
            match self.vault.stat(&target)?.map(|e| e.kind) {
                Some(EntryKind::Dir) => {}
                Some(_) => return Err(VaultError::AlreadyExists(name.to_string()).into()),
                None => {
                    let from = VaultPath::new(&current)?;
                    if matches!(
                        self.vault.stat(&from)?.map(|e| e.kind),
                        Some(EntryKind::Dir)
                    ) {
                        outcome = Some(self.rename(&from, &target, rewrite_links)?);
                    }
                }
            }
        }
        self.vault.set_scratch_folder(name)?;
        Ok(outcome)
    }

    /// Creates `dir` and its missing parents as indexed folders.
    fn ensure_folder(&self, dir: &VaultPath) -> Result<()> {
        if dir.is_root() || self.vault.stat(dir)?.is_some() {
            return Ok(());
        }
        let parent = dir.parent().unwrap_or_else(VaultPath::root);
        self.ensure_folder(&parent)?;
        self.create_folder(&parent, dir.file_name())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::VaultSession;
    use nimw_vault::VaultPath;

    struct Fixture {
        _vault: tempfile::TempDir,
        _cache: tempfile::TempDir,
        root: std::path::PathBuf,
        s: VaultSession,
    }

    fn open(files: &[(&str, &str)]) -> Fixture {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().to_path_buf();
        for (path, text) in files {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_| {}).unwrap();
        Fixture {
            _vault: vault,
            _cache: cache,
            root,
            s,
        }
    }

    /// What the watcher would report for files written behind the session.
    fn changed(f: &Fixture, paths: &[VaultPath]) {
        f.s.apply(
            paths
                .iter()
                .cloned()
                .map(nimw_vault::WatchEvent::Changed)
                .collect(),
        )
        .unwrap();
    }

    fn vp(s: &str) -> VaultPath {
        VaultPath::new(s).unwrap()
    }

    fn flagged(f: &Fixture) -> Vec<String> {
        f.s.vault().auto_named().into_iter().collect()
    }

    #[test]
    fn m4c_quick_notes_are_deduplicated_and_flagged() {
        let f = open(&[]);
        let a = f.s.create_quick_note(&VaultPath::root(), "Q").unwrap();
        let b = f.s.create_quick_note(&VaultPath::root(), "Q").unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("Q.md", "Q 1.md"));
        assert_eq!(flagged(&f), ["Q 1.md", "Q.md"]);
        assert_eq!(std::fs::read_to_string(f.root.join("Q.md")).unwrap(), "");
    }

    #[test]
    fn m4c_a_vault_scratch_folder_is_created_on_first_use() {
        let f = open(&[("Notes/a.md", "# a")]);
        assert!(!f.root.join("Scratchpad").exists());
        let note = f.s.create_quick_note(&vp("Scratchpad"), "Q").unwrap();
        assert_eq!(note.as_str(), "Scratchpad/Q.md");
        assert!(f.root.join("Scratchpad/Q.md").is_file());
        let tree: Vec<String> = f.s.tree().unwrap().into_iter().map(|n| n.path).collect();
        assert!(tree.contains(&"Scratchpad".to_string()), "{tree:?}");
        assert!(tree.contains(&"Scratchpad/Q.md".to_string()), "{tree:?}");
    }

    #[test]
    fn m4c_auto_name_follows_the_first_line() {
        let f = open(&[]);
        let q = f.s.create_quick_note(&vp("Scratchpad"), "Q").unwrap();
        std::fs::write(f.root.join("Scratchpad/Q.md"), "# Groceries\nmilk").unwrap();
        changed(&f, std::slice::from_ref(&q));
        let out = f.s.auto_name(&q, true).unwrap();
        assert_eq!(out.path.as_str(), "Scratchpad/Groceries.md");
        assert!(out.renamed.is_some());
        assert!(out.auto_named);
        assert_eq!(flagged(&f), ["Scratchpad/Groceries.md"]);
        assert!(f.root.join("Scratchpad/Groceries.md").is_file());
        // Typing on: it follows the first line again.
        std::fs::write(
            f.root.join("Scratchpad/Groceries.md"),
            "# Groceries for Sunday",
        )
        .unwrap();
        changed(&f, std::slice::from_ref(&out.path));
        let again = f.s.auto_name(&out.path, true).unwrap();
        assert_eq!(again.path.as_str(), "Scratchpad/Groceries for Sunday.md");
    }

    #[test]
    fn m4c_same_first_line_gets_a_number_and_does_not_ping_pong() {
        let f = open(&[]);
        let a = f.s.create_quick_note(&VaultPath::root(), "A").unwrap();
        let b = f.s.create_quick_note(&VaultPath::root(), "B").unwrap();
        for p in ["A.md", "B.md"] {
            std::fs::write(f.root.join(p), "Idea").unwrap();
        }
        changed(&f, &[a.clone(), b.clone()]);
        let a = f.s.auto_name(&a, true).unwrap().path;
        let b = f.s.auto_name(&b, true).unwrap().path;
        assert_eq!((a.as_str(), b.as_str()), ("Idea.md", "Idea 1.md"));
        let again = f.s.auto_name(&b, true).unwrap();
        assert_eq!(again.path.as_str(), "Idea 1.md");
        assert!(again.renamed.is_none());
        assert!(again.auto_named);
        // Differing only in letter case: left as it is.
        std::fs::write(f.root.join("Idea.md"), "IDEA").unwrap();
        changed(&f, std::slice::from_ref(&a));
        let same = f.s.auto_name(&a, true).unwrap();
        assert_eq!(same.path.as_str(), "Idea.md");
        assert!(same.renamed.is_none());
    }

    #[test]
    fn m4c_nothing_usable_keeps_the_generated_name() {
        let f = open(&[]);
        let q = f.s.create_quick_note(&VaultPath::root(), "Q").unwrap();
        for text in ["", "# ", "CON", "![[x.png]]", "///", "\n\n  \n"] {
            std::fs::write(f.root.join("Q.md"), text).unwrap();
            changed(&f, std::slice::from_ref(&q));
            let out = f.s.auto_name(&q, true).unwrap();
            assert_eq!(out.path.as_str(), "Q.md", "{text:?}");
            assert!(out.renamed.is_none() && out.auto_named, "{text:?}");
        }
    }

    #[test]
    fn m4c_unflagged_notes_are_never_renamed() {
        let f = open(&[("Plain.md", "# Something else")]);
        let out = f.s.auto_name(&vp("Plain.md"), true).unwrap();
        assert_eq!(out.path.as_str(), "Plain.md");
        assert!(out.renamed.is_none());
        assert!(!out.auto_named);
        assert!(f.root.join("Plain.md").is_file());
    }

    #[test]
    fn m4c_a_manual_rename_or_delete_drops_the_flag() {
        let f = open(&[]);
        let q = f.s.create_quick_note(&VaultPath::root(), "Q").unwrap();
        let r = f.s.create_quick_note(&VaultPath::root(), "R").unwrap();
        f.s.rename(&q, &vp("Mine.md"), true).unwrap();
        assert_eq!(flagged(&f), ["R.md"]);
        let remove = |p: &VaultPath| {
            std::fs::remove_file(f.root.join(p.as_str())).map_err(|source| {
                nimw_vault::VaultError::Io {
                    path: p.to_string(),
                    source,
                }
            })
        };
        f.s.trash_via(&r, &|| {}, &remove).unwrap();
        assert!(flagged(&f).is_empty());
    }

    #[test]
    fn m4c_renaming_the_scratch_folder_from_settings() {
        let f = open(&[
            ("Links.md", "See [[Scratchpad/Trip]]."),
            ("Scratchpad/Trip.md", "x"),
        ]);
        let out = f.s.set_scratch_folder("Inbox", true).unwrap();
        assert!(out.is_some());
        assert!(f.root.join("Inbox/Trip.md").is_file());
        assert_eq!(f.s.vault().scratch_folder(), "Inbox");
        assert_eq!(
            std::fs::read_to_string(f.root.join("Links.md")).unwrap(),
            "See [[Trip]]."
        );
        // An existing folder of that name is adopted; nothing moves.
        std::fs::create_dir(f.root.join("Taken")).unwrap();
        changed(&f, &[vp("Taken")]);
        assert!(f.s.set_scratch_folder("Taken", true).unwrap().is_none());
        assert!(f.root.join("Inbox/Trip.md").is_file());
        assert_eq!(f.s.vault().scratch_folder(), "Taken");
        // A file of that name, a hidden name, a refused character: refused.
        std::fs::write(f.root.join("Plain"), "x").unwrap();
        changed(&f, &[vp("Plain")]);
        assert!(f.s.set_scratch_folder("Plain", true).is_err());
        for bad in [".nimw", "a/b", "Q#1", "  "] {
            assert!(
                matches!(
                    f.s.set_scratch_folder(bad, true),
                    Err(crate::SessionError::InvalidName(_))
                ),
                "{bad}"
            );
        }
        assert_eq!(f.s.vault().scratch_folder(), "Taken");
        // The adopted folder exists, so a new name renames it.
        assert!(f.s.set_scratch_folder("Later", true).unwrap().is_some());
        assert!(f.root.join("Later").is_dir() && !f.root.join("Taken").exists());
        // No folder yet: only the name is stored.
        let fresh = open(&[]);
        assert!(fresh.s.set_scratch_folder("Later", true).unwrap().is_none());
        assert!(!fresh.root.join("Later").exists());
        assert_eq!(fresh.s.vault().scratch_folder(), "Later");
    }

    #[test]
    fn m4c_stem_rules() {
        assert_eq!(quick_note_stem("a/b: c?").as_deref(), Some("a-b- c-"));
        assert_eq!(quick_note_stem(".hidden").as_deref(), Some("-hidden"));
        assert_eq!(
            quick_note_stem(&"x".repeat(80)).map(|s| s.chars().count()),
            Some(MAX_QUICK_NAME)
        );
        assert_eq!(
            quick_note_stem(&format!("{} tail", "word ".repeat(12))).as_deref(),
            Some("word word word word word word word word word word word word")
        );
        assert_eq!(
            quick_note_stem("ñandú ".repeat(20).as_str()).map(|s| s.chars().count()),
            Some(59)
        );
        assert_eq!(quick_note_stem("com3"), None);
        assert_eq!(quick_note_stem("Lpt1.txt"), None);
        assert_eq!(quick_note_stem("|||"), None);
        assert_eq!(quick_note_stem("# Console"), Some("Console".to_string()));
    }
}
