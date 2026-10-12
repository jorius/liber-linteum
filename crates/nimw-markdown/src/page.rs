use crate::types::{LinkKind, PageMeta};
use crate::{body, frontmatter, title};

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];
const AUDIO_EXT: &[&str] = &["wav", "mp3", "m4a"];

/// Parses one page (PG-01, PG-02, PG-03, PG-04, PG-05 extraction).
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
    let body = body::extract(source);
    for tag in body.tags {
        if !meta.tags.iter().any(|t| t.key == tag.key) {
            meta.tags.push(tag);
        }
    }
    meta.links.extend(body.links);
    meta.links.sort_by_key(|l| l.range.start);
    meta.excerpt = body.excerpt;
    let ext_in = |target: &str, list: &[&str]| {
        target
            .rsplit_once('.')
            .is_some_and(|(_, ext)| list.contains(&ext.to_ascii_lowercase().as_str()))
    };
    let media = |l: &&crate::types::LinkRef| {
        matches!(
            l.kind,
            LinkKind::Embed | LinkKind::MarkdownImage | LinkKind::Markdown
        )
    };
    meta.has_image = meta
        .links
        .iter()
        .filter(media)
        .any(|l| ext_in(&l.target, IMAGE_EXT));
    meta.has_audio = meta
        .links
        .iter()
        .filter(media)
        .any(|l| ext_in(&l.target, AUDIO_EXT));
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_01_04_05_full_page() {
        let src = "---\nsubtitle: Hero\ncover: assets/c.png\ntags: [character]\nrelated:\n  - \"[[Sparda]]\"\n---\n# Generator Rex\n\nSee ![[turn.png]] and ![[voice.MP3]] and [[Game 1]] #Character #redesign\n";
        let m = parse_page(src, "rex-draft");
        assert_eq!(m.title, "Generator Rex");
        assert_eq!(m.subtitle.as_deref(), Some("Hero"));
        assert_eq!(
            m.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["character", "redesign"]
        );
        let kinds: Vec<_> = m
            .links
            .iter()
            .map(|l| (l.kind, l.target.as_str()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (LinkKind::FrontmatterCover, "assets/c.png"),
                (LinkKind::FrontmatterRelated, "Sparda"),
                (LinkKind::Embed, "turn.png"),
                (LinkKind::Embed, "voice.MP3"),
                (LinkKind::Wiki, "Game 1"),
            ]
        );
        assert!(m.has_image && m.has_audio);
        assert!(
            m.links
                .windows(2)
                .all(|w| w[0].range.start < w[1].range.start)
        );
    }

    #[test]
    fn malformed_frontmatter_still_parses_body() {
        let m = parse_page("---\ntags: [unclosed\n---\n# T\n\n[[target]] #ok\n", "x");
        assert!(m.frontmatter_error.is_some());
        assert_eq!(m.links[0].target, "target");
        assert_eq!(m.tags[0].text, "ok");
    }

    #[test]
    fn review_focus_large_and_binary_like_pages_do_not_panic() {
        let big = format!("# Big\n\n{}", "[[a]] #t text ".repeat(200_000));
        let m = parse_page(&big, "big");
        assert_eq!(m.links.len(), 200_000);
        let junk: String = (0u32..5000).filter_map(char::from_u32).collect();
        let _ = parse_page(&junk, "junk");
        let _ = parse_page("---\n\u{0}\u{1}: [\n---\n\u{0}", "nul");
    }
}
