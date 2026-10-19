use std::ops::Range;
use unicode_normalization::UnicodeNormalization;

/// Everything the index needs from one Markdown page.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageMeta {
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    pub cover_y: Option<u8>,
    /// `cover-x` (0–100): a side cover's horizontal focus (M4b part 3 §3).
    pub cover_x: Option<u8>,
    pub tags: Vec<Tag>,
    /// Sorted by `range.start`.
    pub links: Vec<LinkRef>,
    pub excerpt: String,
    /// The body's words for search (M5 §2): Markdown, the frontmatter,
    /// comments, HTML, URLs and embeds dropped; wikilinks read as their alias
    /// or target; code kept.
    pub body_text: String,
    pub has_image: bool,
    pub has_audio: bool,
    pub frontmatter_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    /// As written, without `#`.
    pub text: String,
    /// Lowercase matching key.
    pub key: String,
}

impl Tag {
    pub fn new(text: &str) -> Tag {
        Tag {
            text: text.to_string(),
            // NFC, so a tag typed composed matches one saved decomposed (M5 review M2).
            key: text.nfc().collect::<String>().to_lowercase(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LinkKind {
    Wiki,
    Embed,
    Markdown,
    MarkdownImage,
    FrontmatterRelated,
    FrontmatterCover,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Wiki => "wiki",
            LinkKind::Embed => "embed",
            LinkKind::Markdown => "markdown",
            LinkKind::MarkdownImage => "markdown_image",
            LinkKind::FrontmatterRelated => "related",
            LinkKind::FrontmatterCover => "cover",
        }
    }

    pub fn parse(s: &str) -> Option<LinkKind> {
        Some(match s {
            "wiki" => LinkKind::Wiki,
            "embed" => LinkKind::Embed,
            "markdown" => LinkKind::Markdown,
            "markdown_image" => LinkKind::MarkdownImage,
            "related" => LinkKind::FrontmatterRelated,
            "cover" => LinkKind::FrontmatterCover,
            _ => return None,
        })
    }

    /// Wiki-style kinds resolve by name (Obsidian rules); the others by path.
    pub fn is_wiki_style(self) -> bool {
        matches!(
            self,
            LinkKind::Wiki | LinkKind::Embed | LinkKind::FrontmatterRelated
        )
    }
}

/// One reference from a page to a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRef {
    pub kind: LinkKind,
    /// Decoded target without `#heading` or `|alias`.
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    /// Byte range of the target text in the source, as written.
    pub range: Range<usize>,
    /// The target was %-encoded in the source (Markdown links).
    pub encoded: bool,
    /// Markdown destination written as `<…>`.
    pub angle: bool,
    /// `related:` object form.
    pub label: Option<String>,
    pub directed: bool,
}

impl LinkRef {
    pub(crate) fn new(kind: LinkKind, target: &str, range: Range<usize>) -> LinkRef {
        LinkRef {
            kind,
            target: target.to_string(),
            heading: None,
            alias: None,
            range,
            encoded: false,
            angle: false,
            label: None,
            directed: false,
        }
    }
}
