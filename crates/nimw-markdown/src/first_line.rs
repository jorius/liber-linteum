//! The visible text of a note's first line (M4c §2): quick notes are named
//! after it until the user renames them.

use crate::frontmatter;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// The visible text of the body's first non-blank line (after the
/// frontmatter and a byte-order mark, as in the title rule): heading marks,
/// list and quote markers, task boxes and emphasis go; links keep their text,
/// wikilinks their alias (else their target), tags their word; images,
/// embeds and HTML go. `None` when nothing is left.
pub fn first_line_text(source: &str) -> Option<String> {
    let body = match frontmatter::split(source) {
        Some((_, start)) => &source[start..],
        None => &source[frontmatter::text_start(source)..],
    };
    let line = body.lines().map(str::trim).find(|l| !l.is_empty())?;
    let flat = flatten_wikilinks(line);
    let mut text = String::new();
    let mut in_image = 0usize;
    let options = Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH;
    for event in Parser::new_ext(&flat, options) {
        match event {
            Event::Start(Tag::Image { .. }) => in_image += 1,
            Event::End(TagEnd::Image) => in_image = in_image.saturating_sub(1),
            Event::Text(t) | Event::Code(t) if in_image == 0 => text.push_str(&t),
            Event::SoftBreak | Event::HardBreak => text.push(' '),
            _ => {}
        }
    }
    let words: Vec<&str> = text.split_whitespace().map(untag).collect();
    let text = words.join(" ");
    (!text.trim().is_empty()).then(|| text.trim().to_string())
}

/// `[[target|alias]]` → `alias`, `[[target#heading]]` → `target`,
/// `![[embed]]` → nothing; an unclosed `[[` stays as written.
fn flatten_wikilinks(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find("[[") {
        let Some(close) = rest[open + 2..].find("]]") else {
            break;
        };
        let inner = &rest[open + 2..open + 2 + close];
        let embed = rest[..open].ends_with('!');
        out.push_str(&rest[..if embed { open - 1 } else { open }]);
        if !embed {
            let shown = match inner.split_once('|') {
                Some((_, alias)) => alias,
                None => inner.split(['#', '^']).next().unwrap_or(""),
            };
            out.push_str(shown);
        }
        rest = &rest[open + 2 + close + 2..];
    }
    out.push_str(rest);
    out
}

/// A tag keeps its word: `#work` → `work` (a `#` inside a word stays).
fn untag(word: &str) -> &str {
    match word.strip_prefix('#') {
        Some(tag) if tag.starts_with(|c: char| c.is_alphanumeric() || c == '_') => tag,
        _ => word,
    }
}

#[cfg(test)]
mod tests {
    use super::first_line_text;

    #[test]
    fn m4c_plain_and_heading_lines() {
        assert_eq!(
            first_line_text("Shopping list\nmilk").as_deref(),
            Some("Shopping list")
        );
        assert_eq!(
            first_line_text("# Meeting *notes*\n").as_deref(),
            Some("Meeting notes")
        );
        assert_eq!(
            first_line_text("## **Big**   idea").as_deref(),
            Some("Big idea")
        );
    }

    #[test]
    fn m4c_after_frontmatter_bom_and_blank_lines() {
        assert_eq!(
            first_line_text("---\ntags: [a]\n---\n\n  \nIdea").as_deref(),
            Some("Idea")
        );
        assert_eq!(first_line_text("\u{FEFF}Hello").as_deref(), Some("Hello"));
        assert_eq!(
            first_line_text("---\r\ntags: [a]\r\n---\r\nIdea\r\nmore").as_deref(),
            Some("Idea")
        );
    }

    #[test]
    fn m4c_markers_links_and_tags_are_flattened() {
        assert_eq!(
            first_line_text("- [ ] call [Ana](https://x.y) about #work").as_deref(),
            Some("call Ana about work")
        );
        assert_eq!(
            first_line_text("> see [[Projects/Plan#Goals|the plan]] `v2`").as_deref(),
            Some("see the plan v2")
        );
        assert_eq!(
            first_line_text("1. [[Recipes]] and <b>bold</b>").as_deref(),
            Some("Recipes and bold")
        );
        assert_eq!(
            first_line_text("[[Trips#Spain]] ~~old~~ ==new==").as_deref(),
            Some("Trips old ==new==")
        );
        assert_eq!(
            first_line_text("Issue #12: a C# question").as_deref(),
            Some("Issue 12: a C# question")
        );
    }

    #[test]
    fn m4c_nothing_usable_is_none() {
        for s in [
            "",
            "\n\n",
            "# ",
            "---\na: 1\n---\n",
            "![[x.png]]",
            "![](a.png)",
            "```js",
            "---",
            "<!-- note -->",
        ] {
            assert_eq!(first_line_text(s), None, "{s:?}");
        }
    }
}
