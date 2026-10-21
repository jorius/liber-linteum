use crate::error::{Result, SessionError};
use crate::events::RenameOutcome;
use crate::events::SessionEvent;
use crate::session::{VaultSession, is_page_path, subtree_files, validate_name, write_loaded};
use liber_markdown::{FileSet, LinkKind, link_key, parse_page, resolve, shortest_unique_target};
use liber_vault::{Follow, Kind, VaultError, VaultPath};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use std::collections::{BTreeSet, HashMap};
use std::ops::Range;

const MAX_ATTEMPTS: usize = 3;

/// Characters %-encoded when rewriting an encoded Markdown destination.
const PATH_ENCODE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

/// The old and new view of the vault for one rename.
pub(crate) struct RenamePlan {
    pub old_files: FileSet,
    pub new_files: FileSet,
    /// Old path → new path for every moved file.
    pub moved: HashMap<String, String>,
}

impl RenamePlan {
    pub(crate) fn map<'a>(&'a self, path: &'a str) -> &'a str {
        self.moved.get(path).map(String::as_str).unwrap_or(path)
    }

    /// Old path of a file given its path after the move.
    fn unmap<'a>(&'a self, new_path: &'a str) -> &'a str {
        self.moved
            .iter()
            .find(|(_, n)| n.as_str() == new_path)
            .map(|(o, _)| o.as_str())
            .unwrap_or(new_path)
    }

    /// Edits for one file's current text (`path_now` is its path after the move):
    /// every link that resolved before the move but would now resolve elsewhere
    /// is rewritten to the shortest text that points at the moved target again.
    pub(crate) fn edits_for(&self, path_now: &str, text: &str) -> Vec<(Range<usize>, String)> {
        let old_src = self.unmap(path_now);
        let stem = path_now
            .rsplit('/')
            .next()
            .unwrap_or(path_now)
            .trim_end_matches(".md");
        let mut edits = Vec::new();
        for link in parse_page(text, stem).links {
            let Some(before) = resolve(link.kind, &link.target, old_src, &self.old_files) else {
                continue; // unresolved links are left alone
            };
            let want = self.map(&before);
            if resolve(link.kind, &link.target, path_now, &self.new_files).as_deref() == Some(want)
            {
                continue;
            }
            let rooted = !link.kind.is_wiki_style() && link.target.starts_with('/');
            let mut new_text =
                shortest_unique_target(want, path_now, &self.new_files, link.kind, rooted);
            // Markdown destinations keep their style: %-encoded stays encoded;
            // a plain destination that now needs a space is %-encoded too
            // (wrapping in `<…>` would break a `#heading` suffix).
            // `#` and `?` in a plain destination would start a heading/query.
            let path_style = matches!(link.kind, LinkKind::Markdown | LinkKind::MarkdownImage);
            let needs_encoding = new_text.contains([' ', '#', '?']);
            if link.encoded || (path_style && !link.angle && needs_encoding) {
                new_text = utf8_percent_encode(&new_text, PATH_ENCODE).to_string();
            }
            if text[link.range.clone()] != new_text {
                edits.push((link.range, new_text));
            }
        }
        edits
    }

    /// Final check before writing (final review C1/I1): the rewritten text must
    /// contain the same links in the same order, and every link that resolved
    /// before the move must resolve to the moved-through target afterwards.
    pub(crate) fn verify(
        &self,
        path_now: &str,
        old_text: &str,
        new_text: &str,
    ) -> std::result::Result<(), String> {
        let old_src = self.unmap(path_now);
        let before = parse_page(old_text, "").links;
        let after = parse_page(new_text, "").links;
        if before.len() != after.len() {
            return Err(format!(
                "rewrite would change the number of links ({} → {})",
                before.len(),
                after.len()
            ));
        }
        for (b, a) in before.iter().zip(&after) {
            if b.kind != a.kind {
                return Err("rewrite would change a link's kind".to_string());
            }
            let Some(target) = resolve(b.kind, &b.target, old_src, &self.old_files) else {
                continue;
            };
            let want = self.map(&target);
            if resolve(a.kind, &a.target, path_now, &self.new_files).as_deref() != Some(want) {
                return Err(format!(
                    "no link text can point at {want} from here; links left unchanged"
                ));
            }
        }
        Ok(())
    }
}

/// Sorts and de-duplicates edits; overlapping edits are refused (they would
/// corrupt the text — final review C1).
pub(crate) fn checked_edits(
    mut edits: Vec<(Range<usize>, String)>,
) -> std::result::Result<Vec<(Range<usize>, String)>, String> {
    edits.sort_by_key(|e| (e.0.start, e.0.end));
    edits.dedup();
    if edits.windows(2).any(|w| w[0].0.end > w[1].0.start) {
        return Err("overlapping link edits; file left unchanged".to_string());
    }
    Ok(edits)
}

/// Applies non-overlapping edits from the end of the text to the start.
pub(crate) fn apply_edits(text: &str, edits: &[(Range<usize>, String)]) -> String {
    let mut out = text.to_string();
    let mut sorted: Vec<_> = edits.iter().collect();
    sorted.sort_by_key(|e| std::cmp::Reverse(e.0.start));
    for (range, new) in sorted {
        out.replace_range(range.clone(), new);
    }
    out
}

impl VaultSession {
    /// Renames or moves a page, attachment or folder (EXP-02). With
    /// `rewrite_links`, every reference that would otherwise change target is
    /// rewritten (EXP-04, spec §6.4). The move happens first; files that cannot
    /// be rewritten are reported in `failed`.
    pub fn rename(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        rewrite_links: bool,
    ) -> Result<RenameOutcome> {
        let is_folder = self.is_dir(from);
        let pair = paired_rename(from, to, is_folder, |f| self.vault.folder_page_of(f));
        // The pair's second step is checked before anything moves (round 3b
        // final review #1): its name, and a clash in the coordinates it has
        // now. For a folder, `to/<x>.md` is still `from/<x>.md`. A case-only
        // pair is the same entry and the vault handles it.
        if let Some((a, b)) = &pair {
            check_target(a, b)?;
            let now = |p: &VaultPath| match p.rebase(to, from) {
                Some(q) if is_folder => q,
                _ => p.clone(),
            };
            let (a_now, b_now) = (now(a), now(b));
            if self.exists(&b_now) && !self.vault.same_entry(&a_now, &b_now) {
                return Err(VaultError::AlreadyExists(b.to_string()).into());
            }
        }
        let mut outcome = self.rename_with_hook(from, to, rewrite_links, &|_| {})?;
        if let Some((a, b)) = pair {
            let second = match self.rename_with_hook(&a, &b, rewrite_links, &|_| {}) {
                Ok(second) => second,
                Err(e) => {
                    // Backstop for an I/O failure after the checks above: put
                    // the first move back so the pair never ends up split.
                    if let Err(back) = self.rename_with_hook(to, from, rewrite_links, &|_| {}) {
                        self.emit(SessionEvent::Warning(format!(
                            "{to}: could not undo the rename after {b} failed: {back}"
                        )));
                    }
                    return Err(e);
                }
            };
            // Files the first step touched are reported where they are now.
            let after = |p: String| {
                second
                    .moved
                    .iter()
                    .find(|(o, _)| *o == p)
                    .map_or(p, |(_, n)| n.clone())
            };
            outcome.updated_files = outcome.updated_files.into_iter().map(after).collect();
            outcome.failed = outcome
                .failed
                .into_iter()
                .map(|(p, e)| (after(p), e))
                .collect();
            outcome.moved.extend(second.moved);
            outcome.moved.sort();
            outcome.updated_files.extend(second.updated_files);
            outcome.updated_files.sort();
            outcome.updated_files.dedup();
            outcome.updated_links += second.updated_links;
            outcome.failed.extend(second.failed);
            outcome.pair = Some((a.to_string(), b.to_string()));
        }
        Ok(outcome)
    }

    /// Add sub-page (round 3 §9): `P.md` becomes its folder's page,
    /// `P/P.md`, through the ordinary rename so links follow. An existing
    /// folder `P/` takes it when the disk treats its name as `P` (exact, or a
    /// case variant on a case-insensitive file system). Refused, with nothing
    /// moved, when a file holds the name, the folder already has a page,
    /// `page` already is one, or it sits in a hidden folder. Returns
    /// (folder, page, outcome).
    pub fn make_folder_page(
        &self,
        page: &VaultPath,
        rewrite_links: bool,
    ) -> Result<(VaultPath, VaultPath, RenameOutcome)> {
        let (folder, create) = self.folder_plan(page)?;
        self.convert(page, &folder, create, rewrite_links)
    }

    /// Moves `item` under the page `page` (round 3 §9.3), turning `page`
    /// into its folder's page first if it isn't one. Every refusal (self,
    /// ancestor, a name clash, already there, hidden) comes before anything
    /// moves; if the move still fails, the conversion is undone.
    pub fn move_under_page(
        &self,
        item: &VaultPath,
        page: &VaultPath,
        rewrite_links: bool,
    ) -> Result<MoveUnderOutcome> {
        if liber_vault::is_hidden_path(item.as_str()) {
            return Err(VaultError::OutsideVault(item.to_string()).into());
        }
        let into_itself = || SessionError::InvalidName(format!("cannot move {item} into itself"));
        if item == page || page.starts_with(item) {
            return Err(into_itself());
        }
        let parent = page
            .parent()
            .ok_or_else(|| VaultError::NotFound(page.to_string()))?;
        let already =
            !parent.is_root() && self.vault.folder_page_of(&parent).as_ref() == Some(page);
        let (folder, create) = if already {
            (parent, false)
        } else {
            self.folder_plan(page)?
        };
        if item == &folder || folder.starts_with(item) || self.vault.same_entry(item, &folder) {
            return Err(into_itself());
        }
        let name = item.file_name();
        let target = folder.join(name)?;
        if item
            .parent()
            .is_some_and(|p| p == folder || self.vault.same_entry(&p, &folder))
        {
            return Err(VaultError::AlreadyExists(target.to_string()).into());
        }
        if let Some(taken) = self.vault.child_named(&folder, name)?
            && (taken.file_name() == name || self.vault.same_entry(&taken, &target))
            && !self.vault.same_entry(&taken, item)
        {
            return Err(VaultError::AlreadyExists(taken.to_string()).into());
        }
        // The move's own checks (its name, hidden targets) come before the
        // conversion too, so a refused name never rewrites links twice.
        check_target(item, &target)?;
        let converted = if already {
            None
        } else {
            Some(self.convert(page, &folder, create, rewrite_links)?)
        };
        match self.rename(item, &target, rewrite_links) {
            Ok(moved) => Ok(MoveUnderOutcome {
                page: converted
                    .as_ref()
                    .map_or_else(|| page.clone(), |(_, p, _)| p.clone()),
                converted: converted.map(|(_, _, out)| out),
                folder,
                moved,
            }),
            Err(e) => {
                if let Some((_, new_page, _)) = &converted {
                    self.undo_conversion(new_page, page, &folder, create, rewrite_links);
                }
                Err(e)
            }
        }
    }

    /// Undoes a conversion after the move under it failed: the page goes
    /// back, and a folder made for it goes too.
    fn undo_conversion(
        &self,
        new_page: &VaultPath,
        page: &VaultPath,
        folder: &VaultPath,
        create: bool,
        rewrite_links: bool,
    ) {
        if let Err(e) = self.rename(new_page, page, rewrite_links) {
            // The page stays where the conversion put it (and indexed there).
            self.emit(SessionEvent::Warning(format!(
                "{new_page}: could not move back to {page} after the move failed: {e}"
            )));
        }
        if create {
            self.drop_created_folder(folder);
        }
    }

    /// The folder `page` becomes the page of, and whether it must be made.
    fn folder_plan(&self, page: &VaultPath) -> Result<(VaultPath, bool)> {
        let parent = page
            .parent()
            .ok_or_else(|| VaultError::NotFound(page.to_string()))?;
        if liber_vault::is_hidden_path(page.as_str()) {
            return Err(VaultError::OutsideVault(page.to_string()).into());
        }
        if !is_page_path(page.as_str()) || self.vault.folder_page_of(&parent).as_ref() == Some(page)
        {
            return Err(VaultError::AlreadyExists(page.to_string()).into());
        }
        let stem = page.stem();
        let exact = parent.join(stem)?;
        match self.vault.child_named(&parent, stem)? {
            Some(f) if reuse_folder(f.file_name() == stem, self.vault.same_entry(&f, &exact)) => {
                if !self.is_dir(&f) {
                    return Err(VaultError::AlreadyExists(f.to_string()).into());
                }
                if let Some(own) = self.vault.folder_page_of(&f) {
                    return Err(VaultError::AlreadyExists(own.to_string()).into());
                }
                Ok((f, false))
            }
            _ => Ok((exact, true)),
        }
    }

    /// `page` → `folder/<folder>.<page's own extension>`, making `folder` first
    /// when `create`; a folder made here goes again if the page can't move.
    fn convert(
        &self,
        page: &VaultPath,
        folder: &VaultPath,
        create: bool,
        rewrite_links: bool,
    ) -> Result<(VaultPath, VaultPath, RenameOutcome)> {
        if create {
            let parent = folder
                .parent()
                .ok_or_else(|| VaultError::NotFound(folder.to_string()))?;
            self.create_folder(&parent, folder.file_name())?;
        }
        let ext = page.extension().unwrap_or("md");
        let target = folder.join(&format!("{}.{ext}", folder.file_name()))?;
        match self.rename(page, &target, rewrite_links) {
            Ok(out) => Ok((folder.clone(), target, out)),
            Err(e) => {
                if create {
                    self.drop_created_folder(folder);
                }
                Err(e)
            }
        }
    }

    /// Takes a folder this module just made away again, from disk and index.
    fn drop_created_folder(&self, folder: &VaultPath) {
        // Only ever an empty folder; one still holding a page stays indexed.
        if self.vault.remove_empty_dir(folder).is_ok() {
            if let Ok(mut index) = self.index() {
                let _ = index.transaction(|tx| tx.remove(folder.as_str()));
            }
        }
    }

    pub(crate) fn rename_with_hook(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        rewrite_links: bool,
        before_write: &dyn Fn(&VaultPath),
    ) -> Result<RenameOutcome> {
        check_target(from, to)?;
        let (plan, sources) = {
            let index = self.index()?;
            let stats = index.stats()?;
            if !stats.contains_key(from.as_str()) {
                return Err(SessionError::NotIndexed(from.to_string()));
            }
            let old_files = index.file_set()?;
            let moved: HashMap<String, String> = subtree_files(&stats, from)
                .into_iter()
                .map(|old| {
                    let new = VaultPath::new(&old)
                        .ok()
                        .and_then(|p| p.rebase(from, to))
                        .map(|p| p.to_string());
                    (old.clone(), new.unwrap_or(old))
                })
                .collect();
            let mut new_files = old_files.clone();
            for (old, new) in &moved {
                new_files.remove(old);
                new_files.insert(new.clone());
            }
            // Files whose links might change meaning: links into the moved
            // subtree, links whose key matches any moved name (old or new), and
            // the moved pages themselves (their folder changed).
            let mut keys: Vec<String> = moved
                .iter()
                .flat_map(|(o, n)| [link_key(o), link_key(n)])
                .collect();
            keys.sort();
            keys.dedup();
            let mut sources: BTreeSet<String> = BTreeSet::new();
            sources.extend(index.links_into(from.as_str())?.into_iter().map(|l| l.src));
            sources.extend(index.links_by_key(&keys)?.into_iter().map(|l| l.src));
            sources.extend(moved.keys().filter(|p| is_page_path(p)).cloned());
            (
                RenamePlan {
                    old_files,
                    new_files,
                    moved,
                },
                sources,
            )
        };

        self.vault.rename(from, to)?;
        self.index()?
            .transaction(|tx| tx.rename(from.as_str(), to.as_str()))?;
        self.retext_renamed(&[(from.to_string(), to.to_string())])?;
        self.follow_layout(&[(from.to_string(), to.to_string())]);

        let mut outcome = RenameOutcome {
            moved: {
                let mut m: Vec<_> = plan
                    .moved
                    .iter()
                    .map(|(o, n)| (o.clone(), n.clone()))
                    .collect();
                m.sort();
                m
            },
            ..RenameOutcome::default()
        };
        if rewrite_links {
            for src in &sources {
                let now = VaultPath::new(plan.map(src))?;
                match self.rewrite_file(&plan, &now, before_write) {
                    Ok(0) => {}
                    Ok(n) => {
                        outcome.updated_links += n;
                        outcome.updated_files.push(now.to_string());
                    }
                    Err(e) => outcome.failed.push((now.to_string(), e.to_string())),
                }
            }
        }

        // A page with no first-line H1 is titled by its file name: re-parse
        // the pages whose name changed, so the title and search follow
        // (M5 final review I1). Rewritten files were re-parsed already.
        for new in plan.moved.iter().filter_map(|(old, new)| {
            let renamed = is_page_path(new)
                && VaultPath::new(old).ok()?.stem() != VaultPath::new(new).ok()?.stem()
                && !outcome.updated_files.contains(new);
            renamed.then_some(new)
        }) {
            if let Err(e) = self.reparse(new) {
                self.emit(SessionEvent::Warning(format!("{new}: not re-indexed: {e}")));
            }
        }

        let mut index = self.index()?;
        let files = index.file_set()?;
        let keys: Vec<String> = plan
            .moved
            .iter()
            .flat_map(|(o, n)| [link_key(o), link_key(n)])
            .collect();
        index.resolve_affected(&files, &keys)?;
        for path in plan.moved.values().chain(outcome.updated_files.iter()) {
            index.resolve_from(&files, path)?;
        }
        Ok(outcome)
    }

    /// Reads `path` again and stores its page data.
    fn reparse(&self, path: &str) -> Result<()> {
        let Some(entry) = self.vault.stat(&VaultPath::new(path)?)? else {
            return Ok(());
        };
        let mut warnings = Vec::new();
        if let Some(loaded) = self.load(&entry, None, &mut warnings) {
            self.index()?.transaction(|tx| write_loaded(tx, &loaded))?;
        }
        Ok(())
    }

    /// Rewrites one file's links with compare-and-swap, re-reading and
    /// re-planning on conflict (max 3 attempts). Returns the number of edits.
    fn rewrite_file(
        &self,
        plan: &RenamePlan,
        path: &VaultPath,
        before_write: &dyn Fn(&VaultPath),
    ) -> Result<usize> {
        // Never replace a symlinked note with a plain file: its links are
        // updated through the real file instead (final review M1).
        let link = self.vault.meta(path, Follow::No);
        if link.is_ok_and(|m| m.is_some_and(|m| m.kind == Kind::Symlink)) {
            let (text, _) = self.vault.read_to_string(path)?;
            if plan.edits_for(path.as_str(), &text).is_empty() {
                return Ok(0);
            }
            return Err(SessionError::UnsafeRewrite(
                "symlinked note; edit the file it points to".to_string(),
            ));
        }
        let mut last = None;
        for _ in 0..MAX_ATTEMPTS {
            let (text, hash) = self.vault.read_to_string(path)?;
            let edits = checked_edits(plan.edits_for(path.as_str(), &text))
                .map_err(SessionError::UnsafeRewrite)?;
            if edits.is_empty() {
                return Ok(0);
            }
            let new_text = apply_edits(&text, &edits);
            plan.verify(path.as_str(), &text, &new_text)
                .map_err(SessionError::UnsafeRewrite)?;
            before_write(path);
            match self.vault.write_cas(path, new_text.as_bytes(), Some(hash)) {
                Ok(new_hash) => {
                    self.reindex_written(path, &new_text, new_hash)?;
                    return Ok(edits.len());
                }
                Err(e @ VaultError::Conflict { .. }) => last = Some(e),
                Err(e) => return Err(e.into()),
            }
        }
        Err(last.expect("loop ran").into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exp_04_overlapping_edits_are_refused_and_duplicates_merged() {
        let dup = vec![(8..13, "y".to_string()), (8..13, "y".to_string())];
        assert_eq!(checked_edits(dup).unwrap(), vec![(8..13, "y".to_string())]);
        let overlap = vec![(8..13, "y".to_string()), (10..20, "z".to_string())];
        assert!(checked_edits(overlap).is_err());
        let conflicting_same_range = vec![(8..13, "y".to_string()), (8..13, "z".to_string())];
        assert!(checked_edits(conflicting_same_range).is_err());
    }
    use crate::events::SessionEvent;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn session(fixture: &str) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
        let vault = liber_testkit::copy_fixture(fixture);
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
        (vault, cache, s)
    }

    fn vp(s: &str) -> VaultPath {
        VaultPath::new(s).unwrap()
    }

    /// Follow-up: a folder that can't be removed (not empty) stays in the
    /// index too, so a page left inside it after a failed undo stays found.
    #[test]
    fn subpages_followup_a_folder_left_on_disk_stays_indexed() {
        // Writes the page behind the session, on the plaintext tree.
        if liber_testkit::plain_disk_only() {
            return;
        }
        let (dir, _c, s) = session("ambiguous-names");
        s.create_folder(&VaultPath::root(), "P").unwrap();
        std::fs::write(dir.path().join("P/P.md"), "# P\n").unwrap();
        s.apply(vec![liber_vault::WatchEvent::Overflow]).unwrap();
        s.drop_created_folder(&vp("P"));
        assert!(dir.path().join("P/P.md").is_file());
        assert!(s.index().unwrap().stats().unwrap().contains_key("P/P.md"));
    }

    /// Follow-up: a conversion that can't be undone says so (a Warning), as
    /// the pair rollback in `rename` does, instead of failing silently.
    #[test]
    fn subpages_followup_a_failed_undo_warns() {
        let vault = liber_testkit::copy_fixture("ambiguous-names");
        let cache = tempfile::tempdir().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), move |e: SessionEvent| {
            sink.lock().unwrap().push(e)
        })
        .unwrap();
        s.undo_conversion(
            &vp("Gone/Gone.md"),
            &vp("Gone.md"),
            &vp("Gone"),
            false,
            true,
        );
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, SessionEvent::Warning(m) if m.contains("Gone/Gone.md"))),
            "no warning"
        );
    }

    #[test]
    fn apply_edits_from_the_end() {
        let text = "a [[x]] b [[y]]";
        assert_eq!(
            apply_edits(text, &[(4..5, "XX".into()), (12..13, "Y".into())]),
            "a [[XX]] b [[Y]]"
        );
    }

    #[test]
    fn exp_04_conflict_is_retried_with_fresh_content() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let (dir, _c, s) = session("ambiguous-names");
        let calls = AtomicUsize::new(0);
        let hook = |p: &VaultPath| {
            if p.as_str() == "Links.md" && calls.fetch_add(1, Ordering::SeqCst) == 0 {
                let full = dir.path().join("Links.md");
                let text = std::fs::read_to_string(&full).unwrap();
                std::fs::write(&full, format!("{text}- added by someone else [[Ideas]]\n"))
                    .unwrap();
            }
        };
        let out = s
            .rename_with_hook(&vp("Ideas.md"), &vp("Root Ideas.md"), true, &hook)
            .unwrap();
        assert!(out.failed.is_empty(), "{:?}", out.failed);
        let text = std::fs::read_to_string(dir.path().join("Links.md")).unwrap();
        assert!(
            text.contains("added by someone else [[Root Ideas]]"),
            "{text}"
        );
        assert!(text.starts_with("# Links\n\n- [[Root Ideas]]"), "{text}");
    }

    #[test]
    fn exp_04_persistent_conflict_is_reported_not_fatal() {
        if liber_testkit::plain_disk_only() {
            return;
        }
        let (dir, _c, s) = session("ambiguous-names");
        let hook = |p: &VaultPath| {
            if p.as_str() == "Links.md" {
                let full = dir.path().join("Links.md");
                let text = std::fs::read_to_string(&full).unwrap();
                std::fs::write(&full, format!("{text}x")).unwrap();
            }
        };
        let out = s
            .rename_with_hook(&vp("Ideas.md"), &vp("Root Ideas.md"), true, &hook)
            .unwrap();
        assert_eq!(out.failed.len(), 1);
        assert_eq!(out.failed[0].0, "Links.md");
        assert!(
            dir.path().join("Root Ideas.md").exists(),
            "the move itself succeeded"
        );
    }
}

/// Result of [`VaultSession::move_under_page`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveUnderOutcome {
    pub folder: VaultPath,
    /// The page after the move (`P/P.md` when it was converted).
    pub page: VaultPath,
    /// The page's own move, when it wasn't a folder page yet.
    pub converted: Option<RenameOutcome>,
    pub moved: RenameOutcome,
}

/// Whether a sibling folder found by name (any case) is the page's folder:
/// the exact name, or a case variant the disk treats as the same entry. On a
/// case-sensitive disk `notes/` stays a different folder from `Notes.md`'s.
fn reuse_folder(exact_name: bool, same_entry: bool) -> bool {
    exact_name || same_entry
}

/// What every rename refuses before it touches the disk.
fn check_target(from: &VaultPath, to: &VaultPath) -> Result<()> {
    if from.is_root() || to.is_root() || from == to {
        return Err(SessionError::InvalidName(format!(
            "cannot rename {from:?} to {to:?}"
        )));
    }
    if to.starts_with(from) {
        return Err(SessionError::InvalidName(format!(
            "cannot move {from} into itself"
        )));
    }
    if validate_name(to.file_name())? != to.file_name() {
        return Err(SessionError::InvalidName(to.to_string()));
    }
    // Nothing moves into `.git`, `.obsidian` or another hidden folder
    // (M5b final review I1); `.archive` is the Archive's own.
    if liber_vault::is_hidden_path(to.as_str()) {
        return Err(SessionError::InvalidName(to.to_string()));
    }
    Ok(())
}

/// The second rename that keeps a folder page and its folder together
/// (round 3b §6.1, §6.3), in paths that exist after the first rename. Only an
/// in-place rename pairs; a move to another folder never does.
fn paired_rename(
    from: &VaultPath,
    to: &VaultPath,
    is_folder: bool,
    // A folder's own page, whatever its letter case (round 3 §9).
    own_page: impl Fn(&VaultPath) -> Option<VaultPath>,
) -> Option<(VaultPath, VaultPath)> {
    if from.parent()? != to.parent()? {
        return None;
    }
    if is_folder {
        let page = own_page(from)?;
        let a = to.join(page.file_name()).ok()?;
        let b = to.join(&format!("{}.md", to.file_name())).ok()?;
        return (a != b).then_some((a, b));
    }
    let folder = from.parent()?;
    if folder.is_root()
        || from.extension() != Some("md")
        || to.extension() != Some("md")
        || own_page(&folder).as_ref() != Some(from)
    {
        return None;
    }
    let b = folder.parent()?.join(to.stem()).ok()?;
    // Matching the page name to its folder leaves the folder alone.
    (b != folder).then_some((folder, b))
}

#[cfg(test)]
mod pair_tests {
    use super::*;

    fn vp(s: &str) -> VaultPath {
        VaultPath::new(s).unwrap()
    }

    #[test]
    fn only_in_place_renames_pair() {
        let own = |f: &VaultPath| f.join(&format!("{}.md", f.file_name())).ok();
        assert_eq!(
            paired_rename(&vp("A/B/B.md"), &vp("A/B/C.md"), false, own),
            Some((vp("A/B"), vp("A/C")))
        );
        assert_eq!(paired_rename(&vp("B.md"), &vp("B/B.md"), false, own), None);
        assert_eq!(
            paired_rename(&vp("A/B.md"), &vp("A/C.md"), false, own),
            None
        );
        assert_eq!(
            paired_rename(&vp("B"), &vp("C"), true, own),
            Some((vp("C/B.md"), vp("C/C.md")))
        );
        assert_eq!(paired_rename(&vp("B"), &vp("C"), true, |_| None), None);
        assert_eq!(paired_rename(&vp("A/B"), &vp("C"), true, own), None);
        // A case-variant page pairs; matching its name to the folder doesn't.
        let variant = |f: &VaultPath| f.join("smartjob.md").ok();
        assert_eq!(
            paired_rename(&vp("SmartJob"), &vp("Work"), true, variant),
            Some((vp("Work/smartjob.md"), vp("Work/Work.md")))
        );
        assert_eq!(
            paired_rename(
                &vp("SmartJob/smartjob.md"),
                &vp("SmartJob/SmartJob.md"),
                false,
                variant
            ),
            None
        );
    }
}

#[cfg(test)]
mod review_tests {
    use super::reuse_folder;

    #[test]
    fn a_case_variant_folder_is_reused_only_when_the_disk_says_it_is_the_same() {
        assert!(reuse_folder(true, false)); // exact name
        assert!(reuse_folder(false, true)); // `notes/` on APFS or NTFS
        assert!(!reuse_folder(false, false)); // `notes/` on a case-sensitive disk
    }
}
