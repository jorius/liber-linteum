use crate::frontmatter;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// Page title (PG-01, revised in M4b part 3 §1): the visible text of an H1
/// that is the body's first block (after the frontmatter; blank lines and
/// empty headings don't count), else the file stem, as Obsidian shows it. An
/// H1 further down is a section heading, never the title. The body starts
/// where the app's own frontmatter splitter says (a byte-order mark and any
/// block it accepts are skipped), not where pulldown-cmark would guess.
pub fn extract_title(source: &str, file_stem: &str) -> String {
    let body = match frontmatter::split(source) {
        Some((_, start)) => &source[start..],
        None => &source[frontmatter::text_start(source)..],
    };
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH;
    let mut in_h1 = false;
    let mut text = String::new();
    for event in Parser::new_ext(body, options) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) if !in_h1 => {
                in_h1 = true;
                text.clear();
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                in_h1 = false;
                let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !title.is_empty() {
                    return title;
                }
            }
            Event::Text(t) | Event::Code(t) if in_h1 => text.push_str(&t),
            Event::SoftBreak | Event::HardBreak if in_h1 => text.push(' '),
            // Any other block before it: the note has no title of its own.
            Event::Start(_) | Event::Rule | Event::Html(_) if !in_h1 => break,
            _ => {}
        }
    }
    file_stem.to_string()
}

#[cfg(test)]
mod tests {
    use super::extract_title;

    #[test]
    fn pg_01_title_from_first_h1() {
        assert_eq!(
            extract_title("# Generator Rex\n\nBody", "draft"),
            "Generator Rex"
        );
    }

    #[test]
    fn pg_01_falls_back_to_file_stem() {
        assert_eq!(extract_title("Just a paragraph.", "draft"), "draft");
        assert_eq!(extract_title("", "empty"), "empty");
    }

    #[test]
    fn pg_01_h2_is_not_a_title() {
        assert_eq!(extract_title("## Section\n\nText", "notes"), "notes");
    }

    #[test]
    fn pg_01_ignores_hash_lines_inside_frontmatter() {
        let src = "---\n# not a title\ntags: [a]\n---\nBody";
        assert_eq!(extract_title(src, "page"), "page");
    }

    /// M4b part 3 §1: an H1 further down is a heading, never the title
    /// (Obsidian shows the file name).
    #[test]
    fn pg_01_an_h1_after_other_blocks_is_not_the_title() {
        let src = "Intro paragraph.\n\n# Real Title\n\n# Second";
        assert_eq!(extract_title(src, "page"), "page");
        assert_eq!(extract_title("![[a.png]]\n# Later", "page"), "page");
        assert_eq!(extract_title("<!-- note -->\n# Later", "page"), "page");
    }

    #[test]
    fn pg_01_an_h1_after_frontmatter_and_blank_lines_is_the_title() {
        assert_eq!(
            extract_title("---\ntags: [a]\n---\n\n\n# Rex\n\nBody", "draft"),
            "Rex"
        );
        assert_eq!(extract_title("\n\n   \n# Rex", "draft"), "Rex");
    }

    /// Final review (Minor 4, re-graded): any block the app's own frontmatter
    /// splitter accepts is skipped — an empty properties block, or one that
    /// opens with a blank line.
    #[test]
    fn pg_01_an_h1_after_any_frontmatter_the_app_reads_is_the_title() {
        assert_eq!(extract_title("---\n---\n# Rex\n", "draft"), "Rex");
        assert_eq!(
            extract_title("---\n\ntags: [a]\n---\n# Rex\n", "draft"),
            "Rex"
        );
        assert_eq!(
            extract_title("---\r\ntags: [a]\r\n---\r\n# Rex\r\n", "draft"),
            "Rex"
        );
    }

    /// Windows Notepad saves UTF-8 with a byte-order mark: it is no text.
    #[test]
    fn pg_01_a_byte_order_mark_does_not_hide_the_title() {
        assert_eq!(extract_title("\u{FEFF}# Rex\n\nBody", "draft"), "Rex");
        assert_eq!(
            extract_title("\u{FEFF}---\ntags: [a]\n---\n# Rex\n", "draft"),
            "Rex"
        );
        assert_eq!(extract_title("\u{FEFF}Body\n\n# Later", "draft"), "draft");
    }

    /// A tester's note "Tipos de comisiones" (Windows test):
    /// paragraphs and a link, then `# WIP (Work In Progress):` halfway down.
    #[test]
    fn pg_01_a_section_heading_halfway_down_is_not_the_title() {
        let src = "Los tipos de comisiones que quiero hacer son personajes de todo tipo.\n\n\
                   No hago gore\n[[Patreon]]\n\n¿Qué estoy dispuesto a comisionar?\n\
                   # WIP (Work In Progress):\nSon avances de trabajos\n\
                   ![[Pasted image 20250701182629.png]]\n";
        assert_eq!(
            extract_title(src, "Tipos de comisiones"),
            "Tipos de comisiones"
        );
    }

    #[test]
    fn pg_01_a_setext_h1_at_the_top_is_the_title() {
        assert_eq!(extract_title("Top\n===\n\nBody", "page"), "Top");
        assert_eq!(extract_title("Body\n\nLater\n===\n", "page"), "page");
    }

    #[test]
    fn pg_01_setext_h1_counts() {
        assert_eq!(
            extract_title("Setext Title\n============\n", "page"),
            "Setext Title"
        );
    }

    #[test]
    fn pg_01_inline_formatting_is_flattened() {
        assert_eq!(
            extract_title("# **Bold** and `code` _here_", "page"),
            "Bold and code here"
        );
    }

    #[test]
    fn pg_01_empty_h1_is_skipped() {
        assert_eq!(extract_title("#\n\n# Next", "page"), "Next");
        assert_eq!(extract_title("#   \n", "page"), "page");
    }
}
