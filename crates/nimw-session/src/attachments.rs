//! M2c §5 and §7.1–7.2: files saved or imported for a page (pasted images,
//! dropped files, covers), NIMW's attachment setting and `[[` suggestions.

use crate::error::{Result, SessionError};
use crate::session::{
    FORBIDDEN_NAME_CHARS, VaultSession, clamp_ns, folder_row, is_page_path, validate_name,
};
use nimw_index::{FileKind, FileRow, LinkCandidate};
use nimw_markdown::{LinkKind, link_key, name_key, shortest_unique_target};
use nimw_vault::{AttachmentConfig, Hash, VaultError, VaultPath};
use std::path::Path;

/// A file saved into (or found in) the vault for a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attached {
    pub path: VaultPath,
    /// Wiki-style target that resolves from the page back to `path`.
    pub link: String,
    /// `false` when the dropped file already lived in the vault.
    pub copied: bool,
}

/// One `[[` / `![[` suggestion (M2c §7.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSuggestion {
    pub path: String,
    pub kind: FileKind,
    /// Pages only: the page's title (first H1, else the file name).
    pub title: Option<String>,
    /// What to write between `[[` and `]]` (shortest unique path).
    pub target: String,
}

/// A name usable in the vault: characters `validate_name` refuses become `-`,
/// leading dots too (no hidden files); empty becomes `file` (M2c §5.3).
pub fn sanitize_file_name(name: &str) -> String {
    let mut out: String = name
        .trim()
        .chars()
        .map(|c| {
            if FORBIDDEN_NAME_CHARS.contains(&c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    if out.starts_with('.') {
        out.replace_range(..1, "-");
    }
    if out.trim().is_empty() {
        out = "file".to_string();
    }
    out
}

/// Frontmatter `cover:` value for `file` on `page` (M2c §2): relative to the
/// page's folder when the file is inside it, else vault-rooted (`/…`).
pub fn cover_reference(page: &VaultPath, file: &VaultPath) -> String {
    let here = page.parent().unwrap_or_else(VaultPath::root);
    if here.is_root() {
        return file.to_string();
    }
    if file.starts_with(&here) && file != &here {
        return file.as_str()[here.as_str().len() + 1..].to_string();
    }
    format!("/{file}")
}

fn split_ext(name: &str) -> (&str, Option<&str>) {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => (&name[..i], Some(&name[i + 1..])),
        _ => (name, None),
    }
}

impl VaultSession {
    /// Saves pasted bytes as `name` in the page's attachment folder.
    pub fn save_attachment(&self, page: &VaultPath, name: &str, bytes: &[u8]) -> Result<Attached> {
        self.place(page, name, |dest| self.vault.write_cas(dest, bytes, None))
    }

    /// Copies the outside file `src` into the page's attachment folder; a file
    /// already inside the vault is only linked. Folders are refused.
    pub fn import_attachment(&self, page: &VaultPath, src: &Path) -> Result<Attached> {
        let shown = src.display().to_string();
        let meta = std::fs::metadata(src).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                SessionError::Vault(VaultError::NotFound(shown.clone()))
            }
            _ => SessionError::Vault(VaultError::Io {
                path: shown.clone(),
                source: e,
            }),
        })?;
        if !meta.is_file() {
            return Err(SessionError::NotAFile(shown));
        }
        let real = dunce::canonicalize(src).map_err(|e| {
            SessionError::Vault(VaultError::Io {
                path: shown.clone(),
                source: e,
            })
        })?;
        if let Ok(inside) = VaultPath::from_fs_path(self.vault.root(), &real)
            && self.vault.stat(&inside)?.is_some()
        {
            let link = self.link_to(page, &inside)?;
            return Ok(Attached {
                path: inside,
                link,
                copied: false,
            });
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.place(page, &name, |dest| self.vault.import_file(&real, dest))
    }

    /// NIMW's attachment setting and Obsidian's (which wins when present).
    pub fn attachment_settings(&self) -> AttachmentConfig {
        self.vault.attachment_config()
    }

    /// Stores NIMW's attachment setting. Refused while Obsidian's applies.
    pub fn set_attachment_settings(&self, mode: &str, path: &str) -> Result<()> {
        if self.vault.attachment_config().obsidian.is_some() {
            return Err(SessionError::NotPermitted(
                "attachments are set by Obsidian (.obsidian/app.json)".into(),
            ));
        }
        let path = path.trim().trim_matches('/');
        match mode {
            "subfolder" => {
                validate_name(path)?;
            }
            "folder" => {
                for part in path.split('/') {
                    validate_name(part)?;
                }
            }
            _ => {}
        }
        self.vault.set_nimw_attachments(mode, path)?;
        Ok(())
    }

    /// Up to `limit` files matching `query` by name, title or path, best first
    /// (M2c §6): exact, prefix, word start, substring, then subsequence; ties
    /// prefer pages (attachments for embeds), shorter paths, newer files. An
    /// empty query lists the most recently modified files.
    pub fn link_suggest(
        &self,
        source: &VaultPath,
        query: &str,
        embed: bool,
        limit: usize,
    ) -> Result<Vec<LinkSuggestion>> {
        let (candidates, files) = {
            let index = self.index();
            (index.link_candidates()?, index.file_set()?)
        };
        let q = name_key(query.trim());
        // Pages first for `[[`, attachments first for `![[`.
        let preferred = |c: &LinkCandidate| (c.kind == FileKind::Page) != embed;
        let mut scored: Vec<(u8, &LinkCandidate)> = candidates
            .iter()
            .filter_map(|c| score(&q, c).map(|s| (s, c)))
            .collect();
        scored.sort_by(|(sa, a), (sb, b)| {
            sb.cmp(sa)
                .then_with(|| preferred(b).cmp(&preferred(a)))
                .then_with(|| {
                    if q.is_empty() {
                        std::cmp::Ordering::Equal
                    } else {
                        a.path.len().cmp(&b.path.len())
                    }
                })
                .then_with(|| b.mtime_ns.cmp(&a.mtime_ns))
                .then_with(|| a.path.cmp(&b.path))
        });
        let kind = if embed {
            LinkKind::Embed
        } else {
            LinkKind::Wiki
        };
        Ok(scored
            .into_iter()
            .take(limit)
            .map(|(_, c)| LinkSuggestion {
                path: c.path.clone(),
                kind: c.kind,
                title: c.title.clone(),
                target: shortest_unique_target(&c.path, source.as_str(), &files, kind, false),
            })
            .collect())
    }

    /// Creates the attachment folder, writes under the first free name
    /// (`name`, `name 1`, …), indexes the result and links it from `page`.
    fn place(
        &self,
        page: &VaultPath,
        name: &str,
        write: impl Fn(&VaultPath) -> nimw_vault::Result<Hash>,
    ) -> Result<Attached> {
        let dir = self.vault.attachment_policy().dir_for(page)?;
        for folder in self.vault.create_dir_all(&dir)? {
            if let Some(entry) = self.vault.stat(&folder)? {
                self.index()
                    .transaction(|tx| tx.upsert_file(&folder_row(&entry)))?;
            }
        }
        let name = sanitize_file_name(name);
        let (stem, ext) = split_ext(&name);
        for n in 0u32.. {
            let candidate = match (n, ext) {
                (0, _) => name.clone(),
                (n, Some(ext)) => format!("{stem} {n}.{ext}"),
                (n, None) => format!("{stem} {n}"),
            };
            let path = dir.join(&candidate)?;
            match write(&path) {
                Ok(hash) => {
                    self.index_new_file(&path, hash)?;
                    let link = self.link_to(page, &path)?;
                    return Ok(Attached {
                        path,
                        link,
                        copied: true,
                    });
                }
                Err(VaultError::AlreadyExists(_)) => continue,
                Err(e) => return Err(e.into()),
            }
        }
        unreachable!("the loop only ends by returning")
    }

    /// Indexes a file the session just created (pages are parsed) and
    /// re-resolves links that may now point at it. Files hidden by an exclude
    /// glob are left out of the index.
    fn index_new_file(&self, path: &VaultPath, hash: Hash) -> Result<()> {
        let Some(entry) = self.vault.stat(path)? else {
            return Ok(());
        };
        if is_page_path(path.as_str())
            && let Ok((text, _)) = self.vault.read_to_string(path)
        {
            self.reindex_written(path, &text, hash)?;
        } else {
            let row = FileRow {
                path: path.to_string(),
                kind: FileKind::Attachment,
                mtime_ns: clamp_ns(entry.mtime_ns),
                size: entry.size,
                hash: Some(hash.to_hex()),
            };
            self.index().transaction(|tx| tx.upsert_file(&row))?;
        }
        let mut index = self.index();
        let files = index.file_set()?;
        index.resolve_affected(&files, &[link_key(path.as_str())])?;
        Ok(())
    }

    fn link_to(&self, page: &VaultPath, path: &VaultPath) -> Result<String> {
        let files = self.index().file_set()?;
        Ok(shortest_unique_target(
            path.as_str(),
            page.as_str(),
            &files,
            LinkKind::Embed,
            false,
        ))
    }
}

/// Best match of `q` (already `name_key`ed) against a candidate's name, title
/// and path: 5 exact, 4 prefix, 3 word start, 2 substring, 1 subsequence.
fn score(q: &str, c: &LinkCandidate) -> Option<u8> {
    if q.is_empty() {
        return Some(0);
    }
    let base = c.path.rsplit('/').next().unwrap_or(&c.path);
    let strip_md = |s: &str| -> String {
        if c.kind == FileKind::Page && s.to_lowercase().ends_with(".md") {
            s[..s.len() - 3].to_string()
        } else {
            s.to_string()
        }
    };
    let name = name_key(&strip_md(base));
    let title = c.title.as_deref().map(name_key);
    let path = name_key(&strip_md(&c.path));
    let mut best = None;
    for (field, subsequence) in [(Some(name), true), (title, true), (Some(path), false)] {
        let Some(field) = field else { continue };
        let s = field_score(q, &field, subsequence);
        best = best.max(s);
    }
    best
}

fn field_score(q: &str, field: &str, subsequence: bool) -> Option<u8> {
    if field == q {
        return Some(5);
    }
    if field.starts_with(q) {
        return Some(4);
    }
    let word_start = field.match_indices(q).any(|(i, _)| {
        field[..i]
            .chars()
            .next_back()
            .is_some_and(|c| matches!(c, ' ' | '-' | '_' | '/' | '.' | '('))
    });
    if word_start {
        return Some(3);
    }
    if field.contains(q) {
        return Some(2);
    }
    if subsequence {
        let mut rest = field.chars();
        if q.chars().all(|qc| rest.any(|fc| fc == qc)) {
            return Some(1);
        }
    }
    None
}
