//! A Notion page's Markdown, made a vault page's (M7 §6): relative links as
//! `[[wikilinks]]` and embeds, `<aside>` and `<details>` as callouts, a
//! database row's property lines dropped.

use percent_encoding::percent_decode_str;

/// What an export path became in the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A page (or a database's index page): the text to put in `[[…]]`.
    Page(String),
    /// Any other file: its vault path, for `![[…]]` / `[[…]]`.
    Asset(String),
}

/// Answers where an export path went.
pub trait Resolver {
    fn target(&self, export_path: &[String]) -> Option<Target>;
}

/// `href` (percent-encoded, relative to `dir`) as export path components;
/// `None` when it climbs above the export.
pub(crate) fn resolve_href(dir: &[String], href: &str) -> Option<Vec<String>> {
    let decoded = percent_decode_str(href).decode_utf8_lossy();
    let mut out: Vec<String> = dir.to_vec();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            p => out.push(p.to_string()),
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Is `href` a link out of the export: a scheme, an anchor or an email?
fn is_external(href: &str) -> bool {
    if href.starts_with('#') {
        return true;
    }
    match href.find(':') {
        Some(i) => !href[..i].contains('/') && href[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)),
        None => false,
    }
}

/// A wikilink's text, safe inside `[[…|…]]`.
fn alias(text: &str) -> String {
    text.replace('|', "-").replace("]]", "] ]").replace('\n', " ")
}

fn last_name(target: &str) -> &str {
    target.rsplit('/').next().unwrap_or(target)
}

/// One link `[text](href)` (embed when `bang`) as the vault writes it, or
/// `None` to keep it as it was.
fn rewrite_link(bang: bool, text: &str, href: &str, dir: &[String], r: &dyn Resolver, missing: &mut Vec<String>) -> Option<String> {
    let href = href.trim().trim_start_matches('<').trim_end_matches('>');
    if href.is_empty() || is_external(href) {
        return None;
    }
    let (path, anchor) = match href.split_once('#') {
        Some((p, a)) => (p, Some(a)),
        None => (href, None),
    };
    let Some(orig) = resolve_href(dir, path) else {
        missing.push(href.to_string());
        return None;
    };
    let anchor = anchor
        .map(|a| format!("#{}", percent_decode_str(a).decode_utf8_lossy()))
        .unwrap_or_default();
    let (target, page) = match r.target(&orig) {
        Some(Target::Page(t)) => (t, true),
        Some(Target::Asset(p)) => (p, false),
        None => {
            missing.push(percent_decode_str(href).decode_utf8_lossy().into_owned());
            return None;
        }
    };
    let bang = if bang { "!" } else { "" };
    let shown = text.trim();
    let named = shown.is_empty() || shown == last_name(&target) || (page && shown == format!("{}.md", last_name(&target)));
    Some(if bang == "!" || named {
        format!("{bang}[[{target}{anchor}]]")
    } else {
        format!("[[{target}{anchor}|{}]]", alias(shown))
    })
}

/// The index of the `close` matching the `open` at `start`, or `None`.
fn matching(chars: &[char], start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    for (i, &c) in chars.iter().enumerate().skip(start) {
        if c == '\\' {
            continue;
        }
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// Rewrites the links of one line outside code spans.
fn rewrite_line(line: &str, dir: &[String], r: &dyn Resolver, missing: &mut Vec<String>) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '`' {
            // A code span: copied as is up to its closing run of backticks.
            let run = chars[i..].iter().take_while(|&&b| b == '`').count();
            let rest: String = chars[i + run..].iter().collect();
            let fence = "`".repeat(run);
            match rest.find(&fence) {
                Some(end) => {
                    let len = rest[..end].chars().count() + run;
                    out.extend(&chars[i..i + run + len]);
                    i += run + len;
                }
                None => {
                    out.extend(&chars[i..]);
                    i = chars.len();
                }
            }
            continue;
        }
        let bang = c == '!' && chars.get(i + 1) == Some(&'[');
        let open = if bang { i + 1 } else { i };
        if chars.get(open) == Some(&'[') && (bang || c == '[') {
            if let Some(close) = matching(&chars, open, '[', ']') {
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(end) = matching(&chars, close + 1, '(', ')') {
                        let text: String = chars[open + 1..close].iter().collect();
                        let href: String = chars[close + 2..end].iter().collect();
                        if let Some(new) = rewrite_link(bang, &text, &href, dir, r, missing) {
                            out.push_str(&new);
                            i = end + 1;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    line.len() - t.len() < 4 && (t.starts_with("```") || t.starts_with("~~~"))
}

/// The text of `<summary>…</summary>` in `line`, if it holds one.
fn summary(line: &str) -> Option<String> {
    let start = line.find("<summary>")? + "<summary>".len();
    let end = line[start..].find("</summary>")? + start;
    Some(line[start..end].trim().to_string())
}

/// `<aside>` → `> [!note]`, `<details><summary>T</summary>` → `> [!note]- T`,
/// their bodies quoted (nesting adds a level); code fences left alone.
pub(crate) fn callouts(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut depth = 0usize;
    let mut fenced = false;
    let mut i = 0;
    let quote = |depth: usize, line: &str| {
        let prefix = "> ".repeat(depth);
        if line.trim().is_empty() { prefix.trim_end().to_string() } else { format!("{prefix}{line}") }
    };
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        if !fenced {
            if t == "<aside>" {
                out.push(quote(depth, "> [!note]"));
                depth += 1;
                i += 1;
                continue;
            }
            if t.starts_with("<details>") || t.starts_with("<details ") {
                let mut title = summary(t);
                if title.is_none() {
                    if let Some(next) = lines.get(i + 1).and_then(|n| summary(n.trim())) {
                        title = Some(next);
                        i += 1;
                    }
                }
                let head = format!("> [!note]- {}", title.unwrap_or_default());
                out.push(quote(depth, head.trim_end()));
                depth += 1;
                i += 1;
                continue;
            }
            if (t == "</aside>" || t == "</details>") && depth > 0 {
                depth -= 1;
                i += 1;
                continue;
            }
        }
        if is_fence(line) {
            fenced = !fenced;
        }
        out.push(quote(depth, line));
        i += 1;
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// A page's Markdown as the vault's: links rewritten (relative to `dir`, the
/// page's export folder), Notion's HTML callouts made Markdown ones. Links
/// that point nowhere are kept and returned for the report.
pub fn convert(text: &str, dir: &[String], r: &dyn Resolver) -> (String, Vec<String>) {
    let mut missing = Vec::new();
    let mut fenced = false;
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        if is_fence(line) {
            fenced = !fenced;
            lines.push(line.to_string());
        } else if fenced {
            lines.push(line.to_string());
        } else {
            lines.push(rewrite_line(line, dir, r, &mut missing));
        }
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    (callouts(&out), missing)
}

/// A database row page without the `Key: value` lines Notion writes under
/// its title for `keys` (they move to frontmatter).
pub fn strip_properties(text: &str, keys: &[String]) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let Some(title) = lines.iter().position(|l| !l.trim().is_empty()) else {
        return text.to_string();
    };
    if !lines[title].starts_with("# ") {
        return text.to_string();
    }
    let mut i = title + 1;
    while i < lines.len() && lines[i].trim().is_empty() {
        i += 1;
    }
    let start = i;
    while i < lines.len() {
        match lines[i].split_once(':') {
            Some((k, _)) if keys.iter().any(|key| key == k.trim()) => i += 1,
            _ => break,
        }
    }
    if i == start {
        return text.to_string();
    }
    while i < lines.len() && lines[i].trim().is_empty() {
        i += 1;
    }
    let mut out = lines[..=title].join("\n");
    if i < lines.len() {
        out.push_str("\n\n");
        out.push_str(&lines[i..].join("\n"));
    }
    out.push('\n');
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    pub(crate) struct Map(pub HashMap<String, Target>);

    impl Resolver for Map {
        fn target(&self, p: &[String]) -> Option<Target> {
            self.0.get(&p.join("/")).cloned()
        }
    }

    fn map() -> Map {
        Map(HashMap::from([
            ("Home abc/Child def.md".into(), Target::Page("Child".into())),
            ("Home abc/Notes.md".into(), Target::Page("Home/Notes".into())),
            ("Tasks 123.csv".into(), Target::Page("Tasks".into())),
            ("Home abc/pic one.png".into(), Target::Asset("Home/pic one.png".into())),
            ("Home abc/doc.pdf".into(), Target::Asset("Home/doc.pdf".into())),
        ]))
    }

    fn dir() -> Vec<String> {
        vec!["Home abc".to_string()]
    }

    #[test]
    fn m7_links_become_wikilinks() {
        let (out, missing) = convert(
            "See [Child](Child%20def.md), [my notes](Notes.md) and [Tasks](../Tasks%20123.csv).\n",
            &dir(),
            &map(),
        );
        assert_eq!(out, "See [[Child]], [[Home/Notes|my notes]] and [[Tasks]].\n");
        assert!(missing.is_empty());
    }

    #[test]
    fn m7_files_become_embeds_and_links() {
        let (out, _) = convert("![pic one.png](pic%20one.png)\n[doc.pdf](doc.pdf)\n", &dir(), &map());
        assert_eq!(out, "![[Home/pic one.png]]\n[[Home/doc.pdf]]\n");
    }

    #[test]
    fn m7_outside_links_and_code_stay() {
        let text = "[web](https://x.org/a.md) [mail](mailto:a@b.c) [top](#top) `[c](Child%20def.md)`\n```\n[c](Child%20def.md)\n```\n";
        let (out, missing) = convert(text, &dir(), &map());
        assert_eq!(out, text);
        assert!(missing.is_empty());
    }

    #[test]
    fn m7_missing_targets_are_kept_and_reported() {
        let (out, missing) = convert("[gone](Gone%20x.md) [up](../../x.md)\n", &dir(), &map());
        assert_eq!(out, "[gone](Gone%20x.md) [up](../../x.md)\n");
        assert_eq!(missing, ["Gone x.md", "../../x.md"]);
    }

    #[test]
    fn m7_anchors_and_awkward_text() {
        let (out, _) = convert("[A | B](Child%20def.md#Part%20two)\n", &dir(), &map());
        assert_eq!(out, "[[Child#Part two|A - B]]\n");
    }

    #[test]
    fn m7_asides_and_toggles_become_callouts() {
        let text = "<aside>\n💡 Remember\n\nthis\n</aside>\n\n<details>\n<summary>More</summary>\n\nHidden\n<aside>\nIn\n</aside>\n</details>\nAfter\n";
        let (out, _) = convert(text, &[], &map());
        assert_eq!(
            out,
            "> [!note]\n> 💡 Remember\n>\n> this\n\n> [!note]- More\n>\n> Hidden\n> > [!note]\n> > In\nAfter\n"
        );
    }

    #[test]
    fn m7_property_lines_move_out() {
        let keys = vec!["Status".to_string(), "Due".to_string()];
        let text = "# Write intro\n\nStatus: Done\nDue: October 1, 2026\n\nBody: stays\n";
        assert_eq!(strip_properties(text, &keys), "# Write intro\n\nBody: stays\n");
        let plain = "# T\n\nNote: not a column\n";
        assert_eq!(strip_properties(plain, &keys), plain);
    }
}
