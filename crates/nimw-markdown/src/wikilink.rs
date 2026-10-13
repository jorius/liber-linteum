use std::ops::Range;

/// Parsed inside of `[[…]]`, with the target's byte range relative to `inner`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct WikiParts<'a> {
    pub target: &'a str,
    pub target_range: Range<usize>,
    pub heading: Option<&'a str>,
    pub alias: Option<&'a str>,
}

/// Splits `target#heading|alias`. Returns `None` for an empty target
/// (e.g. `[[#Heading]]`, a link to the same page).
pub(crate) fn parse_inner(inner: &str) -> Option<WikiParts<'_>> {
    // Obsidian writes `[[target\|alias]]` inside tables: the `\` escapes the pipe.
    let (target_part, alias) = match inner.find('|') {
        Some(i) if i > 0 && inner.as_bytes()[i - 1] == b'\\' => {
            (&inner[..i - 1], Some(&inner[i + 1..]))
        }
        Some(i) => (&inner[..i], Some(&inner[i + 1..])),
        None => (inner, None),
    };
    let (target_raw, heading) = match target_part.find('#') {
        Some(i) => (&target_part[..i], Some(&target_part[i + 1..])),
        None => (target_part, None),
    };
    let lead = target_raw.len() - target_raw.trim_start().len();
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    Some(WikiParts {
        target,
        target_range: lead..lead + target.len(),
        heading: heading.filter(|h| !h.is_empty()),
        alias: alias.filter(|a| !a.is_empty()),
    })
}

/// A `[[…]]` occurrence found in a text slice: byte range of the inner text
/// (between the brackets) and whether it is an embed (`![[…]]`).
pub(crate) struct Occurrence {
    pub inner: Range<usize>,
    pub embed: bool,
    pub whole: Range<usize>,
}

/// Finds `[[…]]` in `text` (single line, no nested `[[`, not escaped `\[[`).
pub(crate) fn find_all(text: &str) -> Vec<Occurrence> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(off) = text[i..].find("[[") {
        let start = i + off;
        if start > 0 && bytes[start - 1] == b'\\' {
            i = start + 2;
            continue;
        }
        let inner_start = start + 2;
        let Some(close) = text[inner_start..].find("]]") else {
            break;
        };
        let inner_end = inner_start + close;
        let inner = &text[inner_start..inner_end];
        if inner.contains('\n') || inner.contains("[[") {
            i = start + 2;
            continue;
        }
        let embed = start > 0 && bytes[start - 1] == b'!';
        let whole_start = if embed { start - 1 } else { start };
        out.push(Occurrence {
            inner: inner_start..inner_end,
            embed,
            whole: whole_start..inner_end + 2,
        });
        i = inner_end + 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_05_parse_inner_forms() {
        let p = parse_inner("Sparda#Coat|the knight").unwrap();
        assert_eq!(
            (p.target, p.heading, p.alias),
            ("Sparda", Some("Coat"), Some("the knight"))
        );
        assert_eq!(p.target_range, 0..6);
        let p = parse_inner("  spaced  ").unwrap();
        assert_eq!(p.target, "spaced");
        assert_eq!(p.target_range, 2..8);
        assert!(parse_inner("#Heading").is_none());
        assert!(parse_inner("").is_none());
        let p = parse_inner("a|").unwrap();
        assert_eq!(p.alias, None);
    }

    #[test]
    fn pg_05_find_all_handles_embeds_escapes_and_newlines() {
        let t = "a [[x]] ![[img.png]] \\[[no]] [[multi\nline]] [[y|z]]";
        let found: Vec<_> = find_all(t)
            .iter()
            .map(|o| (&t[o.inner.clone()], o.embed))
            .collect();
        assert_eq!(found, vec![("x", false), ("img.png", true), ("y|z", false)]);
    }
}
