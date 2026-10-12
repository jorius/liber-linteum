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
    let (target_part, alias) = match inner.find('|') {
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
}
