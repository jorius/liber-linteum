use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// Page title (PG-01): visible text of the first H1, else the file stem.
pub fn extract_title(source: &str, file_stem: &str) -> String {
    let options = Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH;
    let mut in_h1 = false;
    let mut text = String::new();
    for event in Parser::new_ext(source, options) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => {
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

    #[test]
    fn pg_01_first_h1_anywhere_in_the_page() {
        let src = "Intro paragraph.\n\n# Real Title\n\n# Second";
        assert_eq!(extract_title(src, "page"), "Real Title");
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
