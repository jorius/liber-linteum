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
/// for anything else (a drive-relative `D:x` too) or a bare root.
fn windows_path(s: &str) -> Option<DiskPath> {
    let is_sep = |c: char| c == '\\' || c == '/';
    let bytes = s.as_bytes();
    let (root, rest) = if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        (s[..2].to_string(), &s[3..])
    } else if let Some(after) = s.strip_prefix(r"\\") {
        let mut parts = after.splitn(3, is_sep);
        let server = parts.next().filter(|p| !p.is_empty())?;
        let share = parts.next().filter(|p| !p.is_empty())?;
        (format!(r"\\{server}\{share}"), parts.next().unwrap_or(""))
    } else {
        return None;
    };
    let parts = normalize(rest.split(is_sep));
    if parts.is_empty() {
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
