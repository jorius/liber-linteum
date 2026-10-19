//! Metadata extraction from Markdown pages (title, frontmatter, tags, links).
//! Pure functions, no I/O.

mod body;
mod external;
mod frontmatter;
mod page;
mod resolve;
mod title;
mod types;
mod wikilink;

pub use external::{DiskPath, ExternalTarget, external_target, network_server};
pub use page::parse_page;
pub use resolve::{FileSet, link_key, name_key, normalize_join, resolve, shortest_unique_target};
pub use title::extract_title;
pub use types::{LinkKind, LinkRef, PageMeta, Tag};
