use crate::types::LinkKind;
use percent_encoding::percent_decode_str;
use std::collections::{BTreeSet, HashMap};
use unicode_normalization::UnicodeNormalization;

/// Matching key: Unicode NFC + lowercase (PG-05; paths themselves are kept as on disk).
pub fn name_key(s: &str) -> String {
    s.nfc().collect::<String>().to_lowercase()
}

/// Key shared by link targets and file paths: NFC-lowercased base name without
/// a trailing `.md`. A file can only satisfy links whose target has its key, so
/// creates/removes/renames only re-resolve links with these keys. The base name
/// follows `\` too, so a Windows path outside the vault (`D:\Docs\x.pdf`) is
/// keyed by its file name like everything else (M4b part 3 §9).
pub fn link_key(target_or_path: &str) -> String {
    // A wiki `file:` URL is keyed decoded, as the path it names.
    let decoded;
    let target_or_path = match target_or_path.get(..5) {
        Some(head) if head.eq_ignore_ascii_case("file:") => {
            decoded = percent_decode_str(target_or_path).decode_utf8_lossy();
            decoded.as_ref()
        }
        _ => target_or_path,
    };
    let base = target_or_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(target_or_path);
    let key = name_key(base);
    match key.strip_suffix(".md") {
        Some(stem) if !stem.is_empty() => stem.to_string(),
        _ => key,
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn dir_of(path: &str) -> &str {
    path.rfind('/').map(|i| &path[..i]).unwrap_or("")
}

/// All vault file paths (pages and attachments), indexed for resolution.
#[derive(Debug, Clone, Default)]
pub struct FileSet {
    paths: BTreeSet<String>,
    by_key: HashMap<String, Vec<String>>,
    by_name: HashMap<String, Vec<String>>,
}

impl FileSet {
    pub fn new<I: IntoIterator<Item = String>>(paths: I) -> FileSet {
        let mut set = FileSet::default();
        for p in paths {
            set.insert(p);
        }
        set
    }

    pub fn insert(&mut self, path: String) {
        if self.paths.insert(path.clone()) {
            self.by_key
                .entry(name_key(&path))
                .or_default()
                .push(path.clone());
            self.by_name
                .entry(name_key(basename(&path)))
                .or_default()
                .push(path);
        }
    }

    pub fn remove(&mut self, path: &str) {
        if self.paths.remove(path) {
            for map_key in [name_key(path), name_key(basename(path))] {
                for map in [&mut self.by_key, &mut self.by_name] {
                    if let Some(v) = map.get_mut(&map_key) {
                        v.retain(|p| p != path);
                        if v.is_empty() {
                            map.remove(&map_key);
                        }
                    }
                }
            }
        }
    }

    pub fn contains(&self, path: &str) -> bool {
        self.paths.contains(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = &String> {
        self.paths.iter()
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    fn exact(&self, path: &str) -> Option<&String> {
        let hits = self.by_key.get(&name_key(path))?;
        hits.iter()
            .find(|p| p.as_str() == path)
            .or_else(|| hits.first())
    }
}

/// Joins `rel` onto `base_dir`, resolving `.` and `..`; `None` if it escapes the vault.
pub fn normalize_join(base_dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') || base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Candidate file names for a wiki-style target: `X` means `X.md` first, then `X` itself.
fn wiki_candidates(target: &str) -> Vec<String> {
    if target.to_lowercase().ends_with(".md") {
        vec![target.to_string()]
    } else {
        vec![format!("{target}.md"), target.to_string()]
    }
}

/// Resolves a link target to a vault path (PG-05, spec §4.4).
pub fn resolve(kind: LinkKind, target: &str, source: &str, files: &FileSet) -> Option<String> {
    let source_dir = dir_of(source);
    if !kind.is_wiki_style() {
        let joined = normalize_join(source_dir, target)?;
        return files
            .exact(&joined)
            .or_else(|| {
                if basename(&joined).contains('.') {
                    None
                } else {
                    files.exact(&format!("{joined}.md"))
                }
            })
            .cloned();
    }
    if let Some(rooted) = target.strip_prefix('/') {
        // `[[/Name]]`: vault-root path only (used when no suffix is unique).
        return wiki_candidates(rooted)
            .iter()
            .find_map(|c| files.exact(c))
            .cloned();
    }
    for cand in wiki_candidates(target) {
        // A target with `/` is a path: exact vault path, then relative to the
        // source folder. Bare names go straight to the name search below so the
        // same-folder tie-break applies.
        if cand.contains('/') {
            if let Some(hit) = files.exact(&cand) {
                return Some(hit.clone());
            }
            if let Some(rel) = normalize_join(source_dir, &cand)
                && let Some(hit) = files.exact(&rel)
            {
                return Some(hit.clone());
            }
        }
        let key = name_key(&cand);
        let suffix = format!("/{key}");
        let mut matches: Vec<&String> = files
            .by_name
            .get(&name_key(basename(&cand)))
            .map(|v| {
                v.iter()
                    .filter(|p| {
                        let k = name_key(p);
                        k == key || k.ends_with(&suffix)
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !matches.is_empty() {
            // Same folder as the source first, then fewest components, then path order.
            matches.sort_by_key(|p| (dir_of(p) != source_dir, p.matches('/').count(), p.as_str()));
            return Some(matches[0].clone());
        }
    }
    None
}

/// The text to write so that a link of `kind` from `source` points at
/// `target_path` (spec §4.4.5). Wiki-style: the shortest path suffix (without
/// `.md` for pages) that still resolves to exactly `target_path`, or the
/// vault-rooted `/path` when no suffix is unique (a same-folder file shadows a
/// root file). Path-style: relative to the source folder, or `/`-rooted when `rooted`.
pub fn shortest_unique_target(
    target_path: &str,
    source: &str,
    files: &FileSet,
    kind: LinkKind,
    rooted: bool,
) -> String {
    if !kind.is_wiki_style() {
        if rooted {
            return format!("/{target_path}");
        }
        return relative_path(dir_of(source), target_path);
    }
    let display = if target_path.to_lowercase().ends_with(".md") {
        &target_path[..target_path.len() - 3]
    } else {
        target_path
    };
    let parts: Vec<&str> = display.split('/').collect();
    for take in 1..=parts.len() {
        let candidate = parts[parts.len() - take..].join("/");
        if resolve(kind, &candidate, source, files).as_deref() == Some(target_path) {
            return candidate;
        }
    }
    format!("/{display}")
}

fn relative_path(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use LinkKind::*;

    fn set(paths: &[&str]) -> FileSet {
        FileSet::new(paths.iter().map(|s| s.to_string()))
    }

    fn ambiguous() -> FileSet {
        set(&[
            "Ideas.md",
            "Projects/Ideas.md",
            "Projects/Deep/Ideas.md",
            "Archive/Old/Ideas.md",
            "Links.md",
            "Projects/Other.md",
            "Elsewhere/Note.md",
        ])
    }

    #[test]
    fn pg_05_resolution_order_and_tie_breaks() {
        let f = ambiguous();
        let r = |t: &str, src: &str| resolve(Wiki, t, src, &f);
        assert_eq!(r("Ideas", "Links.md").as_deref(), Some("Ideas.md"));
        assert_eq!(
            r("Ideas", "Projects/Other.md").as_deref(),
            Some("Projects/Ideas.md"),
            "same folder wins"
        );
        assert_eq!(
            r("Ideas", "Elsewhere/Note.md").as_deref(),
            Some("Ideas.md"),
            "fewest components"
        );
        assert_eq!(
            r("Projects/Ideas", "Links.md").as_deref(),
            Some("Projects/Ideas.md"),
            "exact path"
        );
        assert_eq!(
            r("Deep/Ideas", "Links.md").as_deref(),
            Some("Projects/Deep/Ideas.md"),
            "suffix"
        );
        assert_eq!(
            r("Deep/Ideas", "Projects/Other.md").as_deref(),
            Some("Projects/Deep/Ideas.md"),
            "relative"
        );
        assert_eq!(r("Nope", "Links.md"), None);
    }

    #[test]
    fn pg_05_case_and_unicode_insensitive_matching() {
        let f = set(&[
            "unicode/Café ñandú 🎨.md",
            "Notes/v1.2 plan.md",
            "img/Photo.PNG",
        ]);
        assert_eq!(
            resolve(Wiki, "CAFÉ ÑANDÚ 🎨", "x.md", &f).as_deref(),
            Some("unicode/Café ñandú 🎨.md")
        );
        assert_eq!(
            resolve(Wiki, "cafe\u{301} n\u{303}andu\u{301} 🎨", "x.md", &f).as_deref(),
            Some("unicode/Café ñandú 🎨.md"),
            "NFD typed"
        );
        assert_eq!(
            resolve(Wiki, "v1.2 plan", "x.md", &f).as_deref(),
            Some("Notes/v1.2 plan.md"),
            "dots are not extensions"
        );
        assert_eq!(
            resolve(Embed, "photo.png", "x.md", &f).as_deref(),
            Some("img/Photo.PNG")
        );
    }

    #[test]
    fn pg_05_markdown_links_are_path_relative() {
        let f = set(&[
            "Character Design/DMC/Sparda.md",
            "Game Design/Game 1.md",
            "a.md",
        ]);
        let src = "Character Design/rex-draft.md";
        assert_eq!(
            resolve(Markdown, "DMC/Sparda.md", src, &f).as_deref(),
            Some("Character Design/DMC/Sparda.md")
        );
        assert_eq!(
            resolve(Markdown, "../Game Design/Game 1.md", src, &f).as_deref(),
            Some("Game Design/Game 1.md")
        );
        assert_eq!(
            resolve(Markdown, "/Game Design/Game 1.md", src, &f).as_deref(),
            Some("Game Design/Game 1.md")
        );
        assert_eq!(
            resolve(Markdown, "Sparda.md", src, &f),
            None,
            "no name search for path links"
        );
        assert_eq!(
            resolve(Markdown, "../../../a.md", src, &f),
            None,
            "escaping the vault"
        );
        assert_eq!(
            resolve(FrontmatterCover, "../a", src, &f).as_deref(),
            Some("a.md")
        );
    }

    #[test]
    fn pg_05_shortest_unique_target() {
        let f = ambiguous();
        assert_eq!(
            shortest_unique_target("Ideas.md", "Links.md", &f, Wiki, false),
            "Ideas"
        );
        assert_eq!(
            shortest_unique_target("Projects/Ideas.md", "Links.md", &f, Wiki, false),
            "Projects/Ideas"
        );
        assert_eq!(
            shortest_unique_target("Projects/Ideas.md", "Projects/Other.md", &f, Wiki, false),
            "Ideas"
        );
        assert_eq!(
            shortest_unique_target("Projects/Deep/Ideas.md", "Links.md", &f, Wiki, false),
            "Deep/Ideas"
        );
        assert_eq!(
            shortest_unique_target("img/x.png", "a.md", &set(&["img/x.png"]), Embed, false),
            "x.png"
        );
        assert_eq!(
            shortest_unique_target(
                "Game Design/Game 1.md",
                "Character Design/rex.md",
                &f,
                Markdown,
                false
            ),
            "../Game Design/Game 1.md"
        );
        assert_eq!(
            shortest_unique_target(
                "Game Design/Game 1.md",
                "Character Design/rex.md",
                &f,
                Markdown,
                true
            ),
            "/Game Design/Game 1.md"
        );
        assert_eq!(
            shortest_unique_target("A/B/c.md", "A/x.md", &f, Markdown, false),
            "B/c.md"
        );
        let shadowed = set(&["Ideas.md", "Elsewhere/Ideas.md", "Elsewhere/Note.md"]);
        assert_eq!(
            shortest_unique_target("Ideas.md", "Elsewhere/Note.md", &shadowed, Wiki, false),
            "/Ideas"
        );
        assert_eq!(
            resolve(Wiki, "/Ideas", "Elsewhere/Note.md", &shadowed).as_deref(),
            Some("Ideas.md")
        );
        assert_eq!(resolve(Wiki, "/Nope", "Elsewhere/Note.md", &shadowed), None);
    }

    #[test]
    fn link_key_matches_targets_and_paths() {
        assert_eq!(link_key("Projects/Ideas.md"), "ideas");
        assert_eq!(link_key("Deep/IDEAS"), "ideas");
        assert_eq!(link_key("img/Photo.PNG"), "photo.png");
        assert_eq!(link_key("Cafe\u{301}"), link_key("café.md"));
        assert_eq!(link_key(".md"), ".md");
        // M4b part 3 §9: Windows paths are keyed by their file name too, so the
        // allow-list finds the links that name a file outside the vault.
        assert_eq!(link_key(r"D:\Docs\My-File.pdf"), "my-file.pdf");
        assert_eq!(link_key("file:///D:/Docs/x.pdf"), "x.pdf");
        assert_eq!(link_key("file:///D:/Docs/a%20b.pdf"), "a b.pdf");
    }

    #[test]
    fn fileset_insert_remove() {
        let mut f = set(&["a/Ideas.md"]);
        f.insert("Ideas.md".into());
        assert_eq!(
            resolve(Wiki, "ideas", "z.md", &f).as_deref(),
            Some("Ideas.md")
        );
        f.remove("Ideas.md");
        assert_eq!(
            resolve(Wiki, "ideas", "z.md", &f).as_deref(),
            Some("a/Ideas.md")
        );
        assert_eq!(f.len(), 1);
        assert!(f.contains("a/Ideas.md"));
    }
}
