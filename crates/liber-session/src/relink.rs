//! Existing attachment links brought to the vault's link format (v0.1.1). The
//! setting decides how a new attachment's link is written (M4b part 3 §8);
//! changing it can rewrite the links already in the vault the same way.
//!
//! Only the forms the setting writes are touched: wiki links and embeds, and
//! Markdown links whose destination is a `file:` URL. Each must find a file in
//! the vault that isn't a page. Other Markdown links, links to pages and links
//! that find nothing stay as they are, and so do archived pages.

use crate::error::{Result, SessionError};
use crate::rename::{apply_edits, checked_edits};
use crate::session::{VaultSession, is_page_path};
use liber_markdown::{ExternalTarget, FileSet, LinkKind, LinkRef, external_target, parse_page};
use liber_vault::{ARCHIVE_DIR, VaultError, VaultPath};
use std::ops::Range;
use std::path::Path;

const MAX_ATTEMPTS: usize = 3;

fn archived(first: &str) -> bool {
    first.eq_ignore_ascii_case(ARCHIVE_DIR)
}

/// What [`VaultSession::relink_attachments`] changed, or would change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelinkOutcome {
    /// Pages whose links changed (or would), sorted.
    pub updated_files: Vec<String>,
    pub updated_links: usize,
    /// Pages left unchanged because they couldn't be rewritten, with why.
    pub failed: Vec<(String, String)>,
}

/// A link label usable inside `[…]` or after `|`: no brackets or line breaks.
fn label(text: &str) -> String {
    text.replace(['[', ']', '\r', '\n'], " ").trim().to_string()
}

/// Obsidian's image size, `300` or `300x200`.
fn is_size(text: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mut parts = text.splitn(2, 'x');
    parts.next().is_some_and(digits) && parts.next().is_none_or(digits)
}

/// A Markdown link's text: between `[` (or `![`) and the `](` before its
/// destination.
fn markdown_text<'a>(text: &'a str, link: &LinkRef) -> &'a str {
    let open = link.span.start
        + if link.kind == LinkKind::MarkdownImage {
            2
        } else {
            1
        };
    let close = link.range.start - if link.angle { 3 } else { 2 };
    text.get(open..close).unwrap_or("")
}

impl VaultSession {
    /// Rewrites every attachment link in the vault to the vault's link format,
    /// as a new attachment's would be written; with `apply` false, only counts
    /// what would change. Each page is written with compare-and-swap, and only
    /// when every link still finds the same file afterwards.
    pub fn relink_attachments(&self, apply: bool) -> Result<RelinkOutcome> {
        let mut pages: Vec<String> = self
            .index()?
            .stats()?
            .into_keys()
            // Archived pages are read-only until unarchived (any letter case).
            .filter(|p| is_page_path(p) && !p.split('/').next().is_some_and(archived))
            .collect();
        pages.sort();
        let mut out = RelinkOutcome::default();
        for page in pages {
            let path = VaultPath::new(&page)?;
            match self.relink_page(&path, apply) {
                Ok(0) => {}
                Ok(n) => {
                    out.updated_links += n;
                    out.updated_files.push(page);
                }
                Err(e) => out.failed.push((page, e.to_string())),
            }
        }
        if apply && !out.updated_files.is_empty() {
            let mut index = self.index()?;
            let files = index.file_set()?;
            for page in &out.updated_files {
                index.resolve_from(&files, page)?;
            }
        }
        Ok(out)
    }

    /// One page's links (re-read and re-planned on a conflict); the number of
    /// links changed, or that would be.
    fn relink_page(&self, page: &VaultPath, apply: bool) -> Result<usize> {
        let mut last = None;
        for _ in 0..MAX_ATTEMPTS {
            let (text, hash) = self.vault.read_to_string(page)?;
            let edits = checked_edits(self.relink_edits(page, &text)?)
                .map_err(SessionError::UnsafeRewrite)?;
            if edits.is_empty() || !apply {
                return Ok(edits.len());
            }
            let new_text = apply_edits(&text, &edits);
            self.relink_verify(page, &text, &new_text)?;
            match self.vault.write_cas(page, new_text.as_bytes(), Some(hash)) {
                Ok(new_hash) => {
                    self.reindex_written(page, &new_text, new_hash)?;
                    return Ok(edits.len());
                }
                Err(e @ VaultError::Conflict { .. }) => last = Some(e),
                Err(e) => return Err(e.into()),
            }
        }
        Err(last.expect("loop ran").into())
    }

    /// The attachment `link` finds from `page`, if it is in a form the setting
    /// writes.
    fn attachment_target(
        &self,
        link: &LinkRef,
        page: &VaultPath,
        files: &FileSet,
    ) -> Option<VaultPath> {
        let found = match link.kind {
            LinkKind::Wiki | LinkKind::Embed => {
                liber_markdown::resolve(link.kind, &link.target, page.as_str(), files)?
            }
            LinkKind::Markdown | LinkKind::MarkdownImage => {
                let file_url = link.target.get(..5)?.eq_ignore_ascii_case("file:");
                let Some(ExternalTarget::Absolute(disk)) =
                    external_target(link.kind, &link.target, page.as_str()).filter(|_| file_url)
                else {
                    return None;
                };
                self.vault_path_of(Path::new(disk.as_str()))?.to_string()
            }
            _ => return None,
        };
        (!is_page_path(&found))
            .then(|| VaultPath::new(&found).ok())
            .flatten()
    }

    fn relink_edits(&self, page: &VaultPath, text: &str) -> Result<Vec<(Range<usize>, String)>> {
        let files = self.index()?.file_set()?;
        let mut edits = Vec::new();
        for link in parse_page(text, page.stem()).links {
            let Some(target) = self.attachment_target(&link, page, &files) else {
                continue;
            };
            let (wiki, url) = self.link_to(page, &target)?;
            let embed = matches!(link.kind, LinkKind::Embed | LinkKind::MarkdownImage);
            let bang = if embed { "!" } else { "" };
            let heading = link
                .heading
                .as_deref()
                .map(|h| format!("#{h}"))
                .unwrap_or_default();
            let edit = match (link.kind.is_wiki_style(), url) {
                // The same syntax: only the target changes; heading and alias stay.
                (true, None) => (link.range.clone(), wiki),
                (false, Some(url)) => (link.range.clone(), url),
                (true, Some(url)) => {
                    let text = match (&link.alias, embed) {
                        // An embed's size goes after the alt, Obsidian's
                        // `![|300](url)`, which sizes the image (0.1.2).
                        (Some(alias), true) if is_size(alias.trim()) => {
                            format!("|{}", alias.trim())
                        }
                        (Some(alias), _) => label(alias),
                        (None, true) => String::new(),
                        (None, false) => label(target.file_name()),
                    };
                    (link.span.clone(), format!("{bang}[{text}]({url}{heading})"))
                }
                (false, None) => {
                    let text = label(markdown_text(text, &link));
                    // `![alt|300](url)` keeps its size: a wiki embed holds one
                    // alias, and for an image that is the size (0.1.2).
                    let text = match text.rsplit_once('|') {
                        Some((_, size)) if embed && is_size(size.trim()) => size.trim().to_string(),
                        _ => text,
                    };
                    let alias = if text.is_empty() || (!embed && text == target.file_name()) {
                        String::new()
                    } else {
                        format!("|{text}")
                    };
                    (
                        link.span.clone(),
                        format!("{bang}[[{wiki}{heading}{alias}]]"),
                    )
                }
            };
            if text.get(edit.0.clone()) != Some(edit.1.as_str()) {
                edits.push(edit);
            }
        }
        Ok(edits)
    }

    /// The rewritten page has as many links, each of the same embed-ness, and
    /// every one that found an attachment finds the same one.
    fn relink_verify(&self, page: &VaultPath, old: &str, new: &str) -> Result<()> {
        let files = self.index()?.file_set()?;
        let before = parse_page(old, page.stem()).links;
        let after = parse_page(new, page.stem()).links;
        let embeds = |l: &LinkRef| matches!(l.kind, LinkKind::Embed | LinkKind::MarkdownImage);
        let unsafe_rewrite = |why: &str| Err(SessionError::UnsafeRewrite(why.to_string()));
        if before.len() != after.len() {
            return unsafe_rewrite("the rewrite would change the number of links");
        }
        for (b, a) in before.iter().zip(&after) {
            if embeds(b) != embeds(a) {
                return unsafe_rewrite("the rewrite would turn an embed into a link");
            }
            let Some(want) = self.attachment_target(b, page, &files) else {
                continue;
            };
            if self.attachment_target(a, page, &files).as_ref() != Some(&want) {
                return unsafe_rewrite(&format!("a link to {want} would stop finding it"));
            }
        }
        Ok(())
    }
}
