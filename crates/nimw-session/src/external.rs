//! Files outside the vault (M4b part 3 §9). A note may link or embed a file
//! anywhere on disk; the app shows or opens it only when some indexed page of
//! the open vault links to it (the allow-list), only a regular file, and never
//! one with a hidden component (`.ssh`, `.config`…) before or after symlinks.
//! Requests name the file by the absolute path this module computed for the
//! link, so a request is allowed exactly when it equals one.

use crate::error::{Result, SessionError};
use crate::session::VaultSession;
use nimw_markdown::{ExternalTarget, LinkKind, external_target, link_key, network_server, resolve};
use nimw_vault::{VaultError, VaultPath};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use std::path::{Component, Path, PathBuf};

/// What a link to a file outside the vault leads to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalFile {
    /// Absolute, in its OS's form (`D:\Docs\x.pdf`, `/Users/jose/x.png`).
    pub path: String,
    /// A regular, visible file on this computer. Only ever looked up for a
    /// listed path the app may reach (no existence oracle; final review C1).
    pub exists: bool,
    /// Linked from an indexed page: the app may show or open it.
    pub listed: bool,
    /// On another computer than the vault's (`\\server\…`, `/net/host/…`).
    pub network: bool,
    /// A network path the user hasn't loaded yet this session: nothing has
    /// touched it, and nothing will until they do (`allow_network`).
    pub ask_first: bool,
}

/// Whether reaching `path` connects to another computer than the one the
/// vault itself lives on (`root`): a share on the vault's own server is not.
pub(crate) fn foreign_network(root: &str, path: &str) -> bool {
    let Some(server) = network_server(path) else {
        return false;
    };
    !network_server(root).is_some_and(|own| own.eq_ignore_ascii_case(server))
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
    #[cfg(test)]
    tests::PROBES.with(|p| p.set(p.get() + 1));
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

    /// Whether `path` is on another computer than the vault's.
    fn on_network(&self, path: &str) -> bool {
        foreign_network(&self.vault.root().to_string_lossy(), path)
    }

    /// A network path the user hasn't loaded this session.
    fn ask_first(&self, path: &str) -> bool {
        self.on_network(path) && !self.network_loaded(path)
    }

    fn network_loaded(&self, path: &str) -> bool {
        self.network_ok
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(path)
    }

    /// For each target as seen from `source`: `None` when it is a vault file
    /// or name (resolved or missing), else the outside file it names.
    /// Markdown targets are as written (relative to `source`), like the index.
    /// Nothing is looked up on disk for a path no saved page links, nor for a
    /// network path the user hasn't loaded (final review C1).
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
            let listed = self.external_allowed(&path)?;
            let network = self.on_network(&path);
            let ask_first = network && !self.network_loaded(&path);
            out.push(Some(ExternalFile {
                exists: listed && !ask_first && checked_file(&path).is_ok(),
                listed,
                network,
                ask_first,
                path,
            }));
        }
        Ok(out)
    }

    /// The user chose to load the network file `path` (a "Network file"
    /// card's button): from now on, this session, it is looked up, shown and
    /// opened like any outside file. Only a path a saved page links.
    pub fn allow_network(&self, path: &str) -> Result<ExternalFile> {
        if !self.external_allowed(path)? {
            return Err(SessionError::NotPermitted(format!(
                "{path} is not linked from a page in this vault"
            )));
        }
        let network = self.on_network(path);
        if network {
            self.network_ok
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(path.to_string());
        }
        Ok(ExternalFile {
            exists: checked_file(path).is_ok(),
            listed: true,
            network,
            ask_first: false,
            path: path.to_string(),
        })
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
    /// allow-list and, on another computer, loaded by the user
    /// (`NotPermitted` otherwise), then `checked_file`.
    pub fn external_file(&self, path: &str) -> Result<PathBuf> {
        if !self.external_allowed(path)? {
            return Err(SessionError::NotPermitted(format!(
                "{path} is not linked from a page in this vault"
            )));
        }
        if self.ask_first(path) {
            return Err(SessionError::NotPermitted(format!(
                "{path} is on another computer: load it first"
            )));
        }
        checked_file(path)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::SessionEvent;
    use std::cell::Cell;

    thread_local! {
        /// Filesystem look-ups `checked_file` made on this thread.
        pub(crate) static PROBES: Cell<usize> = const { Cell::new(0) };
    }

    fn probes() -> usize {
        PROBES.with(Cell::get)
    }

    struct World {
        base: tempfile::TempDir,
        _cache: tempfile::TempDir,
        s: VaultSession,
    }

    /// A vault holding one page, `a.md`, with `text`.
    fn world(text: &str) -> World {
        let base = tempfile::Builder::new()
            .prefix("nimw-ext")
            .tempdir()
            .unwrap();
        std::fs::create_dir_all(base.path().join("Vault")).unwrap();
        std::fs::write(base.path().join("Vault/a.md"), text).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(
            &base.path().join("Vault"),
            cache.path(),
            |_: SessionEvent| {},
        )
        .unwrap();
        World {
            base,
            _cache: cache,
            s,
        }
    }

    fn ext(w: &World, kind: LinkKind, target: &str) -> Option<ExternalFile> {
        w.s.externals(
            &VaultPath::new("a.md").unwrap(),
            &[(kind, target.to_string())],
        )
        .unwrap()
        .remove(0)
    }

    const UNC: &str = r"\\attacker.example\s\x.png";

    #[test]
    fn network_paths_are_not_looked_up_until_the_user_loads_them() {
        let w = world(&format!(
            "# A\n\n![[{UNC}]] ![](file://nas.example/share/doc.pdf) ![](file:///net/host/x.png)\n"
        ));
        let before = probes();
        assert_eq!(
            ext(&w, LinkKind::Embed, UNC),
            Some(ExternalFile {
                path: UNC.to_string(),
                exists: false,
                listed: true,
                network: true,
                ask_first: true,
            })
        );
        for target in ["file://nas.example/share/doc.pdf", "file:///net/host/x.png"] {
            let got = ext(&w, LinkKind::MarkdownImage, target).unwrap();
            assert!(
                got.listed && got.network && got.ask_first && !got.exists,
                "{got:?}"
            );
        }
        assert!(matches!(
            w.s.external_file(UNC),
            Err(SessionError::NotPermitted(_))
        ));
        assert_eq!(probes(), before, "nothing reached the filesystem");
        // The user loads it: from now on it is looked up like any outside file.
        let loaded = w.s.allow_network(UNC).unwrap();
        assert!(
            loaded.network && !loaded.ask_first && loaded.listed,
            "{loaded:?}"
        );
        assert!(probes() > before);
        assert!(!ext(&w, LinkKind::Embed, UNC).unwrap().ask_first);
    }

    #[test]
    fn only_a_linked_network_path_can_be_loaded() {
        let w = world("# A\n");
        assert!(matches!(
            w.s.allow_network(UNC),
            Err(SessionError::NotPermitted(_))
        ));
        let before = probes();
        let got = ext(&w, LinkKind::Embed, UNC).unwrap();
        assert!(!got.listed && got.ask_first && !got.exists, "{got:?}");
        assert_eq!(probes(), before);
    }

    #[test]
    fn device_namespaces_are_not_outside_files() {
        let w = world("# A\n\n![[\\\\.\\pipe\\x]]\n");
        let before = probes();
        assert_eq!(ext(&w, LinkKind::Embed, r"\\.\pipe\x"), None);
        assert_eq!(ext(&w, LinkKind::Embed, r"\\?\GLOBALROOT\Device\x"), None);
        assert_eq!(probes(), before);
    }

    #[test]
    fn an_unlisted_path_is_not_looked_up() {
        // No existence oracle: only what a saved page links is checked.
        let w = world("# A\n");
        let outside = dunce::canonicalize(w.base.path()).unwrap().join("x.png");
        std::fs::write(&outside, b"\x89PNG").unwrap();
        let before = probes();
        let got = ext(&w, LinkKind::Embed, outside.to_str().unwrap()).unwrap();
        assert!(!got.listed && !got.exists && !got.network, "{got:?}");
        assert_eq!(probes(), before);
    }

    #[test]
    fn the_vaults_own_server_is_not_another_computer() {
        assert!(foreign_network(r"C:\Vault", r"\\nas\share\x.pdf"));
        assert!(foreign_network("/Users/jose/Vault", "/net/host/x.png"));
        assert!(!foreign_network(r"\\NAS\notes\Vault", r"\\nas\other\x.pdf"));
        assert!(!foreign_network(
            r"\\?\UNC\nas\notes\Vault",
            r"\\nas\other\x.pdf"
        ));
        assert!(foreign_network(
            r"\\nas\notes\Vault",
            r"\\elsewhere\s\x.pdf"
        ));
        assert!(!foreign_network(r"C:\Vault", r"D:\Docs\x.pdf"));
    }
}
