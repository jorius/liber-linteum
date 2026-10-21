//! The vault's own Trash and Archive (M5b §5): an item goes into `.trash/`
//! (under its own name) or `.archive/` (under its own path), recorded first
//! and moved second, so a crash between the two leaves at worst a record
//! whose item isn't there (left out of the lists) or an unrecorded item
//! (listed, restored to the vault root).

use crate::error::{Result, SessionError};
use crate::events::RenameOutcome;
use crate::session::{VaultSession, validate_name};
use liber_markdown::link_key;
use liber_vault::{
    ARCHIVE_DIR, Bin, BinRecord, Child, Follow, Kind, TRASH_DIR, Vault, VaultError, VaultPath,
    WatchEvent, is_hidden_name, is_hidden_path,
};
use std::time::{SystemTime, UNIX_EPOCH};

/// One item in a bin.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BinItem {
    /// Its path now (`.trash/…` or `.archive/…`).
    pub path: String,
    /// Where it was; `None` when unrecorded (Obsidian's own trash).
    pub from: Option<String>,
    /// When it went in (ms since epoch).
    pub at: Option<u64>,
    pub folder: bool,
    /// Bytes of the file, or of every file in the folder (M5b round 2;
    /// Trash items only).
    pub size: u64,
    /// A folder's pages, however deep.
    pub pages: Option<u32>,
    /// A page's frontmatter emoji, or a folder's.
    pub icon: Option<String>,
}

fn is_md(path: &VaultPath) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Bytes of every file under `path` (itself, for a file) and how many of
/// them are pages; links are never followed.
fn measure(vault: &Vault, path: &VaultPath) -> (u64, u32) {
    match vault.meta(path, Follow::No) {
        Ok(Some(meta)) if meta.kind == Kind::Dir => {}
        Ok(Some(meta)) => return (meta.len, u32::from(is_md(path))),
        _ => return (0, 0),
    }
    let mut total = (0, 0);
    for child in vault.children(path).into_iter().flatten() {
        if let Child::Entry { name, .. } = child
            && let Ok(p) = path.join(&name)
        {
            let (size, pages) = measure(vault, &p);
            total = (total.0 + size, total.1 + pages);
        }
    }
    total
}

/// A trashed page's frontmatter emoji (the Trash isn't indexed); big files
/// aren't read for it.
fn page_icon(vault: &Vault, path: &VaultPath, size: u64) -> Option<String> {
    if !is_md(path) || size > 1 << 20 {
        return None;
    }
    let text = String::from_utf8(vault.read(path).ok()?.0).ok()?;
    liber_markdown::parse_page(&text, "")
        .icon
        .filter(|i| liber_markdown::is_icon(i))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `name`, `name 1`, `name 2`… (a file keeps its extension last; a folder's
/// dots are part of its name).
fn numbered_entry(name: &str, i: usize, folder: bool) -> String {
    if i == 0 {
        return name.to_string();
    }
    match name.rfind('.').filter(|&dot| dot > 0 && !folder) {
        Some(dot) => format!("{} {i}{}", &name[..dot], &name[dot..]),
        None => format!("{name} {i}"),
    }
}

fn in_bin(path: &VaultPath, dir: &str) -> bool {
    path.as_str()
        .strip_prefix(dir)
        .is_some_and(|rest| rest.len() > 1 && rest.starts_with('/'))
}

impl VaultSession {
    /// The first of `parent/name`, `parent/name 1`… with nothing on disk
    /// (case-insensitive disks included: the file system answers).
    fn free_path(&self, parent: &VaultPath, name: &str, folder: bool) -> Result<VaultPath> {
        for i in 0.. {
            let p = parent.join(&numbered_entry(name, i, folder))?;
            if !self.exists(&p) {
                return Ok(p);
            }
        }
        unreachable!("a free name")
    }

    /// Anything at `path`, a dangling link included.
    pub(crate) fn exists(&self, path: &VaultPath) -> bool {
        self.vault.meta(path, Follow::No).is_ok_and(|m| m.is_some())
    }

    /// A folder, or a link to one inside the vault.
    pub(crate) fn is_dir(&self, path: &VaultPath) -> bool {
        self.vault
            .meta(path, Follow::InsideVault)
            .is_ok_and(|m| m.is_some_and(|m| m.kind == Kind::Dir))
    }

    /// A bin folder, refused when it is a symlink: a `.trash` linked back
    /// into the vault would make Empty Trash take the vault with it.
    fn bin_dir(&self, dir: &str) -> Result<VaultPath> {
        let bin = VaultPath::new(dir)?;
        if self
            .vault
            .meta(&bin, Follow::No)
            .is_ok_and(|m| m.is_some_and(|m| m.kind != Kind::Dir))
        {
            return Err(SessionError::NotPermitted(format!("{dir} isn't a folder")));
        }
        Ok(bin)
    }

    /// Where an item goes back to: its record's path when that is a visible
    /// place under folders (a synced record is not trusted to name `.git`
    /// or `.obsidian`), else `fallback`.
    fn restore_target(&self, recorded: Option<&str>, fallback: VaultPath) -> VaultPath {
        recorded
            .and_then(|from| VaultPath::new(from).ok())
            .filter(|t| {
                !t.is_root()
                    && !is_hidden_path(t.as_str())
                    && validate_name(t.file_name()).is_ok_and(|n| n == t.file_name())
                    && self.parents_are_folders(t)
            })
            .unwrap_or(fallback)
    }

    /// True when nothing above `path` is a file (a folder can be recreated,
    /// a file in the way can't).
    fn parents_are_folders(&self, path: &VaultPath) -> bool {
        let mut dir = path.parent();
        while let Some(d) = dir.filter(|d| !d.is_root()) {
            // A link out of the vault (or dangling) doesn't block: the restore
            // then fails with OutsideVault, as before.
            if matches!(self.vault.meta(&d, Follow::InsideVault), Ok(Some(m)) if m.kind != Kind::Dir)
            {
                return false;
            }
            dir = d.parent();
        }
        true
    }

    /// Refuses what can't go into a bin: the root, hidden paths, the bins
    /// themselves, and the scratch folder (its setting would follow it in).
    fn check_binnable(&self, path: &VaultPath) -> Result<()> {
        let p = path.as_str();
        if path.is_root()
            || is_hidden_path(p)
            || p == ARCHIVE_DIR
            || p == self.vault.scratch_folder()
        {
            return Err(SessionError::NotPermitted(format!(
                "{p} can't be moved to a bin"
            )));
        }
        Ok(())
    }

    fn record(&self, bin: Bin, path: &VaultPath, from: &VaultPath) -> Result<()> {
        let r = BinRecord {
            from: from.to_string(),
            at: now_ms(),
        };
        Ok(self.vault.set_bin_record(bin, path.as_str(), Some(&r))?)
    }

    fn forget_record(&self, bin: Bin, path: &VaultPath) {
        if let Err(e) = self.vault.set_bin_record(bin, path.as_str(), None) {
            self.emit(crate::events::SessionEvent::Warning(format!(
                "{path}: bin record not updated: {e}"
            )));
        }
    }

    /// Indexes folders a restore created (and what is in them).
    fn index_created(&self, created: &[VaultPath], fallback: &VaultPath) -> Result<()> {
        let top = created.first().unwrap_or(fallback).clone();
        self.apply(vec![WatchEvent::Changed(top)])
    }

    /// Moves a page, attachment or folder into the vault's Trash (EXP-03,
    /// M5b §5.1) and returns its path there. Links to it become unresolved;
    /// its widths and cover sizes go with it.
    pub fn trash(&self, path: &VaultPath) -> Result<VaultPath> {
        self.check_binnable(path)?;
        if !self.exists(path) {
            return Err(VaultError::NotFound(path.to_string()).into());
        }
        let bin = self.bin_dir(TRASH_DIR)?;
        self.vault.create_dir_all(&bin)?;
        let dest = self.free_path(&bin, path.file_name(), self.is_dir(path))?;
        let keys: Vec<String> = self
            .index()
            .file_set()?
            .iter()
            .filter(|p| VaultPath::new(p).is_ok_and(|vp| vp.starts_with(path)))
            .map(|p| link_key(p))
            .collect();
        self.record(Bin::Trash, &dest, path)?;
        if let Err(e) = self.vault.rename(path, &dest) {
            self.forget_record(Bin::Trash, &dest);
            return Err(e.into());
        }
        let mut index = self.index();
        index.transaction(|tx| tx.remove(path.as_str()))?;
        let files = index.file_set()?;
        index.resolve_affected(&files, &keys)?;
        drop(index);
        // An archived item leaving the Archive.
        if in_bin(path, ARCHIVE_DIR) {
            self.forget_record(Bin::Archive, path);
        }
        self.follow_layout(&[(path.to_string(), dest.to_string())]);
        Ok(dest)
    }

    /// The Trash's items, newest first; unrecorded ones (Obsidian's) last.
    pub fn trash_list(&self) -> Result<Vec<BinItem>> {
        let records = self.vault.bin_records(Bin::Trash);
        let folder_icons = self.vault.folder_icons();
        let dir = self.bin_dir(TRASH_DIR)?;
        let mut items = Vec::new();
        let Ok(children) = self.vault.children(&dir) else {
            return Ok(items);
        };
        for child in children {
            let Child::Entry { name, meta } = child else {
                continue;
            };
            if is_hidden_name(&name) {
                continue;
            }
            let Ok(vp) = dir.join(&name) else {
                continue;
            };
            let path = vp.to_string();
            let r = records.get(&path);
            let folder = meta.kind == Kind::Dir;
            let (size, pages) = measure(&self.vault, &vp);
            let icon = if folder {
                folder_icons.get(&path).cloned()
            } else {
                page_icon(&self.vault, &vp, size)
            };
            items.push(BinItem {
                folder,
                from: r.map(|r| r.from.clone()),
                at: r.map(|r| r.at),
                size,
                pages: folder.then_some(pages),
                icon,
                path,
            });
        }
        sort_items(&mut items);
        Ok(items)
    }

    /// Moves an item back from the Trash to where it was (the vault root when
    /// unrecorded), recreating missing folders. Where something new took its
    /// place: `AlreadyExists`, or with `keep_both` the next free name.
    pub fn trash_restore(&self, inner: &VaultPath, keep_both: bool) -> Result<VaultPath> {
        if !in_bin(inner, TRASH_DIR) || inner.parent().is_none_or(|p| p.as_str() != TRASH_DIR) {
            return Err(SessionError::NotPermitted(format!(
                "{inner} isn't in the Trash"
            )));
        }
        let from = self.vault.bin_records(Bin::Trash).remove(inner.as_str());
        let target = self.restore_target(
            from.as_ref().map(|r| r.from.as_str()),
            VaultPath::root().join(inner.file_name())?,
        );
        let target = self.bin_place(&target, keep_both, self.is_dir(inner))?;
        let parent = target.parent().unwrap_or_else(VaultPath::root);
        let created = self.vault.create_dir_all(&parent)?;
        self.vault.rename(inner, &target)?;
        self.forget_record(Bin::Trash, inner);
        self.follow_layout(&[(inner.to_string(), target.to_string())]);
        // A note back in the Archive is the Archive's again.
        if in_bin(&target, ARCHIVE_DIR) {
            self.record(Bin::Archive, &target, &strip_archive(&target)?)?;
        }
        self.index_created(&created, &target)?;
        Ok(target)
    }

    /// `target` when free; else `AlreadyExists`, or its next free name.
    fn bin_place(&self, target: &VaultPath, keep_both: bool, folder: bool) -> Result<VaultPath> {
        if !self.exists(target) {
            return Ok(target.clone());
        }
        if !keep_both {
            return Err(VaultError::AlreadyExists(target.to_string()).into());
        }
        let parent = target.parent().unwrap_or_else(VaultPath::root);
        self.free_path(&parent, target.file_name(), folder)
    }

    /// Deletes items from the Trash for good: to the OS trash.
    pub fn trash_delete(&self, items: &[VaultPath]) -> Result<()> {
        self.trash_delete_via(items, &|p| self.vault.trash(p))
    }

    /// `trash_delete` with the OS call passed in (tests never use the real
    /// trash).
    pub(crate) fn trash_delete_via(
        &self,
        items: &[VaultPath],
        os_trash: &dyn Fn(&VaultPath) -> liber_vault::Result<()>,
    ) -> Result<()> {
        self.bin_dir(TRASH_DIR)?;
        if let Some(p) = items
            .iter()
            .find(|p| p.parent().is_none_or(|d| d.as_str() != TRASH_DIR) || !in_bin(p, TRASH_DIR))
        {
            return Err(SessionError::NotPermitted(format!(
                "{p} isn't in the Trash"
            )));
        }
        let mut done = Vec::new();
        let mut result = Ok(());
        for p in items {
            // Already gone (removed outside the app): nothing to delete; its
            // record goes too, and the rest carry on (round-2 review M13).
            let gone = !self.exists(p);
            if !gone && let Err(e) = self.trash_via(p, &|| {}, os_trash) {
                result = Err(e);
                break;
            }
            done.push(p.to_string());
        }
        // One write for every item gone; what is left keeps its record.
        if let Err(e) = self.vault.forget_bin_records(Bin::Trash, &done) {
            self.emit(crate::events::SessionEvent::Warning(format!(
                "Trash records not updated: {e}"
            )));
        }
        result
    }

    /// Empties the Trash: everything in it to the OS trash.
    pub fn trash_empty(&self) -> Result<()> {
        self.trash_empty_via(&|p| self.vault.trash(p))
    }

    pub(crate) fn trash_empty_via(
        &self,
        os_trash: &dyn Fn(&VaultPath) -> liber_vault::Result<()>,
    ) -> Result<()> {
        let items: Vec<VaultPath> = self
            .trash_list()?
            .iter()
            .map(|i| VaultPath::new(&i.path))
            .collect::<std::result::Result<_, _>>()?;
        self.trash_delete_via(&items, os_trash)?;
        // Records whose items are gone already, in one write.
        let stale: Vec<String> = self.vault.bin_records(Bin::Trash).into_keys().collect();
        if let Err(e) = self.vault.forget_bin_records(Bin::Trash, &stale) {
            self.emit(crate::events::SessionEvent::Warning(format!(
                "Trash records not cleared: {e}"
            )));
        }
        Ok(())
    }

    /// Archives a page or folder (M5b §5.3): it moves to `.archive/` under
    /// its own path (or its next free name there), links follow like any
    /// move, and it stays indexed.
    pub fn archive(&self, path: &VaultPath, rewrite_links: bool) -> Result<RenameOutcome> {
        self.check_binnable(path)?;
        if in_bin(path, ARCHIVE_DIR) {
            return Err(SessionError::NotPermitted(format!(
                "{path} is archived already"
            )));
        }
        self.bin_dir(ARCHIVE_DIR)?;
        let dest = VaultPath::new(&format!("{ARCHIVE_DIR}/{path}"))?;
        let parent = dest.parent().unwrap_or_else(VaultPath::root);
        let created = self.vault.create_dir_all(&parent)?;
        let dest = self.bin_place(&dest, true, self.is_dir(path))?;
        self.record(Bin::Archive, &dest, path)?;
        let out = match self.rename(path, &dest, rewrite_links) {
            Ok(out) => out,
            Err(e) => {
                self.forget_record(Bin::Archive, &dest);
                return Err(e);
            }
        };
        if !created.is_empty() {
            self.index_created(&created, &dest)?;
        }
        Ok(out)
    }

    /// The Archive's items, newest first: the recorded ones, and files put
    /// there some other way (from where their path says).
    pub fn archive_list(&self) -> Result<Vec<BinItem>> {
        let records = self.vault.bin_records(Bin::Archive);
        let stats = self.index().stats()?;
        let mut items: Vec<BinItem> = Vec::new();
        for (path, r) in &records {
            if let Some(stat) = stats.get(path) {
                items.push(BinItem {
                    path: path.clone(),
                    from: Some(r.from.clone()),
                    at: Some(r.at),
                    folder: stat.kind == liber_index::FileKind::Folder,
                    ..BinItem::default()
                });
            }
        }
        let covered = |p: &str| {
            records.keys().any(|r| {
                p == r
                    || p.strip_prefix(r.as_str())
                        .is_some_and(|x| x.starts_with('/'))
            })
        };
        for (path, stat) in &stats {
            let vp = VaultPath::new(path)?;
            if stat.kind != liber_index::FileKind::Folder
                && in_bin(&vp, ARCHIVE_DIR)
                && !covered(path)
            {
                items.push(BinItem {
                    path: path.clone(),
                    from: Some(strip_archive(&vp)?.to_string()),
                    ..BinItem::default()
                });
            }
        }
        sort_items(&mut items);
        Ok(items)
    }

    /// Moves an archived item back to where it was (as `trash_restore`), and
    /// removes the Archive folders it leaves empty.
    pub fn unarchive(
        &self,
        path: &VaultPath,
        keep_both: bool,
        rewrite_links: bool,
    ) -> Result<RenameOutcome> {
        if !in_bin(path, ARCHIVE_DIR) {
            return Err(SessionError::NotPermitted(format!("{path} isn't archived")));
        }
        let records = self.vault.bin_records(Bin::Archive);
        let target = self.restore_target(
            records.get(path.as_str()).map(|r| r.from.as_str()),
            strip_archive(path)?,
        );
        let target = self.bin_place(&target, keep_both, self.is_dir(path))?;
        let parent = target.parent().unwrap_or_else(VaultPath::root);
        let created = self.vault.create_dir_all(&parent)?;
        let out = self.rename(path, &target, rewrite_links)?;
        self.forget_record(Bin::Archive, path);
        if !created.is_empty() {
            self.index_created(&created, &target)?;
        }
        self.prune_archive(path.parent());
        Ok(out)
    }

    /// Removes empty Archive folders from `dir` up (never `.archive` itself).
    fn prune_archive(&self, mut dir: Option<VaultPath>) {
        while let Some(d) = dir.filter(|d| in_bin(d, ARCHIVE_DIR)) {
            if self.vault.remove_empty_dir(&d).is_err() {
                return;
            }
            let _ = self.index().transaction(|tx| tx.remove(d.as_str()));
            dir = d.parent();
        }
    }
}

/// `.archive/x` → `x`.
fn strip_archive(path: &VaultPath) -> Result<VaultPath> {
    Ok(VaultPath::new(&path.as_str()[ARCHIVE_DIR.len() + 1..])?)
}

fn sort_items(items: &mut [BinItem]) {
    items.sort_by(|a, b| {
        b.at.is_some()
            .cmp(&a.at.is_some())
            .then(b.at.cmp(&a.at))
            .then_with(|| a.path.cmp(&b.path))
    });
}

#[cfg(test)]
mod tests {
    use crate::SessionError;
    use crate::session::VaultSession;
    use liber_vault::{Bin, PageWidth, VaultError, VaultPath};
    use std::path::Path;

    fn vp(s: &str) -> VaultPath {
        VaultPath::new(s).unwrap()
    }

    struct Fx {
        s: VaultSession,
        root: std::path::PathBuf,
        _v: tempfile::TempDir,
        _c: tempfile::TempDir,
    }

    fn fx(files: &[(&str, &str)]) -> Fx {
        let v = tempfile::tempdir().unwrap();
        for (p, text) in files {
            let full = v.path().join(p);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        let c = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(v.path(), c.path(), |_| {}).unwrap();
        Fx {
            root: v.path().to_path_buf(),
            s,
            _v: v,
            _c: c,
        }
    }

    fn exists(root: &Path, p: &str) -> bool {
        root.join(p).exists()
    }

    fn backlinks(s: &VaultSession, p: &str) -> usize {
        s.backlinks(&vp(p)).unwrap().len()
    }

    /// The OS call of a permanent delete, as a plain removal (never the real
    /// trash in tests).
    fn remove(root: &Path) -> impl Fn(&VaultPath) -> liber_vault::Result<()> + '_ {
        move |p: &VaultPath| {
            let full = root.join(p.as_str());
            if full.is_dir() {
                std::fs::remove_dir_all(full)
            } else {
                std::fs::remove_file(full)
            }
            .map_err(|source| liber_vault::VaultError::Io {
                path: p.to_string(),
                source,
            })
        }
    }

    #[test]
    fn m5b_r2_the_trash_lists_sizes_page_counts_and_icons() {
        let f = fx(&[
            ("Rocket.md", "---\nicon: 🚀\n---\n# R\n"),
            ("Camp/a.md", "aaaa"),
            ("Camp/Inner/b.md", "bb"),
            ("Camp/map.png", "png!"),
        ]);
        f.s.vault().set_folder_icon("Camp", Some("🏕️")).unwrap();
        f.s.trash(&vp("Rocket.md")).unwrap();
        f.s.trash(&vp("Camp")).unwrap();
        let items = f.s.trash_list().unwrap();
        let get = |p: &str| items.iter().find(|i| i.path == p).unwrap();
        let rocket = get(".trash/Rocket.md");
        assert_eq!(rocket.size, "---\nicon: 🚀\n---\n# R\n".len() as u64);
        assert_eq!(rocket.icon.as_deref(), Some("🚀"));
        assert_eq!(rocket.pages, None);
        let camp = get(".trash/Camp");
        assert_eq!(camp.size, 10, "4 + 2 + 4 bytes, every file inside");
        assert_eq!(camp.pages, Some(2));
        assert_eq!(camp.icon.as_deref(), Some("🏕️"));
    }

    #[test]
    fn m5b_trash_moves_into_the_vaults_trash_and_restore_brings_it_back() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("P/B.md", "# B"), ("A.md", "see [[B]]")]);
        f.s.vault()
            .set_page_width("P/B.md", Some(PageWidth::Full))
            .unwrap();
        assert_eq!(backlinks(&f.s, "P/B.md"), 1);

        let inner = f.s.trash(&vp("P/B.md")).unwrap();
        assert_eq!(inner.as_str(), ".trash/B.md");
        assert!(exists(&f.root, ".trash/B.md") && !exists(&f.root, "P/B.md"));
        assert!(f.s.page(&vp("P/B.md")).unwrap().is_none());
        let items = f.s.trash_list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, ".trash/B.md");
        assert_eq!(items[0].from.as_deref(), Some("P/B.md"));
        assert!(!items[0].folder);

        // The folder it came from is gone too: restore recreates it.
        std::fs::remove_dir(f.root.join("P")).unwrap();
        let back = f.s.trash_restore(&inner, false).unwrap();
        assert_eq!(back.as_str(), "P/B.md");
        assert!(exists(&f.root, "P/B.md") && !exists(&f.root, ".trash/B.md"));
        assert!(f.s.page(&vp("P/B.md")).unwrap().is_some(), "indexed again");
        assert_eq!(backlinks(&f.s, "P/B.md"), 1, "links resolve again");
        assert!(f.s.trash_list().unwrap().is_empty());
        assert!(f.s.vault().bin_records(Bin::Trash).is_empty());
        let widths: Vec<String> = f.s.vault().page_widths().pages.into_keys().collect();
        assert_eq!(widths, ["P/B.md"], "its width came back with it");
    }

    #[test]
    fn m5b_name_clashes_in_the_trash_and_on_restore_never_overwrite() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("a.md", "1"), ("F/a.md", "2"), ("Dir/x.md", "3")]);
        assert_eq!(f.s.trash(&vp("a.md")).unwrap().as_str(), ".trash/a.md");
        assert_eq!(f.s.trash(&vp("F/a.md")).unwrap().as_str(), ".trash/a 1.md");
        assert_eq!(f.s.trash(&vp("Dir")).unwrap().as_str(), ".trash/Dir");
        std::fs::create_dir(f.root.join("Dir")).unwrap();
        std::fs::write(f.root.join("Dir/x.md"), "new").unwrap();
        assert_eq!(f.s.trash(&vp("Dir")).unwrap().as_str(), ".trash/Dir 1");

        // Something new took the old place: refused, unless both are kept.
        std::fs::write(f.root.join("a.md"), "newer").unwrap();
        let err = f.s.trash_restore(&vp(".trash/a.md"), false).unwrap_err();
        assert!(
            matches!(
                err,
                SessionError::Vault(liber_vault::VaultError::AlreadyExists(_))
            ),
            "{err:?}"
        );
        let kept = f.s.trash_restore(&vp(".trash/a.md"), true).unwrap();
        assert_eq!(kept.as_str(), "a 1.md");
        assert_eq!(
            std::fs::read_to_string(f.root.join("a.md")).unwrap(),
            "newer"
        );
        assert_eq!(std::fs::read_to_string(f.root.join("a 1.md")).unwrap(), "1");
    }

    #[test]
    fn m5b_the_list_shows_unrecorded_items_and_drops_stale_records() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[(".trash/obsidian.md", "from Obsidian"), ("a.md", "x")]);
        let inner = f.s.trash(&vp("a.md")).unwrap();
        // Deleted from .trash outside the app: its record is stale.
        std::fs::remove_file(f.root.join(inner.as_str())).unwrap();
        // A crash after the record, before the move: also stale.
        f.s.vault()
            .set_bin_record(
                Bin::Trash,
                ".trash/ghost.md",
                Some(&liber_vault::BinRecord {
                    from: "ghost.md".into(),
                    at: 1,
                }),
            )
            .unwrap();
        let items = f.s.trash_list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, ".trash/obsidian.md");
        assert_eq!(items[0].from, None);
        // Unrecorded: restores to the vault root.
        let back = f.s.trash_restore(&vp(".trash/obsidian.md"), false).unwrap();
        assert_eq!(back.as_str(), "obsidian.md");
    }

    #[test]
    fn m5b_the_scratch_folder_hidden_paths_and_the_bins_themselves_are_refused() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[
            ("Scratchpad/q.md", "q"),
            (".archive/x.md", "x"),
            ("a.md", "a"),
        ]);
        for p in [
            "Scratchpad",
            liber_vault::META_DIR,
            liber_vault::LEGACY_META_DIR,
            ".trash",
            ".archive",
            ".obsidian/x.json",
        ] {
            assert!(f.s.trash(&vp(p)).is_err(), "{p} trashed");
            assert!(f.s.archive(&vp(p), true).is_err(), "{p} archived");
        }
        // An archived item can go to the Trash; a page inside the scratch
        // folder too.
        assert!(f.s.trash(&vp(".archive/x.md")).is_ok());
        assert!(f.s.trash(&vp("Scratchpad/q.md")).is_ok());
        // Only items in the bin can be restored or deleted from it.
        assert!(f.s.trash_restore(&vp("a.md"), false).is_err());
        assert!(
            f.s.trash_delete_via(&[vp("a.md")], &remove(&f.root))
                .is_err()
        );
        assert!(exists(&f.root, "a.md"));
    }

    #[test]
    fn m5b_deleting_from_the_trash_goes_through_the_os_call_and_forgets_it() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("a.md", "a"), ("b.md", "b")]);
        f.s.vault()
            .set_page_width("a.md", Some(PageWidth::Full))
            .unwrap();
        let a = f.s.trash(&vp("a.md")).unwrap();
        f.s.trash(&vp("b.md")).unwrap();
        f.s.trash_delete_via(&[a], &remove(&f.root)).unwrap();
        assert!(!exists(&f.root, ".trash/a.md"));
        assert!(f.s.vault().page_widths().pages.is_empty());
        assert_eq!(f.s.trash_list().unwrap().len(), 1);
        f.s.trash_empty_via(&remove(&f.root)).unwrap();
        assert!(f.s.trash_list().unwrap().is_empty());
        assert!(f.s.vault().bin_records(Bin::Trash).is_empty());
    }

    #[test]
    fn m5b_r2_review_m13_deleting_skips_an_item_already_gone() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("a.md", "a"), ("b.md", "b")]);
        let a = f.s.trash(&vp("a.md")).unwrap();
        let b = f.s.trash(&vp("b.md")).unwrap();
        std::fs::remove_file(f.root.join(a.as_str())).unwrap(); // gone outside the app
        f.s.trash_delete_via(&[a, b], &remove(&f.root)).unwrap();
        assert!(!exists(&f.root, ".trash/b.md"));
        assert!(f.s.trash_list().unwrap().is_empty());
        assert!(f.s.vault().bin_records(Bin::Trash).is_empty());
    }

    #[test]
    fn m5b_trashing_a_quick_note_ends_its_auto_naming() {
        let f = fx(&[("Scratchpad/q.md", "q")]);
        f.s.vault().set_auto_named("Scratchpad/q.md", true).unwrap();
        let inner = f.s.trash(&vp("Scratchpad/q.md")).unwrap();
        f.s.trash_restore(&inner, false).unwrap();
        assert!(f.s.vault().auto_named().is_empty());
    }

    #[test]
    fn m5b_archive_keeps_links_working_and_hides_it_from_the_tree_and_global_view() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[
            ("P/Old.md", "# Old"),
            ("A.md", "see [[Old]] and [[P/Old]]"),
            ("Home.md", "[[A]]"),
        ]);
        f.s.archive(&vp("P/Old.md"), true).unwrap();
        assert!(exists(&f.root, ".archive/P/Old.md") && !exists(&f.root, "P/Old.md"));
        assert_eq!(
            backlinks(&f.s, ".archive/P/Old.md"),
            2,
            "both links still resolve"
        );
        // `[[P/Old]]` still names it by its path's end (as Obsidian reads
        // it): nothing needed rewriting.
        let text = std::fs::read_to_string(f.root.join("A.md")).unwrap();
        assert_eq!(text, "see [[Old]] and [[P/Old]]");
        assert!(
            f.s.page(&vp(".archive/P/Old.md")).unwrap().is_some(),
            "still indexed"
        );
        let tree = f.s.tree().unwrap();
        assert!(
            tree.iter().all(|n| !n.path.starts_with(".archive")),
            "{tree:?}"
        );
        let cards = f.s.gv_children(&crate::GvLevel::Vault).unwrap().cards;
        assert!(cards.iter().all(|c| !c.path.starts_with(".archive")));
        let around =
            f.s.gv_children(&crate::GvLevel::Page(vp("A.md")))
                .unwrap()
                .cards;
        assert!(
            around.iter().all(|c| !c.path.starts_with(".archive")),
            "neighbours too"
        );

        let items = f.s.archive_list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, ".archive/P/Old.md");
        assert_eq!(items[0].from.as_deref(), Some("P/Old.md"));

        f.s.unarchive(&vp(".archive/P/Old.md"), false, true)
            .unwrap();
        assert!(exists(&f.root, "P/Old.md"));
        assert!(!exists(&f.root, ".archive/P"), "emptied archive folders go");
        assert_eq!(backlinks(&f.s, "P/Old.md"), 2);
        let text = std::fs::read_to_string(f.root.join("A.md")).unwrap();
        assert_eq!(text, "see [[Old]] and [[P/Old]]");
        assert!(f.s.archive_list().unwrap().is_empty());
    }

    #[test]
    fn m5b_archiving_a_folder_and_unarchiving_onto_a_new_one() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("Camp/a.md", "a"), ("Camp/b.md", "b")]);
        f.s.archive(&vp("Camp"), true).unwrap();
        let items = f.s.archive_list().unwrap();
        assert_eq!(items.len(), 1, "{items:?}");
        assert!(items[0].folder);
        std::fs::create_dir(f.root.join("Camp")).unwrap();
        let err =
            f.s.unarchive(&vp(".archive/Camp"), false, true)
                .unwrap_err();
        assert!(
            matches!(err, SessionError::Vault(VaultError::AlreadyExists(_))),
            "{err:?}"
        );
        f.s.unarchive(&vp(".archive/Camp"), true, true).unwrap();
        assert!(exists(&f.root, "Camp 1/a.md"));
        assert!(f.s.page(&vp("Camp 1/b.md")).unwrap().is_some());
    }

    #[test]
    fn m5b_files_put_in_the_archive_by_hand_are_listed() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[(".archive/Notes/x.md", "x")]);
        let items = f.s.archive_list().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].from.as_deref(), Some("Notes/x.md"));
        f.s.unarchive(&vp(".archive/Notes/x.md"), false, true)
            .unwrap();
        assert!(exists(&f.root, "Notes/x.md"));
        assert!(f.s.page(&vp("Notes/x.md")).unwrap().is_some());
    }

    #[test]
    fn m5b_review_i1_a_record_never_restores_into_a_hidden_folder() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[
            (".trash/post-checkout", "#!/bin/sh"),
            (".archive/x.md", "x"),
            ("a.md", "a"),
        ]);
        let rec = |from: &str| liber_vault::BinRecord {
            from: from.into(),
            at: 1,
        };
        f.s.vault()
            .set_bin_record(
                Bin::Trash,
                ".trash/post-checkout",
                Some(&rec(".git/hooks/post-checkout")),
            )
            .unwrap();
        f.s.vault()
            .set_bin_record(Bin::Archive, ".archive/x.md", Some(&rec(".obsidian/x.md")))
            .unwrap();
        let back =
            f.s.trash_restore(&vp(".trash/post-checkout"), false)
                .unwrap();
        assert_eq!(back.as_str(), "post-checkout", "as unrecorded: the root");
        assert!(!exists(&f.root, ".git"));
        f.s.unarchive(&vp(".archive/x.md"), false, true).unwrap();
        assert!(exists(&f.root, "x.md"));
        assert!(!exists(&f.root, ".obsidian"));
        // A rename from the page can't move anything into a hidden folder.
        assert!(f.s.rename(&vp("a.md"), &vp(".git/a.md"), true).is_err());
        assert!(
            f.s.rename(&vp("a.md"), &vp("P/.hidden/a.md"), true)
                .is_err()
        );
        assert!(exists(&f.root, "a.md"));
    }

    #[cfg(unix)]
    #[test]
    fn m5b_review_i2_a_bin_that_is_a_symlink_is_refused() {
        // No symlinks in an encrypted vault (E3).
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("Notes/a.md", "a"), ("b.md", "b")]);
        std::os::unix::fs::symlink(".", f.root.join(".trash")).unwrap();
        assert!(f.s.trash_list().is_err());
        assert!(f.s.trash_empty_via(&remove(&f.root)).is_err());
        assert!(f.s.trash(&vp("b.md")).is_err());
        assert!(exists(&f.root, "Notes/a.md") && exists(&f.root, "b.md"));
        std::os::unix::fs::symlink("Notes", f.root.join(".archive")).unwrap();
        assert!(f.s.archive(&vp("b.md"), true).is_err());
        assert!(exists(&f.root, "b.md"));
    }

    #[test]
    fn m5b_review_m1_a_live_page_wins_a_name_over_an_archived_one() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        // `.archive/Old.md` and `Q/Old.md` tie on depth, and `.` sorts first.
        let f = fx(&[
            ("Old.md", "# Old"),
            ("Q/Old.md", "# Q"),
            ("A.md", "[[Old]]"),
        ]);
        assert_eq!(backlinks(&f.s, "Old.md"), 1);
        f.s.archive(&vp("Old.md"), true).unwrap();
        assert_eq!(backlinks(&f.s, ".archive/Old.md"), 1, "A keeps its target");
        std::fs::write(f.root.join("B.md"), "[[Old]]").unwrap();
        f.s.apply(vec![liber_vault::WatchEvent::Changed(vp("B.md"))])
            .unwrap();
        assert_eq!(
            backlinks(&f.s, "Q/Old.md"),
            1,
            "a new link means the live page"
        );
    }

    #[test]
    fn m5b_review_m2_restoring_under_what_is_now_a_file_goes_to_the_root() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("P/a.md", "a")]);
        let inner = f.s.trash(&vp("P/a.md")).unwrap();
        std::fs::remove_dir(f.root.join("P")).unwrap();
        std::fs::write(f.root.join("P"), "now a file").unwrap();
        let back = f.s.trash_restore(&inner, false).unwrap();
        assert_eq!(back.as_str(), "a.md");
        assert_eq!(
            std::fs::read_to_string(f.root.join("P")).unwrap(),
            "now a file"
        );
    }

    #[test]
    fn m5b_review_m6_deleting_from_the_trash_forgets_positions_and_picks() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("F/a.md", "a"), ("F/b.md", "b")]);
        let at = liber_vault::CardPosition { x: 1.0, y: 2.0 };
        f.s.vault()
            .set_layout_level("F", &[("F/a.md".to_string(), at)].into())
            .unwrap();
        f.s.vault().set_index_pick("F", Some("F/a.md")).unwrap();
        let inner = f.s.trash(&vp("F")).unwrap();
        assert!(!f.s.vault().layout_level(inner.as_str()).is_empty());
        f.s.trash_delete_via(std::slice::from_ref(&inner), &remove(&f.root))
            .unwrap();
        std::fs::create_dir_all(f.root.join(inner.as_str())).unwrap();
        assert!(f.s.vault().layout_level(inner.as_str()).is_empty());
        assert!(f.s.vault().index_picks().is_empty());
    }

    #[test]
    fn m5b_favorites_follow_trash_restore_archive_and_are_forgotten_on_delete() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("a.md", "a"), ("F/b.md", "b"), ("c.md", "c")]);
        let v = f.s.vault();
        v.set_favorites(&["a.md".into(), "F".into(), "c.md".into()])
            .unwrap();
        // Trash and Restore: the entry keeps its place.
        let inner = f.s.trash(&vp("F")).unwrap();
        assert_eq!(v.favorites()[1], inner.as_str());
        f.s.trash_restore(&inner, false).unwrap();
        assert_eq!(v.favorites(), ["a.md", "F", "c.md"]);
        // Archive and Unarchive: the same.
        f.s.archive(&vp("a.md"), true).unwrap();
        assert_eq!(v.favorites()[0], ".archive/a.md");
        f.s.unarchive(&vp(".archive/a.md"), false, true).unwrap();
        assert_eq!(v.favorites()[0], "a.md");
        // Deleting from the Trash forgets it.
        let inner = f.s.trash(&vp("c.md")).unwrap();
        f.s.trash_delete_via(std::slice::from_ref(&inner), &remove(&f.root))
            .unwrap();
        assert_eq!(v.favorites(), ["a.md", "F"]);
    }

    #[test]
    fn m5b_review_m8_a_folder_name_keeps_its_dots() {
        assert_eq!(super::numbered_entry("v1.2", 1, true), "v1.2 1");
        assert_eq!(super::numbered_entry("a.tar.gz", 1, false), "a.tar 1.gz");
    }

    /// A recorded parent that is now a link out of the vault: the restore is
    /// refused (OutsideVault), never sent to the vault root instead.
    #[cfg(unix)]
    #[test]
    fn a_restore_through_a_parent_linked_outside_is_refused() {
        // No symlinks in an encrypted vault (E3).
        if liber_testkit::plain_disk_only() {
            return;
        }
        let f = fx(&[("sub/a.md", "a")]);
        let inner = f.s.trash(&vp("sub/a.md")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::remove_dir(f.root.join("sub")).unwrap();
        std::os::unix::fs::symlink(outside.path(), f.root.join("sub")).unwrap();
        let out = f.s.trash_restore(&inner, false);
        assert!(
            matches!(
                out,
                Err(crate::SessionError::Vault(VaultError::OutsideVault(_)))
            ),
            "{out:?}"
        );
        assert!(!exists(&f.root, "a.md") && exists(&f.root, inner.as_str()));
    }
}
