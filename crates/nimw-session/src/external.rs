//! Files outside the vault (M4b part 3 §9). A note may link or embed a file
//! anywhere on disk; the app shows or opens it only when some indexed page of
//! the open vault links to it (the allow-list), only a regular file, and never
//! one with a hidden component (`.ssh`, `.config`…) before or after symlinks.
//! Requests name the file by the absolute path this module computed for the
//! link, so a request is allowed exactly when it equals one.

use crate::error::{Result, SessionError};
use crate::session::VaultSession;
use nimw_markdown::{ExternalTarget, LinkKind, external_target, link_key, resolve};
use nimw_vault::{VaultError, VaultPath};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use std::path::{Component, Path, PathBuf};

/// What a link to a file outside the vault leads to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalFile {
    /// Absolute, in its OS's form (`D:\Docs\x.pdf`, `/Users/jose/x.png`).
    pub path: String,
    /// A regular, visible file on this computer.
    pub exists: bool,
    /// Linked from an indexed page: the app may show or open it.
    pub listed: bool,
}

/// Link kinds written in a page's body: the only ones that may name an
/// outside file (a `cover:` or `related:` can't).
const BODY_KINDS: [LinkKind; 4] = [
    LinkKind::Wiki,
    LinkKind::Embed,
    LinkKind::Markdown,
    LinkKind::MarkdownImage,
];

/// Characters %-encoded in a `file:` URL path (RFC 8089): what would end or
/// split a Markdown destination or a URL. Other UTF-8 stays as written.
const URL_PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'(')
    .add(b')')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b']')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'|');

/// `file:` URL for an absolute path in its OS's form: `D:\Docs\x` →
/// `file:///D:/Docs/x`, `\\server\share\x` → `file://server/share/x`,
/// `/Users/x` → `file:///Users/x`.
pub fn file_url(path: &str) -> String {
    let encode = |s: &str| {
        s.split(['/', '\\'])
            .map(|part| utf8_percent_encode(part, URL_PATH).to_string())
            .collect::<Vec<_>>()
            .join("/")
    };
    if let Some(unc) = path.strip_prefix(r"\\") {
        format!("file://{}", encode(unc))
    } else if path.starts_with('/') {
        format!("file://{}", encode(path))
    } else {
        format!("file:///{}", encode(path))
    }
}

/// `D:\…`, `D:/…` or `\\…`: a path in Windows' form.
fn is_windows_form(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with(r"\\")
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'\\' | b'/'))
}

/// `path` as a file on this computer: only the host's own form (a Windows path
/// on macOS is never read relative to the working directory), absolute, and
/// without `.`/`..` (requests must be spelled as the allow-list spells them).
fn host_path(path: &str) -> Option<PathBuf> {
    if is_windows_form(path) != cfg!(windows) {
        return None;
    }
    let p = PathBuf::from(path);
    let plain = p.is_absolute()
        && p.components()
            .all(|c| !matches!(c, Component::CurDir | Component::ParentDir));
    plain.then_some(p)
}

fn hidden(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

/// The checks every read or open goes through, after the allow-list: a
/// regular file on this computer, nothing hidden on its way (lexically, nor
/// once symlinks are followed). Returns the file's canonical path.
fn checked_file(path: &str) -> Result<PathBuf> {
    let not_found = || SessionError::Vault(VaultError::NotFound(path.to_string()));
    let host = host_path(path).ok_or_else(not_found)?;
    if hidden(&host) {
        return Err(SessionError::NotPermitted(format!("{path}: hidden")));
    }
    let real = dunce::canonicalize(&host).map_err(|_| not_found())?;
    if hidden(&real) {
        return Err(SessionError::NotPermitted(format!("{path}: hidden")));
    }
    let meta = std::fs::metadata(&real).map_err(|_| not_found())?;
    if !meta.is_file() {
        return Err(SessionError::NotAFile(path.to_string()));
    }
    Ok(real)
}

impl VaultSession {
    /// The absolute path a body link names when it points outside the vault,
    /// in its OS's form; `None` for vault names and paths.
    fn external_path(&self, kind: LinkKind, target: &str, source: &str) -> Option<String> {
        match external_target(kind, target, source)? {
            ExternalTarget::Absolute(path) => Some(path.as_str().to_string()),
            ExternalTarget::AboveRoot { up, rest } => {
                let mut base = self.vault.root().to_path_buf();
                for _ in 0..up {
                    if !base.pop() {
                        return None;
                    }
                }
                for part in &rest {
                    // A separator or drive inside one part would change the path's
                    // shape once joined (`a\..\b` on Windows).
                    if part.contains(['\\', ':']) {
                        return None;
                    }
                    base.push(part);
                }
                base.to_str().map(str::to_string)
            }
        }
    }

    /// For each target as seen from `source`: `None` when it is a vault file
    /// or name (resolved or missing), else the outside file it names.
    /// Markdown targets are as written (relative to `source`), like the index.
    pub fn externals(
        &self,
        source: &VaultPath,
        targets: &[(LinkKind, String)],
    ) -> Result<Vec<Option<ExternalFile>>> {
        let files = self.index().file_set()?;
        let mut out = Vec::with_capacity(targets.len());
        for (kind, target) in targets {
            if resolve(*kind, target, source.as_str(), &files).is_some() {
                out.push(None);
                continue;
            }
            let Some(path) = self.external_path(*kind, target, source.as_str()) else {
                out.push(None);
                continue;
            };
            out.push(Some(ExternalFile {
                exists: checked_file(&path).is_ok(),
                listed: self.external_allowed(&path)?,
                path,
            }));
        }
        Ok(out)
    }

    /// The allow-list: whether an indexed page links (in its body, unresolved
    /// in the vault) to exactly `path`.
    pub fn external_allowed(&self, path: &str) -> Result<bool> {
        let rows = self.index().links_by_key(&[link_key(path)])?;
        Ok(rows.iter().any(|row| {
            row.target_path.is_none()
                && BODY_KINDS.contains(&row.kind)
                && self
                    .external_path(row.kind, &row.target_raw, &row.src)
                    .as_deref()
                    == Some(path)
        }))
    }

    /// The vault file at the absolute `path` (symlinks followed), if it is one
    /// the vault knows (§7: a picked file already in the vault is linked, not
    /// copied).
    pub fn vault_path_of(&self, path: &Path) -> Option<VaultPath> {
        let real = dunce::canonicalize(path).ok()?;
        let inside = VaultPath::from_fs_path(self.vault.root(), &real).ok()?;
        (!inside.is_root() && self.vault.stat(&inside).ok()?.is_some()).then_some(inside)
    }

    /// The outside file `path` when the app may read or open it: on the
    /// allow-list (`NotPermitted` otherwise), then `checked_file`.
    pub fn external_file(&self, path: &str) -> Result<PathBuf> {
        if !self.external_allowed(path)? {
            return Err(SessionError::NotPermitted(format!(
                "{path} is not linked from a page in this vault"
            )));
        }
        checked_file(path)
    }
}
