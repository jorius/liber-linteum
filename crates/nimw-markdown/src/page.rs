use crate::types::PageMeta;
use crate::{frontmatter, title};

/// Parses one page: title (PG-01) and app-owned frontmatter (PG-02, PG-03,
/// PG-04 tags, `related`/`cover` links). Body links and tags arrive in Task 6.
pub fn parse_page(source: &str, file_stem: &str) -> PageMeta {
    let mut meta = PageMeta {
        title: title::extract_title(source, file_stem),
        ..PageMeta::default()
    };
    if let Some((yaml, _)) = frontmatter::split(source) {
        let fm = frontmatter::parse(source, yaml);
        meta.subtitle = fm.subtitle;
        meta.cover = fm.cover;
        meta.cover_y = fm.cover_y;
        meta.tags = fm.tags;
        meta.links = fm.links;
        meta.frontmatter_error = fm.error;
    }
    meta
}
