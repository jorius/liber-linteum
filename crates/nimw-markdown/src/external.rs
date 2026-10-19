//! Link targets naming a file outside the vault (M4b part 3 §9): absolute
//! Windows (`D:\…`, `\\server\share\…`) and POSIX (`/…`) paths, `file:` URLs
//! and relative paths that climb above the vault root. Pure and
//! host-independent: a Windows path is recognised on macOS too (it just
//! never exists there).

use crate::types::LinkKind;
use percent_encoding::percent_decode_str;

/// A normalised absolute path, in its own OS's form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiskPath {
    /// `D:\Docs\x.pdf` or `\\server\share\x.pdf` (backslashes, `.`/`..` resolved).
    Windows(String),
    /// `/Users/jose/x.png` (`.`/`..` resolved).
    Posix(String),
}

impl DiskPath {
    pub fn as_str(&self) -> &str {
        match self {
            DiskPath::Windows(s) | DiskPath::Posix(s) => s,
        }
    }
}

/// Where an external target points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalTarget {
    Absolute(DiskPath),
    /// Relative to the vault root: `up` folders above it, then `rest`.
    AboveRoot {
        up: usize,
        rest: Vec<String>,
    },
}

/// The external file a body link names, or `None` when the target is a vault
/// name or path (resolved by [`crate::resolve`]) or isn't a usable path.
/// A leading `/` is the vault root first for every kind (Obsidian), so the
/// caller only asks here once the vault has no such file.
pub fn external_target(kind: LinkKind, target: &str, source: &str) -> Option<ExternalTarget> {
    if !matches!(
        kind,
        LinkKind::Wiki | LinkKind::Embed | LinkKind::Markdown | LinkKind::MarkdownImage
    ) {
        return None;
    }
    let target = target.trim();
    if target.is_empty() || target.contains('\0') {
        return None;
    }
    if let Some(rest) = strip_file_scheme(target) {
        // Markdown destinations arrive %-decoded; wiki targets are as written.
        let rest = if kind.is_wiki_style() {
            percent_decode_str(rest).decode_utf8().ok()?.into_owned()
        } else {
            rest.to_string()
        };
        return file_url_path(&rest).map(ExternalTarget::Absolute);
    }
    if let Some(path) = windows_path(target) {
        return Some(ExternalTarget::Absolute(path));
    }
    if target.starts_with('/') {
        return posix_path(target).map(ExternalTarget::Absolute);
    }
    let relative = !kind.is_wiki_style() || target.starts_with("./") || target.starts_with("../");
    if relative {
        above_root(source, target)
    } else {
        None
    }
}

/// The computer a network path names: `\\server\share\…` (SMB or WebDAV;
/// also spelled `\\?\UNC\server\…`) or `/net/host/…` (macOS's automounter).
/// Merely looking such a path up connects to that computer — on Windows with
/// the user's credentials (final review C1) — so callers ask the user first.
pub fn network_server(path: &str) -> Option<&str> {
    fn first(rest: &str) -> Option<&str> {
        rest.split(['\\', '/']).next().filter(|s| !s.is_empty())
    }
    if let Some(after) = path.strip_prefix(r"\\") {
        let long_unc = after
            .get(..6)
            .is_some_and(|head| head.eq_ignore_ascii_case(r"?\UNC\"));
        return first(if long_unc { &after[6..] } else { after });
    }
    let after = path.strip_prefix('/')?;
    let (top, rest) = after.split_once('/')?;
    top.eq_ignore_ascii_case("net")
        .then(|| first(rest))
        .flatten()
}

/// A Windows reserved device name (`CON`, `NUL`, `COM1`…, with any
/// extension): in every folder it names a device, not a file.
fn reserved_device(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches([' ', ':'])
        .to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.len() == 4 && stem.starts_with(prefix) && matches!(stem.as_bytes()[3], b'1'..=b'9')
    };
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || numbered("COM")
        || numbered("LPT")
}

/// The rest of a `file:` URL (the scheme is case-insensitive).
fn strip_file_scheme(target: &str) -> Option<&str> {
    let head = target.get(..5)?;
    head.eq_ignore_ascii_case("file:").then(|| &target[5..])
}

/// The path of a `file:` URL's rest: `///D:/x`, `///Users/x`, `//localhost/x`,
/// `//server/share/x` (UNC) or `/Users/x`.
fn file_url_path(rest: &str) -> Option<DiskPath> {
    let local = match rest.strip_prefix("//") {
        Some(after) => {
            let (host, path) = match after.find('/') {
                Some(i) => (&after[..i], &after[i..]),
                None => (after, ""),
            };
            if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
                return windows_path(&format!(r"\\{host}{}", path.replace('/', r"\")));
            }
            path
        }
        None => rest,
    };
    let bytes = local.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        return windows_path(&local[1..]);
    }
    if local.starts_with('/') {
        posix_path(local)
    } else {
        None
    }
}

/// `D:\…`, `D:/…` or `\\server\share\…`, normalised with backslashes; `None`
/// for anything else (a drive-relative `D:x` too), a bare root, a device
/// namespace (`\\.\pipe\…`, `\\?\GLOBALROOT\…`) or a reserved device name.
/// The long forms `\\?\D:\…` and `\\?\UNC\server\…` are their short paths.
fn windows_path(s: &str) -> Option<DiskPath> {
    let is_sep = |c: char| c == '\\' || c == '/';
    let bytes = s.as_bytes();
    let (root, rest) = if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        (s[..2].to_string(), &s[3..])
    } else {
        let mut parts = s.strip_prefix(r"\\")?.splitn(3, is_sep);
        let server = parts.next().filter(|p| !p.is_empty())?;
        let share = parts.next().filter(|p| !p.is_empty())?;
        let rest = parts.next().unwrap_or("");
        match server {
            "." => return None,
            "?" => {
                let b = share.as_bytes();
                if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                    return windows_path(&format!(r"{share}\{rest}"));
                }
                if share.eq_ignore_ascii_case("UNC") {
                    return windows_path(&format!(r"\\{rest}"));
                }
                return None;
            }
            _ => {}
        }
        (format!(r"\\{server}\{share}"), rest)
    };
    let parts = normalize(rest.split(is_sep));
    if parts.is_empty() || parts.iter().any(|p| reserved_device(p)) {
        return None;
    }
    Some(DiskPath::Windows(format!(r"{root}\{}", parts.join(r"\"))))
}

/// `/…` normalised; `None` for the bare root.
fn posix_path(s: &str) -> Option<DiskPath> {
    let parts = normalize(s.split('/'));
    if parts.is_empty() {
        return None;
    }
    Some(DiskPath::Posix(format!("/{}", parts.join("/"))))
}

/// `.` and empty components dropped; `..` removes one (never above the root).
fn normalize<'a>(parts: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out = Vec::new();
    for part in parts {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            p => out.push(p),
        }
    }
    out
}

/// `target` relative to `source`'s folder, when it climbs above the vault
/// root; `None` while it stays inside (a vault path, missing or not).
fn above_root(source: &str, target: &str) -> Option<ExternalTarget> {
    let mut stack: Vec<String> = source
        .split('/')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    stack.pop(); // the page's own name
    let mut up = 0usize;
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if stack.pop().is_none() {
                    up += 1;
                }
            }
            p => stack.push(p.to_string()),
        }
    }
    (up > 0 && !stack.is_empty()).then_some(ExternalTarget::AboveRoot { up, rest: stack })
}

#[cfg(test)]
mod tests {
    use super::*;
    use LinkKind::*;

    fn win(s: &str) -> Option<ExternalTarget> {
        Some(ExternalTarget::Absolute(DiskPath::Windows(s.to_string())))
    }
    fn posix(s: &str) -> Option<ExternalTarget> {
        Some(ExternalTarget::Absolute(DiskPath::Posix(s.to_string())))
    }
    fn above(up: usize, rest: &[&str]) -> Option<ExternalTarget> {
        Some(ExternalTarget::AboveRoot {
            up,
            rest: rest.iter().map(|s| s.to_string()).collect(),
        })
    }

    #[test]
    fn windows_drive_paths_with_either_separator() {
        assert_eq!(
            external_target(Embed, r"D:\Docs\my-file.pdf", "a.md"),
            win(r"D:\Docs\my-file.pdf")
        );
        assert_eq!(
            external_target(Markdown, "d:/Docs/./x/../y.png", "a.md"),
            win(r"d:\Docs\y.png")
        );
        // `..` stops at the drive; a drive-relative path is not absolute.
        assert_eq!(
            external_target(Wiki, r"C:\..\..\x.txt", "a.md"),
            win(r"C:\x.txt")
        );
        assert_eq!(external_target(Embed, r"D:Docs\x.png", "a.md"), None);
    }

    #[test]
    fn unc_paths() {
        assert_eq!(
            external_target(Embed, r"\\server\share\Docs\x.pdf", "a.md"),
            win(r"\\server\share\Docs\x.pdf")
        );
        // The share is the root: `..` can't climb out of it.
        assert_eq!(
            external_target(Embed, r"\\server\share\..\..\x.pdf", "a.md"),
            win(r"\\server\share\x.pdf")
        );
        assert_eq!(external_target(Embed, r"\\server", "a.md"), None);
    }

    #[test]
    fn file_urls() {
        assert_eq!(
            external_target(MarkdownImage, "file:///D:/Docs/my file.pdf", "a.md"),
            win(r"D:\Docs\my file.pdf")
        );
        assert_eq!(
            external_target(Markdown, "FILE:///Users/jose/x.png", "a.md"),
            posix("/Users/jose/x.png")
        );
        assert_eq!(
            external_target(Markdown, "file://localhost/Users/jose/x.png", "a.md"),
            posix("/Users/jose/x.png")
        );
        assert_eq!(
            external_target(Markdown, "file://server/share/x.pdf", "a.md"),
            win(r"\\server\share\x.pdf")
        );
        assert_eq!(
            external_target(Markdown, "file:/Users/jose/x.png", "a.md"),
            posix("/Users/jose/x.png")
        );
        // Wiki targets are as written: their `file:` URLs are decoded here
        // (Markdown destinations arrive decoded already, so `%25` stays `%`).
        assert_eq!(
            external_target(Embed, "file:///Users/jose/a%20b.png", "a.md"),
            posix("/Users/jose/a b.png")
        );
        assert_eq!(
            external_target(Markdown, "file:///Users/jose/100%25.png", "a.md"),
            posix("/Users/jose/100%25.png")
        );
    }

    #[test]
    fn posix_absolute_paths() {
        assert_eq!(
            external_target(Embed, "/Users/jose/Pictures/../x.png", "a.md"),
            posix("/Users/jose/x.png")
        );
        assert_eq!(
            external_target(Markdown, "/../../etc/x", "a.md"),
            posix("/etc/x")
        );
        assert_eq!(external_target(Embed, "/", "a.md"), None);
    }

    #[test]
    fn relative_paths_above_the_vault_root() {
        // From a page at the root, `../` leaves the vault.
        assert_eq!(
            external_target(Markdown, "../Docs/x.pdf", "a.md"),
            above(1, &["Docs", "x.pdf"])
        );
        // From a nested page it takes more.
        assert_eq!(external_target(Markdown, "../x.png", "Notes/a.md"), None);
        assert_eq!(
            external_target(MarkdownImage, "../../../Pics/x.png", "Notes/Sub/a.md"),
            above(1, &["Pics", "x.png"])
        );
        // Wiki-style targets are relative only with `./` or `../`.
        assert_eq!(
            external_target(Embed, "../../x.png", "Notes/a.md"),
            above(1, &["x.png"])
        );
        assert_eq!(external_target(Embed, "./x.png", "Notes/a.md"), None);
        assert_eq!(external_target(Embed, "Pics/x.png", "Notes/a.md"), None);
        // Climbing out and back in is still outside the vault's link space.
        assert_eq!(
            external_target(Markdown, "../Vault/x.png", "a.md"),
            above(1, &["Vault", "x.png"])
        );
    }

    #[test]
    fn device_namespaces_and_reserved_names_are_never_paths() {
        // Opening one of these reaches a device or a pipe, not a file (final
        // review C1): never a link target.
        for t in [
            r"\\.\pipe\name",
            r"\\.\C:\x.png",
            r"\\?\GLOBALROOT\Device\x",
            r"\\?\Volume{1234}\x.png",
            "file://./pipe/x",
            "file://?/GLOBALROOT/x",
            r"C:\x\CON",
            r"C:\x\com1.txt",
            r"D:\aux.png",
            r"\\server\share\nul",
            r"D:\Docs\LPT9.log",
        ] {
            assert_eq!(external_target(Embed, t, "a.md"), None, "{t}");
        }
        // The long-path forms of a drive and of a share are those paths.
        assert_eq!(
            external_target(Embed, r"\\?\C:\Docs\x.pdf", "a.md"),
            win(r"C:\Docs\x.pdf")
        );
        assert_eq!(
            external_target(Embed, r"\\?\UNC\server\share\x.pdf", "a.md"),
            win(r"\\server\share\x.pdf")
        );
        // Names that only start like a device are files.
        assert_eq!(
            external_target(Embed, r"C:\x\console.png", "a.md"),
            win(r"C:\x\console.png")
        );
        assert_eq!(
            external_target(Embed, r"C:\x\COM10.txt", "a.md"),
            win(r"C:\x\COM10.txt")
        );
    }

    #[test]
    fn network_servers() {
        assert_eq!(network_server(r"\\Server\share\x.pdf"), Some("Server"));
        assert_eq!(network_server(r"\\?\UNC\nas\share\x"), Some("nas"));
        assert_eq!(network_server("/net/host/x.png"), Some("host"));
        assert_eq!(network_server("/NET/host/x.png"), Some("host"));
        assert_eq!(network_server(r"D:\Docs\x.pdf"), None);
        assert_eq!(network_server("/Users/jose/x.png"), None);
        assert_eq!(network_server("/net"), None);
        assert_eq!(network_server("/network/x"), None);
    }

    #[test]
    fn names_frontmatter_and_bad_input_are_not_external() {
        assert_eq!(external_target(Embed, "x.png", "a.md"), None);
        assert_eq!(external_target(Wiki, "Ideas", "a.md"), None);
        assert_eq!(external_target(FrontmatterCover, r"D:\x.png", "a.md"), None);
        assert_eq!(external_target(FrontmatterRelated, "/x.md", "a.md"), None);
        assert_eq!(external_target(Embed, "D:\\x\0.png", "a.md"), None);
        assert_eq!(
            external_target(Markdown, "https://x.example/a.png", "a.md"),
            None
        );
        assert_eq!(external_target(Markdown, "", "a.md"), None);
    }
}
