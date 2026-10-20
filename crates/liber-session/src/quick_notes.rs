//! Quick notes (M4c §2, §7): created in a scratch folder (the global
//! Scratchpad's root, or a vault's `scratchpadFolder`) and named after their
//! first line until the user renames them. The flag lives in
//! `.liber/vault.json` `autoNamed`; any rename other than ours drops it.

use crate::attachments::sanitize_file_name;
use crate::session::validate_name;
use crate::{RenameOutcome, Result, SessionError, SessionEvent, VaultSession};
use liber_index::FileKind;
use liber_markdown::{first_line_text, link_key, name_key};
use liber_vault::{EntryKind, VaultError, VaultPath};
use std::collections::HashSet;
use unicode_segmentation::UnicodeSegmentation;

/// Longest name taken from a first line, in characters (graphemes, so a
/// flag or an accented letter is never cut in half).
pub const MAX_QUICK_NAME: usize = 60;

/// Bytes a generated stem may take, well under the 255-byte file-name
/// limit even with `.md` and a number added.
const MAX_QUICK_BYTES: usize = 200;

/// Invisible characters that would hide or reorder a file name: bidi
/// controls, zero-width spaces, the soft hyphen and the BOM (final review
/// M3). Joiners stay: emoji and some scripts need them.
fn invisible(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{200B}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

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
    let line: String = first_line_text(text)?
        .chars()
        .filter(|c| !invisible(*c))
        .collect();
    if line.trim().is_empty() {
        return None; // sanitizing would make up a name
    }
    let clean = sanitize_file_name(&line);
    let mut cut = String::new();
    for g in clean.graphemes(true).take(MAX_QUICK_NAME) {
        if cut.len() + g.len() > MAX_QUICK_BYTES {
            break;
        }
        cut.push_str(g);
    }
    let stem = cut.trim_end().to_string();
    let usable = stem.chars().any(|c| c != '-' && !c.is_whitespace());
    (usable && !device_name(&stem)).then_some(stem)
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` (with any
/// extension): Windows can't hold a file of that name.
pub fn device_name(stem: &str) -> bool {
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

/// `name` (or `name 1`, `name 2`…) + `.md`, the first `taken` refuses.
fn free_name(stem: &str, taken: impl Fn(&str) -> bool) -> String {
    (0..)
        .map(|i| {
            if i == 0 {
                format!("{stem}.md")
            } else {
                format!("{stem} {i}.md")
            }
        })
        .find(|name| !taken(name))
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
    /// numbered when taken, the note itself not counting). A name any file
    /// in the vault already answers links to counts as taken, so no link
    /// changes meaning and none is rewritten (final review I1). Unflagged notes,
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
        let own = name_key(path.file_name());
        let mut link_names = HashSet::new();
        let mut siblings = HashSet::new();
        for (p, stat) in self.index().stats()? {
            let Ok(p) = VaultPath::new(&p) else { continue };
            if p == *path {
                continue;
            }
            if stat.kind != FileKind::Folder {
                link_names.insert(link_key(p.as_str()));
            }
            if p.parent().unwrap_or_else(VaultPath::root) == dir {
                siblings.insert(name_key(p.file_name()));
            }
        }
        let name = free_name(&stem, |name| {
            link_names.contains(&link_key(name)) || siblings.contains(&name_key(name))
        });
        if name_key(&name) == own {
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
        // Windows can't hold a device name or a trailing dot (final review M4).
        if valid != name || name.ends_with('.') || device_name(name) {
            return Err(SessionError::InvalidName(name.to_string()));
        }
        let target = VaultPath::new(name)?;
        let current = self.vault.scratch_folder();
        let mut outcome = None;
        if current != name {
            // Only the letter case changes: on a case-insensitive disk the
            // current folder answers to the new name, and must be renamed,
            // not adopted (final review I4).
            let case_only = name_key(&current) == name_key(name) && !self.has_exact_entry(name);
            let existing = if case_only {
                None
            } else {
                self.vault.stat(&target)?.map(|e| e.kind)
            };
            match existing {
                Some(EntryKind::Dir) => {}
                Some(_) => return Err(VaultError::AlreadyExists(name.to_string()).into()),
                None => {
                    let from = VaultPath::new(&current)?;
                    if matches!(
                        self.vault.stat(&from)?.map(|e| e.kind),
                        Some(EntryKind::Dir)
                    ) {
                        // Its notes keep their names-from-first-line (final review M2).
                        let prefix = format!("{current}/");
                        let carried: Vec<String> = self
                            .vault
                            .auto_named()
                            .into_iter()
                            .filter_map(|p| p.strip_prefix(&prefix).map(str::to_string))
                            .collect();
                        outcome = Some(self.rename(&from, &target, rewrite_links)?);
                        for rest in carried {
                            self.vault.set_auto_named(&format!("{name}/{rest}"), true)?;
                        }
                    }
                }
            }
        }
        self.vault.set_scratch_folder(name)?;
        Ok(outcome)
    }

    /// The vault root holds an entry named exactly `name` (letter case too).
    fn has_exact_entry(&self, name: &str) -> bool {
        std::fs::read_dir(self.vault.root())
            .map(|dir| dir.flatten().any(|e| e.file_name() == name))
            .unwrap_or(false)
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
    use liber_vault::VaultPath;

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
                .map(liber_vault::WatchEvent::Changed)
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
                liber_vault::VaultError::Io {
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
        for bad in [".liber", "a/b", "Q#1", "  "] {
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

    #[test]
    fn m4c_final_i1_never_takes_a_name_a_link_already_means() {
        let f = open(&[
            ("Home.md", "See [[Groceries]]."),
            ("Shopping/Groceries.md", "milk"),
        ]);
        let q = f.s.create_quick_note(&vp("Scratchpad"), "Q").unwrap();
        std::fs::write(f.root.join("Scratchpad/Q.md"), "Groceries").unwrap();
        changed(&f, std::slice::from_ref(&q));
        let out = f.s.auto_name(&q, true).unwrap();
        assert_eq!(out.path.as_str(), "Scratchpad/Groceries 1.md");
        assert!(out.renamed.unwrap().updated_files.is_empty());
        assert_eq!(
            std::fs::read_to_string(f.root.join("Home.md")).unwrap(),
            "See [[Groceries]]."
        );
        // Accents in another normal form are the same name (M3).
        let r = f.s.create_quick_note(&vp("Scratchpad"), "R").unwrap();
        std::fs::write(f.root.join("Shopping/Café.md"), "x").unwrap();
        changed(&f, &[vp("Shopping/Café.md")]);
        std::fs::write(f.root.join("Scratchpad/R.md"), "Cafe\u{301}").unwrap();
        changed(&f, std::slice::from_ref(&r));
        let out = f.s.auto_name(&r, true).unwrap();
        assert_eq!(out.path.as_str(), "Scratchpad/Cafe\u{301} 1.md");
    }

    #[test]
    fn m4c_final_i2_flags_of_notes_changed_while_closed_are_dropped() {
        let vault = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let root = vault.path();
        let reopen = || VaultSession::open(root, cache.path(), |_| {}).unwrap().0;
        let s = reopen();
        s.create_quick_note(&VaultPath::root(), "Q").unwrap();
        s.create_quick_note(&VaultPath::root(), "Kept").unwrap();
        drop(s);
        // Nothing changed: the flags stay.
        let s = reopen();
        let flags: Vec<String> = s.vault().auto_named().into_iter().collect();
        assert_eq!(flags, ["Kept.md", "Q.md"]);
        drop(s);
        // Renamed in Finder, and a plain note written at the old path.
        std::fs::rename(root.join("Q.md"), root.join("Mine.md")).unwrap();
        std::fs::write(root.join("Q.md"), "Important plan").unwrap();
        let s = reopen();
        let flags: Vec<String> = s.vault().auto_named().into_iter().collect();
        assert_eq!(flags, ["Kept.md"]);
        let out = s.auto_name(&vp("Q.md"), true).unwrap();
        assert_eq!(out.path.as_str(), "Q.md");
        assert!(out.renamed.is_none() && !out.auto_named);
        drop(s);
        // A fresh index (another machine): no flag can be trusted.
        let other = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(root, other.path(), |_| {}).unwrap();
        assert!(s.vault().auto_named().is_empty());
    }

    /// Rename review M3: the first open by the renamed app has an empty
    /// index only because the cache moved, so the old app's flags hold for
    /// notes it doesn't see as changed.
    #[test]
    fn rename_review_flags_survive_the_first_open_after_the_rename() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        let s = VaultSession::open(root, tempfile::tempdir().unwrap().path(), |_| {})
            .unwrap()
            .0;
        s.create_quick_note(&VaultPath::root(), "Q").unwrap();
        drop(s);
        // As the old app left it: its settings folder, and no index here.
        std::fs::rename(
            root.join(liber_vault::META_DIR),
            root.join(liber_vault::LEGACY_META_DIR),
        )
        .unwrap();
        let fresh = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(root, fresh.path(), |_| {}).unwrap();
        let flags: Vec<String> = s.vault().auto_named().into_iter().collect();
        assert_eq!(flags, ["Q.md"]);
    }

    #[test]
    fn m4c_final_i4_a_case_only_change_renames_the_folder() {
        let f = open(&[("Scratchpad/a.md", "x")]);
        assert!(
            f.s.set_scratch_folder("scratchpad", true)
                .unwrap()
                .is_some()
        );
        let names: Vec<String> = std::fs::read_dir(&f.root)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| !n.starts_with('.'))
            .collect();
        assert_eq!(names, ["scratchpad"]);
        assert_eq!(f.s.vault().scratch_folder(), "scratchpad");
        let tree: Vec<String> = f.s.tree().unwrap().into_iter().map(|n| n.path).collect();
        assert!(tree.contains(&"scratchpad/a.md".to_string()), "{tree:?}");
    }

    #[test]
    fn m4c_final_m2_renaming_the_scratch_folder_keeps_its_notes_flagged() {
        let f = open(&[("Elsewhere/x.md", "x")]);
        let q = f.s.create_quick_note(&vp("Scratchpad"), "Q").unwrap();
        f.s.create_quick_note(&vp("Elsewhere"), "E").unwrap();
        assert_eq!(q.as_str(), "Scratchpad/Q.md");
        f.s.set_scratch_folder("Inbox", true).unwrap();
        assert_eq!(flagged(&f), ["Elsewhere/E.md", "Inbox/Q.md"]);
    }

    #[test]
    fn m4c_final_m3_names_cut_by_grapheme_without_invisible_controls() {
        // 59 letters then a flag, two characters: kept whole, not halved.
        let flagged = format!("{}\u{1F1EA}\u{1F1F8}", "a".repeat(59));
        assert_eq!(quick_note_stem(&flagged).unwrap(), flagged);
        let cut = format!("{}\u{1F1EA}\u{1F1F8}", "a".repeat(60));
        assert_eq!(quick_note_stem(&cut).unwrap(), "a".repeat(60));
        // Long emoji sequences stop at whole graphemes within the byte cap.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}".repeat(20);
        let stem = quick_note_stem(&family).unwrap();
        assert!(stem.len() <= MAX_QUICK_BYTES && family.starts_with(&stem));
        assert_eq!(
            stem.len() % "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}".len(),
            0
        );
        // 59 letters then e + combining acute: the accent isn't lost.
        let accent = format!("{}e\u{301}", "a".repeat(59));
        assert_eq!(quick_note_stem(&accent).unwrap(), accent);
        // Bidi overrides and zero-width characters don't reach file names.
        assert_eq!(
            quick_note_stem("pay\u{202E}fdp.exe\u{200B}x").as_deref(),
            Some("payfdp.exex")
        );
        assert_eq!(quick_note_stem("\u{2066}\u{200B}"), None);
    }

    #[test]
    fn m4c_final_m4_scratch_folder_names_windows_cant_hold_are_refused() {
        let f = open(&[]);
        for bad in ["CON", "nul", "Com1", "Inbox.", "Inbox. "] {
            assert!(
                matches!(
                    f.s.set_scratch_folder(bad, true),
                    Err(crate::SessionError::InvalidName(_))
                ),
                "{bad}"
            );
        }
        assert_eq!(f.s.vault().scratch_folder(), "Scratchpad");
    }
}
