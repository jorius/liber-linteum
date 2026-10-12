//! Metadata extraction from Markdown pages (title, frontmatter, tags, links).
//! Pure functions, no I/O.

mod body;
mod frontmatter;
mod page;
mod title;
mod types;
mod wikilink;

pub use page::parse_page;
pub use title::extract_title;
pub use types::{LinkKind, LinkRef, PageMeta, Tag};
