use crate::error::{Result, SessionError};
use crate::events::RenameOutcome;
use crate::session::{VaultSession, is_page_path, subtree_files};
use nimw_markdown::{FileSet, LinkKind, link_key, parse_page, resolve, shortest_unique_target};
use nimw_vault::{VaultError, VaultPath};
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
            let path_style = matches!(link.kind, LinkKind::Markdown | LinkKind::MarkdownImage);
            if link.encoded || (path_style && !link.angle && new_text.contains(' ')) {
                new_text = utf8_percent_encode(&new_text, PATH_ENCODE).to_string();
            }
            if text[link.range.clone()] != new_text {
                edits.push((link.range, new_text));
            }
        }
        edits
    }
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
        self.rename_with_hook(from, to, rewrite_links, &|_| {})
    }

    pub(crate) fn rename_with_hook(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        rewrite_links: bool,
        before_write: &dyn Fn(&VaultPath),
    ) -> Result<RenameOutcome> {
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
        let (plan, sources) = {
            let index = self.index();
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
        self.index()
            .transaction(|tx| tx.rename(from.as_str(), to.as_str()))?;

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

        let mut index = self.index();
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

    /// Rewrites one file's links with compare-and-swap, re-reading and
    /// re-planning on conflict (max 3 attempts). Returns the number of edits.
    fn rewrite_file(
        &self,
        plan: &RenamePlan,
        path: &VaultPath,
        before_write: &dyn Fn(&VaultPath),
    ) -> Result<usize> {
        let mut last = None;
        for _ in 0..MAX_ATTEMPTS {
            let (text, hash) = self.vault.read_to_string(path)?;
            let edits = plan.edits_for(path.as_str(), &text);
            if edits.is_empty() {
                return Ok(0);
            }
            let new_text = apply_edits(&text, &edits);
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
    use crate::events::SessionEvent;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn session(fixture: &str) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
        let vault = nimw_testkit::copy_fixture(fixture);
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
        (vault, cache, s)
    }

    fn vp(s: &str) -> VaultPath {
        VaultPath::new(s).unwrap()
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
