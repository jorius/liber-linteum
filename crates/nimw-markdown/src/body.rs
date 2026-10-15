use crate::types::{LinkKind, LinkRef, Tag};
use crate::wikilink;
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag as MdTag, TagEnd};
use std::ops::Range;

const EXCERPT_CHARS: usize = 200;

#[derive(Debug, Default)]
pub(crate) struct Body {
    pub links: Vec<LinkRef>,
    pub tags: Vec<Tag>,
    pub excerpt: String,
    /// The body's words for search (M5 §2): see [`plain_text`].
    pub text: String,
}

/// A run of body text: Markdown text (wikilinks still in it) at `range`, or
/// code taken as is.
struct Piece {
    range: Range<usize>,
    code: Option<String>,
}

const OPTIONS: Options = Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
    .union(Options::ENABLE_TABLES)
    .union(Options::ENABLE_TASKLISTS)
    .union(Options::ENABLE_STRIKETHROUGH);

/// Byte ranges of code (fenced, indented, inline), HTML and the frontmatter,
/// where `%%` stays literal.
fn code_ranges(src: &str, body_start: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    out.push(0..body_start);
    for (event, range) in Parser::new_ext(src, OPTIONS).into_offset_iter() {
        match event {
            Event::Start(MdTag::CodeBlock(_))
            | Event::Start(MdTag::HtmlBlock)
            | Event::Start(MdTag::MetadataBlock(_))
            | Event::Code(_)
            | Event::InlineHtml(_)
            | Event::Html(_) => out.push(range),
            _ => {}
        }
    }
    out
}

/// Obsidian `%% … %%` comment ranges outside code; an unclosed `%%` is not a
/// comment. Same rules as the editor's model (apps/desktop/src/markdown/blocks.ts).
pub(crate) fn find_comments(src: &str, body_start: usize) -> Vec<Range<usize>> {
    if !src.contains("%%") {
        return Vec::new();
    }
    let code = code_ranges(src, body_start);
    let in_code = |i: usize| code.iter().any(|r| r.contains(&i));
    let next = |from: usize| src.get(from..)?.find("%%").map(|p| p + from);
    let mut out = Vec::new();
    let mut i = next(0);
    while let Some(open) = i {
        if in_code(open) {
            i = next(open + 2);
            continue;
        }
        let mut close = next(open + 2);
        while let Some(c) = close.filter(|&c| in_code(c)) {
            close = next(c + 2);
        }
        let Some(close) = close else { break };
        out.push(open..close + 2);
        i = next(close + 2);
    }
    out
}

/// `src` with comments blanked byte for byte (line endings kept), so every
/// offset into the result is also an offset into `src`.
fn mask_comments(src: &str, comments: &[Range<usize>]) -> String {
    let mut bytes = src.as_bytes().to_vec();
    for r in comments {
        for b in &mut bytes[r.clone()] {
            if *b != b'\n' && *b != b'\r' {
                *b = b' ';
            }
        }
    }
    // Comments start and end at ASCII `%`, so whole characters were replaced.
    String::from_utf8(bytes).unwrap_or_else(|_| src.to_string())
}

/// Extracts links, tags and the excerpt from the Markdown body. Code (fenced,
/// indented, inline), HTML blocks/inline HTML, HTML comments and Obsidian
/// `%% %%` comments are ignored, and so is everything before `body_start` (the
/// frontmatter, even when pulldown-cmark does not recognise it as a metadata
/// block — its links come from the YAML). A byte-order mark is no text: it
/// is read as three spaces, so every offset stays where it was.
pub(crate) fn extract(src: &str, body_start: usize) -> Body {
    let unmarked;
    let src = match src.strip_prefix('\u{FEFF}') {
        Some(rest) => {
            unmarked = format!("   {rest}");
            unmarked.as_str()
        }
        None => src,
    };
    let comments = find_comments(src, body_start);
    if comments.is_empty() {
        extract_unmasked(src, body_start)
    } else {
        extract_unmasked(&mask_comments(src, &comments), body_start)
    }
}

fn extract_unmasked(src: &str, body_start: usize) -> Body {
    let mut body = Body::default();
    let mut regions: Vec<Range<usize>> = Vec::new();
    let mut excerpt_regions: Vec<Range<usize>> = Vec::new();
    let mut pieces: Vec<Piece> = Vec::new();
    let mut in_code = 0usize;
    let mut in_meta = false;
    let mut in_heading = false;
    for (event, range) in Parser::new_ext(src, OPTIONS).into_offset_iter() {
        if range.start < body_start {
            continue;
        }
        match event {
            Event::Start(MdTag::MetadataBlock(_)) => in_meta = true,
            Event::End(TagEnd::MetadataBlock(_)) => in_meta = false,
            Event::Start(MdTag::CodeBlock(_)) => in_code += 1,
            Event::End(TagEnd::CodeBlock) => in_code = in_code.saturating_sub(1),
            Event::Start(MdTag::Heading { level, .. }) => {
                in_heading = true;
                if level == HeadingLevel::H1 {
                    excerpt_regions.clear();
                }
            }
            Event::End(TagEnd::Heading(_)) => in_heading = false,
            Event::Start(MdTag::Link {
                link_type,
                dest_url,
                ..
            }) => {
                if let Some(link) =
                    markdown_link(src, &range, link_type, &dest_url, LinkKind::Markdown)
                {
                    body.links.push(link);
                }
            }
            Event::Start(MdTag::Image {
                link_type,
                dest_url,
                ..
            }) => {
                if let Some(link) =
                    markdown_link(src, &range, link_type, &dest_url, LinkKind::MarkdownImage)
                {
                    body.links.push(link);
                }
            }
            Event::Text(_) if in_code == 0 && !in_meta => {
                push_merged(src, &mut regions, range.clone());
                push_piece(src, &mut pieces, range.clone(), None);
                if !in_heading {
                    push_merged(src, &mut excerpt_regions, range);
                }
            }
            Event::Text(text) if !in_meta => {
                push_piece(src, &mut pieces, range, Some(text.to_string()));
            }
            Event::Code(text) => push_piece(src, &mut pieces, range, Some(text.to_string())),
            Event::SoftBreak | Event::HardBreak if !in_heading => {
                push_merged(src, &mut excerpt_regions, range);
            }
            _ => {}
        }
    }
    for region in &regions {
        let text = &src[region.clone()];
        for occ in wikilink::find_all(text) {
            // An escaped `[[` has its backslash just before the text region.
            let open = region.start + occ.inner.start - 2;
            if !occ.embed && open > 0 && src.as_bytes()[open - 1] == b'\\' {
                continue;
            }
            let Some(parts) = wikilink::parse_inner(&text[occ.inner.clone()]) else {
                continue;
            };
            let start = region.start + occ.inner.start + parts.target_range.start;
            let kind = if occ.embed {
                LinkKind::Embed
            } else {
                LinkKind::Wiki
            };
            let mut link = LinkRef::new(kind, parts.target, start..start + parts.target.len());
            link.heading = parts.heading.map(str::to_string);
            link.alias = parts.alias.map(str::to_string);
            body.links.push(link);
        }
        tags_in(text, &mut body.tags);
    }
    body.links.sort_by_key(|l| l.range.start);
    body.excerpt = excerpt(src, &without(&excerpt_regions, &display_maths(src)));
    body.text = plain_text(src, &pieces);
    body
}

/// Appends a run of body text; Markdown text merges with the run before it
/// as [`push_merged`] does, so a wikilink split by the parser is whole again.
fn push_piece(src: &str, pieces: &mut Vec<Piece>, range: Range<usize>, code: Option<String>) {
    if code.is_none()
        && let Some(last) = pieces.last_mut()
        && last.code.is_none()
        && (last.end() == range.start
            || (last.end() < range.start && &src[last.end()..range.start] == "\\"))
    {
        last.range.end = range.end;
        return;
    }
    pieces.push(Piece { range, code });
}

impl Piece {
    fn end(&self) -> usize {
        self.range.end
    }
}

/// The body's words (M5 §2): headings, paragraphs, lists, tables and code, in
/// order; wikilinks read as their alias or target, embeds, URLs, HTML and
/// comments are gone. Runs on one line are joined by a space, others by a
/// line break; control characters other than `\n` become spaces (the search
/// index marks its snippets with some).
fn plain_text(src: &str, pieces: &[Piece]) -> String {
    let mut out = String::new();
    let mut prev_end: Option<usize> = None;
    for piece in pieces {
        if let Some(end) = prev_end {
            let gap = src.get(end..piece.range.start).unwrap_or("");
            out.push(if gap.contains('\n') { '\n' } else { ' ' });
        }
        prev_end = Some(piece.range.end);
        match &piece.code {
            Some(code) => out.push_str(code),
            None => out.push_str(&render_wikilinks(&src[piece.range.clone()]).replace('\\', "")),
        }
    }
    let cleaned: String = out
        .chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect();
    cleaned.trim().to_string()
}

/// `text` with each wikilink replaced by its alias or target, and embeds dropped.
fn render_wikilinks(text: &str) -> String {
    let mut rendered = String::new();
    let mut last = 0;
    for occ in wikilink::find_all(text) {
        rendered.push_str(&text[last..occ.whole.start]);
        if !occ.embed
            && let Some(p) = wikilink::parse_inner(&text[occ.inner.clone()])
        {
            rendered.push_str(p.alias.unwrap_or(p.target));
        }
        last = occ.whole.end;
    }
    rendered.push_str(&text[last..]);
    rendered
}

/// Appends `r`, merging it with the previous range when they touch or are
/// separated only by a backslash escape. (pulldown-cmark splits text at `[`,
/// so `[[x]]` arrives in pieces, and drops the `\` of an escaped table pipe in
/// Obsidian's `[[target\|alias]]`.)
fn push_merged(src: &str, regions: &mut Vec<Range<usize>>, r: Range<usize>) {
    match regions.last_mut() {
        Some(last)
            if last.end == r.start || (last.end < r.start && &src[last.end..r.start] == "\\") =>
        {
            last.end = r.end
        }
        _ => regions.push(r),
    }
}

/// A URL scheme (`https:`, `mailto:`): at least two characters, so a
/// Windows drive (`D:\…`) is a path (M4b part 3 §9).
fn has_scheme(dest: &str) -> bool {
    let Some(colon) = dest.find(':') else {
        return false;
    };
    let scheme = &dest[..colon];
    scheme.len() > 1
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.')
}

/// `file:` URLs name files on disk (outside the vault, §9): kept as links.
fn is_file_url(dest: &str) -> bool {
    dest.get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("file:"))
}

fn markdown_link(
    src: &str,
    range: &Range<usize>,
    link_type: LinkType,
    dest_url: &str,
    kind: LinkKind,
) -> Option<LinkRef> {
    if link_type != LinkType::Inline
        || dest_url.is_empty()
        || dest_url.starts_with('#')
        || (has_scheme(dest_url) && !is_file_url(dest_url))
    {
        return None;
    }
    // The destination is the link's *last* `](`: searching from the start
    // would find a nested image's destination inside the link text.
    let slice = &src[range.clone()];
    let mut end = slice.len();
    let (dest_start, angle) = loop {
        let pos = slice[..end].rfind("](")?;
        let after = pos + 2;
        if slice[after..].starts_with(dest_url) {
            break (after, false);
        }
        if slice[after..].starts_with('<') && slice[after + 1..].starts_with(dest_url) {
            break (after + 1, true);
        }
        end = pos;
    };
    let (path_part, heading) = match dest_url.find('#') {
        Some(i) => (&dest_url[..i], Some(&dest_url[i + 1..])),
        None => (dest_url, None),
    };
    if path_part.is_empty() {
        return None;
    }
    let target = percent_decode_str(path_part)
        .decode_utf8()
        .ok()?
        .to_string();
    let abs = range.start + dest_start;
    let mut link = LinkRef::new(kind, &target, abs..abs + path_part.len());
    link.heading = heading.filter(|h| !h.is_empty()).map(str::to_string);
    link.encoded = path_part.contains('%');
    link.angle = angle;
    Some(link)
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

/// Obsidian tag rules: `#` at the start or after whitespace, then tag
/// characters with at least one non-digit; trailing `/` dropped.
fn tags_in(text: &str, out: &mut Vec<Tag>) {
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if c == '#' && prev.is_none_or(char::is_whitespace) {
            let rest = &text[i + 1..];
            let len: usize = rest
                .chars()
                .take_while(|&c| is_tag_char(c))
                .map(char::len_utf8)
                .sum();
            let tag = rest[..len].trim_end_matches('/');
            if !tag.is_empty()
                && tag.chars().any(|c| !c.is_ascii_digit())
                && !tag.starts_with('/')
                && !out.iter().any(|t| t.key == tag.to_lowercase())
            {
                out.push(Tag::new(tag));
            }
        }
        prev = Some(c);
    }
}

/// Plain text of non-heading paragraphs after the first H1, with wikilinks
/// shown as their alias or target and embeds dropped; ≤ 200 chars.
fn excerpt(src: &str, regions: &[Range<usize>]) -> String {
    let mut words = String::new();
    for region in regions {
        let rendered = render_wikilinks(&src[region.clone()]);
        words.push(' ');
        words.push_str(&rendered.replace('\\', ""));
    }
    let collapsed = words.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= EXCERPT_CHARS {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(EXCERPT_CHARS).collect();
        format!("{}…", cut.trim_end())
    }
}

/// `regions` with the parts inside `cut` (sorted, disjoint) taken out.
fn without(regions: &[Range<usize>], cut: &[Range<usize>]) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    for r in regions {
        let mut start = r.start;
        for c in cut.iter().filter(|c| c.start < r.end && c.end > r.start) {
            if c.start > start {
                out.push(start..c.start);
            }
            start = start.max(c.end);
        }
        if start < r.end {
            out.push(start..r.end);
        }
    }
    out
}

/// Byte ranges of display maths (`$$ … $$`, M4b part 2 §3), as pulldown-cmark
/// reads it: never inside code, and not from escaped dollars (final review
/// M8). Excerpts leave these out.
fn display_maths(src: &str) -> Vec<Range<usize>> {
    if !src.contains("$$") {
        return Vec::new();
    }
    Parser::new_ext(src, OPTIONS.union(Options::ENABLE_MATH))
        .into_offset_iter()
        .filter_map(|(event, range)| matches!(event, Event::DisplayMath(_)).then_some(range))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(src: &str) -> Vec<(LinkKind, String, String)> {
        extract(src, 0)
            .links
            .into_iter()
            .map(|l| (l.kind, l.target, src[l.range].to_string()))
            .collect()
    }

    /// M4b part 3 §9: a drive letter is not a URL scheme, and `file:` URLs
    /// are links (to files outside the vault); other schemes stay out.
    #[test]
    fn m4b3_drive_paths_and_file_urls_are_links() {
        let src = r"![a](D:\Pics\a.png) [b](file:///Users/j/b%20c.pdf) ![c](FILE:///x.png) [w](https://e.com) [o](obsidian://open?x) [z](z:x)";
        let got: Vec<_> = extract(src, 0)
            .links
            .into_iter()
            .map(|l| (l.kind, l.target))
            .collect();
        assert_eq!(
            got,
            vec![
                (LinkKind::MarkdownImage, r"D:\Pics\a.png".to_string()),
                (LinkKind::Markdown, "file:///Users/j/b c.pdf".to_string()),
                (LinkKind::MarkdownImage, "FILE:///x.png".to_string()),
                (LinkKind::Markdown, "z:x".to_string()),
            ]
        );
    }

    #[test]
    fn pg_05_wikilinks_and_embeds_with_target_ranges() {
        let src = "See [[Sparda#Coat|the knight]], ![[img.png]] and [[ spaced ]].";
        assert_eq!(
            targets(src),
            vec![
                (LinkKind::Wiki, "Sparda".into(), "Sparda".into()),
                (LinkKind::Embed, "img.png".into(), "img.png".into()),
                (LinkKind::Wiki, "spaced".into(), "spaced".into()),
            ]
        );
        let l = &extract(src, 0).links[0];
        assert_eq!(
            (l.heading.as_deref(), l.alias.as_deref()),
            (Some("Coat"), Some("the knight"))
        );
    }

    #[test]
    fn pg_05_ignored_regions_yield_no_links_or_tags() {
        let src = "`[[a]]` `#t`\n\n```\n[[b]] #b\n```\n\n    [[c]] #c\n\n<div>\n[[d]] #d\n</div>\n\n<!-- [[e]] #e -->\n\n\\[[f]] [[ok]] #ok";
        let b = extract(src, 0);
        assert_eq!(
            b.links
                .iter()
                .map(|l| l.target.as_str())
                .collect::<Vec<_>>(),
            vec!["ok"]
        );
        assert_eq!(
            b.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["ok"]
        );
    }

    #[test]
    fn pg_05_markdown_links_encoded_angle_rooted_and_skipped() {
        let src = "[a](DMC/Sparda.md#Palette) [b](</Game Design/Game 1.md>) [c](../Game%20Design/Game%201.md) \
                   ![i](img/x.png) [w](https://e.com) [m](mailto:a@b.c) [f](#local) [r][ref]\n\n[ref]: other.md\n";
        let links = extract(src, 0).links;
        let got: Vec<_> = links
            .iter()
            .map(|l| {
                (
                    l.kind,
                    l.target.as_str(),
                    &src[l.range.clone()],
                    l.encoded,
                    l.angle,
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    LinkKind::Markdown,
                    "DMC/Sparda.md",
                    "DMC/Sparda.md",
                    false,
                    false
                ),
                (
                    LinkKind::Markdown,
                    "/Game Design/Game 1.md",
                    "/Game Design/Game 1.md",
                    false,
                    true
                ),
                (
                    LinkKind::Markdown,
                    "../Game Design/Game 1.md",
                    "../Game%20Design/Game%201.md",
                    true,
                    false
                ),
                (
                    LinkKind::MarkdownImage,
                    "img/x.png",
                    "img/x.png",
                    false,
                    false
                ),
            ]
        );
        assert_eq!(links[0].heading.as_deref(), Some("Palette"));
    }

    #[test]
    fn obsidian_comments_hide_links_and_tags_but_not_in_code() {
        let src = "a [[x]] %% [[hidden]] #h %% b #t\n\n%%\n[[block]] ![[e.png]]\n%%\n\n`%%` [[kept]] %% open [[open]]";
        let b = extract(src, 0);
        let got: Vec<_> = b
            .links
            .iter()
            .map(|l| (l.target.as_str(), &src[l.range.clone()]))
            .collect();
        assert_eq!(got, vec![("x", "x"), ("kept", "kept"), ("open", "open")]);
        assert_eq!(
            b.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["t"]
        );
        assert_eq!(find_comments("ü %% é %% `%%`", 0), vec![3..11]);
    }

    #[test]
    fn pg_04_tag_rules() {
        let tags = |s: &str| {
            extract(s, 0)
                .tags
                .into_iter()
                .map(|t| t.text)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            tags("#art/sketch #2024 #y2024 #trailing/ a#b (#paren) #ñandú"),
            vec!["art/sketch", "y2024", "trailing", "ñandú"]
        );
        assert_eq!(tags("# Heading\n\n#Tag and #tag"), vec!["Tag"]);
        assert_eq!(tags("## Section #inheading"), vec!["inheading"]);
        assert_eq!(tags("https://x.com/#anchor"), Vec::<String>::new());
    }

    #[test]
    fn excerpt_skips_title_renders_links_and_truncates() {
        let b = extract(
            "---\nsubtitle: s\n---\n# Title\n\nHello [[rex-draft|Rex]] and ![[x.png]] world.\n\n## Sub\n\nMore.",
            0,
        );
        assert_eq!(b.excerpt, "Hello Rex and world. More.");
        let long = format!("# T\n\n{}", "word ".repeat(100));
        let e = extract(&long, 0).excerpt;
        assert!(e.ends_with('…') && e.chars().count() <= 201);
        assert_eq!(extract("Intro\n\n# Title\n\nAfter", 0).excerpt, "After");
    }

    /// M4b part 2 §3: display maths (`$$ … $$`) is left out of the excerpt.
    #[test]
    fn excerpt_drops_display_maths() {
        let b = extract("# T\n\nBefore\n\n$$\nE = mc^2\n$$\n\nAfter $x$ too", 0);
        assert_eq!(b.excerpt, "Before After $x$ too");
        let b = extract("# T\n\nInline $$x^2$$ display, and $$\na + b\n$$ more.", 0);
        assert_eq!(b.excerpt, "Inline display, and more.");
    }

    /// Final review M8: only real display maths is dropped — not the text
    /// between two `$$` that are code or escaped.
    #[test]
    fn excerpt_keeps_text_between_dollar_pairs_that_are_not_maths() {
        let b = extract("# T\n\nUse `$$` here and `$$` there.", 0);
        assert_eq!(b.excerpt, "Use here and there.");
        let b = extract("# T\n\nLiteral \\$\\$ signs \\$\\$ stay.", 0);
        assert_eq!(b.excerpt, "Literal $$ signs $$ stay.");
        let b = extract("# T\n\n```\n$$\n```\n\nKept $$ open", 0);
        assert_eq!(b.excerpt, "Kept $$ open");
    }
}
