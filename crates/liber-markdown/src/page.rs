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
    let mut body_start = 0;
    if let Some((yaml, start)) = frontmatter::split(source) {
        body_start = start;
        let fm = frontmatter::parse(source, yaml);
        meta.subtitle = fm.subtitle;
        meta.cover = fm.cover;
        meta.cover_y = fm.cover_y;
        meta.cover_x = fm.cover_x;
        meta.icon = fm.icon;
        meta.tags = fm.tags;
        meta.links = fm.links;
        meta.frontmatter_error = fm.error;
    }
    let body = body::extract(source, body_start);
    for tag in body.tags {
        if !meta.tags.iter().any(|t| t.key == tag.key) {
            meta.tags.push(tag);
        }
    }
    meta.links.extend(body.links);
    meta.links.sort_by_key(|l| l.range.start);
    meta.excerpt = body.excerpt;
    meta.body_text = body.text;
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

    /// A note saved with a byte-order mark (Windows Notepad): its frontmatter
    /// still gives the tags, cover and links, and the title and excerpt don't
    /// see the mark.
    #[test]
    fn a_byte_order_mark_is_no_text() {
        let src = "\u{FEFF}---\ntags: [character]\ncover: c.png\n---\n# Rex\n\nBody [[A]]\n";
        let m = parse_page(src, "draft");
        assert_eq!(m.title, "Rex");
        assert_eq!(m.cover.as_deref(), Some("c.png"));
        assert_eq!(m.tags[0].key, "character");
        let got: Vec<_> = m.links.iter().map(|l| &src[l.range.clone()]).collect();
        assert_eq!(got, vec!["c.png", "A"]);
        let plain = parse_page("\u{FEFF}Hello there.\n", "p");
        assert_eq!(plain.excerpt, "Hello there.");
    }

    #[test]
    fn malformed_frontmatter_still_parses_body() {
        let m = parse_page("---\ntags: [unclosed\n---\n# T\n\n[[target]] #ok\n", "x");
        assert!(m.frontmatter_error.is_some());
        assert_eq!(m.links[0].target, "target");
        assert_eq!(m.tags[0].text, "ok");
    }

    /// Final review C1(a): the outer link of a linked image must point at its
    /// own destination, not the inner image's (overlapping ranges corrupt rewrites).
    #[test]
    fn exp_04_linked_image_has_distinct_ranges() {
        let src = "[![alt](x.png)](y.png)\n";
        let m = parse_page(src, "p");
        let mut got: Vec<_> = m
            .links
            .iter()
            .map(|l| (l.kind, &src[l.range.clone()], l.range.start))
            .collect();
        got.sort_by_key(|g| g.2);
        assert_eq!(
            got,
            vec![
                (LinkKind::MarkdownImage, "x.png", 8),
                (LinkKind::Markdown, "y.png", 16)
            ]
        );
        let same = "[![alt](x.png)](x.png)\n";
        let m = parse_page(same, "p");
        let ranges: Vec<_> = m.links.iter().map(|l| l.range.clone()).collect();
        assert_eq!(ranges, vec![8..13, 16..21]);
    }

    /// Final review C1(b): frontmatter that pulldown-cmark does not recognise
    /// (blank first line) must not also be parsed as body text.
    #[test]
    fn exp_04_frontmatter_links_are_not_duplicated_as_body_links() {
        let src = "---\n\nrelated:\n  - \"[[A]]\"\n---\n# T\n\n[[B]]\n";
        let m = parse_page(src, "p");
        let got: Vec<_> = m
            .links
            .iter()
            .map(|l| (l.kind, l.target.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![(LinkKind::FrontmatterRelated, "A"), (LinkKind::Wiki, "B")]
        );
    }

    /// Final review I2: Obsidian's escaped alias pipe inside tables.
    #[test]
    fn pg_05_table_alias_with_escaped_pipe_is_a_link() {
        let src = "| a | b |\n|---|---|\n| x | [[A\\|shown]] |\n";
        let m = parse_page(src, "p");
        assert_eq!(m.links.len(), 1, "{:?}", m.links);
        let l = &m.links[0];
        assert_eq!(l.kind, LinkKind::Wiki);
        assert_eq!(l.target, "A");
        assert_eq!(l.alias.as_deref(), Some("shown"));
        assert_eq!(&src[l.range.clone()], "A");
    }

    /// M5 §2: the text search reads — words kept, Markdown dropped.
    #[test]
    fn body_text_keeps_words_and_drops_markup() {
        let src = "---\ntags: [x]\nsecret: fm\n---\n# Dragón title\n\nSome *bold* [[Target|alias]] and [[Plain]] ![[pic.png]] [web](https://e.x) #tag\n\n%% hidden %%\n<div>html</div>\n<!-- note -->\n\n```rust\nlet code = 1;\n```\n\n- item `inline`\n\n| a | b |\n|---|---|\n| cell | [[T2\\|shown]] |\n";
        let m = parse_page(src, "p");
        let t = &m.body_text;
        for w in [
            "Dragón",
            "title",
            "Some",
            "bold",
            "alias",
            "Plain",
            "web",
            "#tag",
            "let code = 1;",
            "item",
            "inline",
            "cell",
            "shown",
        ] {
            assert!(t.contains(w), "{w} missing in {t:?}");
        }
        for w in [
            "secret", "fm", "hidden", "html", "note", "pic.png", "https", "Target", "T2",
        ] {
            assert!(!t.contains(w), "{w} leaked into {t:?}");
        }
    }

    #[test]
    fn body_text_separates_blocks_and_has_no_control_characters() {
        let m = parse_page(
            "# A\n\nfirst line\nsecond\n\nnext\u{1}x\u{2}y\u{7}\tz\n",
            "p",
        );
        assert!(
            !m.body_text.chars().any(|c| c.is_control() && c != '\n'),
            "{:?}",
            m.body_text
        );
        assert!(m.body_text.contains("first line"), "{:?}", m.body_text);
        assert!(!m.body_text.contains("Afirst"), "{:?}", m.body_text);
        assert!(!m.body_text.contains("linesecond"), "{:?}", m.body_text);
        assert!(m.body_text.contains("next x y"), "{:?}", m.body_text);
    }

    #[test]
    fn body_text_of_a_bom_page_and_an_empty_one() {
        assert_eq!(
            parse_page("\u{FEFF}Hello there.\n", "p").body_text,
            "Hello there."
        );
        assert_eq!(parse_page("", "p").body_text, "");
        assert_eq!(parse_page("---\ntags: [a]\n---\n", "p").body_text, "");
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
