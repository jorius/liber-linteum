use nimw_markdown::{LinkKind, Tag};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Page,
    Folder,
    Attachment,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Page => "page",
            FileKind::Folder => "folder",
            FileKind::Attachment => "attachment",
        }
    }

    pub fn parse(s: &str) -> FileKind {
        match s {
            "page" => FileKind::Page,
            "folder" => FileKind::Folder,
            _ => FileKind::Attachment,
        }
    }
}

/// One visible vault entry as stored in `files`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRow {
    pub path: String,
    pub kind: FileKind,
    pub mtime_ns: i64,
    pub size: u64,
    /// BLAKE3 hex; `None` for folders.
    pub hash: Option<String>,
}

/// Stored stat of a file, used to skip unchanged files on open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub kind: FileKind,
    pub mtime_ns: i64,
    pub size: u64,
    pub hash: Option<String>,
}

/// A file `[[` autocomplete can offer (M2c §7.2). `title` is set for pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkCandidate {
    pub path: String,
    pub kind: FileKind,
    pub title: Option<String>,
    pub mtime_ns: i64,
}

/// A file with the page data a Global View card shows (M3a §8). Page
/// columns are `None` for folders and attachments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardRow {
    pub path: String,
    pub parent: String,
    pub name: String,
    pub kind: FileKind,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    /// The frontmatter `cover:` value as written.
    pub cover: Option<String>,
    /// Where `cover:` resolves (`None`: no cover, remote or missing).
    pub cover_path: Option<String>,
    pub cover_y: Option<u8>,
    pub excerpt: Option<String>,
    pub has_image: bool,
    pub has_audio: bool,
}

/// A resolved link from one page to another page (Global View edges and
/// neighbourhoods, M3a §3, §6): text links, embeds of pages and `related:`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageLink {
    pub src: String,
    pub target: String,
    pub kind: LinkKind,
    pub label: Option<String>,
    pub directed: bool,
}

/// An explorer row (EXP-01). `title` is set for pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    pub path: String,
    pub parent: String,
    pub name: String,
    pub kind: FileKind,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRow {
    pub id: i64,
    pub src: String,
    pub kind: LinkKind,
    pub target_raw: String,
    pub target_key: String,
    pub target_path: Option<String>,
    pub heading: Option<String>,
    pub alias: Option<String>,
    pub start: usize,
    pub end: usize,
    pub encoded: bool,
    pub angle: bool,
    pub label: Option<String>,
    pub directed: bool,
}

/// A page with its tags and outgoing links (read-only page view, M1b).
#[derive(Debug, Clone, PartialEq)]
pub struct PageRow {
    pub path: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    pub cover_y: Option<u8>,
    pub excerpt: String,
    pub has_image: bool,
    pub has_audio: bool,
    pub frontmatter_error: Option<String>,
    pub tags: Vec<Tag>,
    pub links: Vec<LinkRow>,
}

/// `parent` and `name` columns for a vault path (`""` parent at the root).
pub(crate) fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

pub(crate) fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}
