//! Notion databases (M7 §7): the CSV parsed, each column's type inferred,
//! rows as frontmatter, and the database's index page.

use crate::markdown::{Resolver, Target, resolve_href};

/// A database's CSV: the header and the rows (the first column is the title).
#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    kinds: Vec<Kind>,
}

/// What a column holds, from all its non-empty values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Bool,
    Number,
    Date,
    Relation,
    List,
    Text,
}

/// RFC 4180: quoted fields, `""` escapes, newlines inside quotes; a BOM and
/// blank lines dropped.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            (true, '"') => quoted = false,
            (true, c) => field.push(c),
            (false, '"') if field.is_empty() => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut field)),
            (false, '\r') => {}
            (false, '\n') => {
                row.push(std::mem::take(&mut field));
                if !(row.len() == 1 && row[0].is_empty()) {
                    rows.push(std::mem::take(&mut row));
                }
                row.clear();
            }
            (false, c) => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// `THH:MM`, then optionally `:SS` (with a fraction), then `Z` or `±HH:MM`:
/// anything else after an ISO date is text (and quoted), never written raw.
fn iso_time(rest: &str) -> bool {
    let b = rest.as_bytes();
    let two = |i: usize| {
        b.get(i..i + 2)
            .is_some_and(|d| d.iter().all(u8::is_ascii_digit))
    };
    if b.first() != Some(&b'T') || !two(1) || b.get(3) != Some(&b':') || !two(4) {
        return false;
    }
    let mut i = 6;
    if b.get(i) == Some(&b':') {
        if !two(i + 1) {
            return false;
        }
        i += 3;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return false;
            }
        }
    }
    match b.get(i) {
        None => true,
        Some(b'Z') => i + 1 == b.len(),
        Some(b'+' | b'-') => {
            two(i + 1) && b.get(i + 3) == Some(&b':') && two(i + 4) && i + 6 == b.len()
        }
        _ => false,
    }
}

/// Notion's `October 18, 2026` (or `Oct 18, 2026`), optionally followed by a
/// time (`3:15 PM`, `15:15`), and ISO / `2026/10/18` dates, as ISO 8601.
fn iso_date(s: &str) -> Option<String> {
    let s = s.trim();
    let digits = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit());
    // 2026-10-18 or 2026/10/18 (a time after ISO dates is kept as written).
    let sep = if s.len() >= 10 { s.as_bytes()[4] } else { 0 };
    // `get`, not slicing: a multi-byte character may sit where a digit would.
    if (sep == b'-' || sep == b'/')
        && s.as_bytes()[7] == sep
        && s.get(..4).is_some_and(digits)
        && s.get(5..7).is_some_and(digits)
        && s.get(8..10).is_some_and(digits)
    {
        let rest = &s[10..];
        if rest.is_empty() || (sep == b'-' && iso_time(rest)) {
            return Some(format!("{}-{}-{}{rest}", &s[..4], &s[5..7], &s[8..10]));
        }
        return None;
    }
    let (month, rest) = s.split_once(' ')?;
    let m = MONTHS.iter().position(|name| {
        name.eq_ignore_ascii_case(month)
            || (month.len() == 3 && name[..3].eq_ignore_ascii_case(month))
    })? + 1;
    let (day, rest) = rest.split_once(", ")?;
    let (year, time) = match rest.split_once(' ') {
        Some((y, t)) => (y, Some(t)),
        None => (rest, None),
    };
    if !digits(day) || day.len() > 2 || !digits(year) || year.len() != 4 {
        return None;
    }
    let d: u32 = day.parse().ok()?;
    if !(1..=31).contains(&d) {
        return None;
    }
    let date = format!("{year}-{m:02}-{d:02}");
    let Some(time) = time else { return Some(date) };
    let (clock, pm) = match time.rsplit_once(' ') {
        Some((c, "PM")) => (c, Some(true)),
        Some((c, "AM")) => (c, Some(false)),
        _ => (time, None),
    };
    let (h, min) = clock.split_once(':')?;
    if !digits(h) || !digits(min) || min.len() != 2 {
        return None;
    }
    let mut h: u32 = h.parse().ok()?;
    match pm {
        Some(true) if h < 12 => h += 12,
        Some(false) if h == 12 => h = 0,
        _ => {}
    }
    (h < 24).then(|| format!("{date}T{h:02}:{min}"))
}

/// A date or a Notion date range (`A → B`) as its YAML value: a plain ISO
/// date, or the range quoted (`"2026-10-18 → 2026-10-20"`).
fn date_value(s: &str) -> Option<String> {
    if let Some(date) = iso_date(s) {
        return Some(date);
    }
    let (from, to) = s.split_once(" → ")?;
    Some(quoted(&format!("{} → {}", iso_date(from)?, iso_date(to)?)))
}

/// `, ` then a year: a date or place written with a comma, never a list.
fn comma_year(s: &str) -> bool {
    s.match_indices(", ").any(|(i, _)| {
        let rest = &s.as_bytes()[i + 2..];
        rest.len() >= 4 && rest[..4].iter().all(u8::is_ascii_digit)
    })
}

/// A plain decimal number YAML reads back as itself (no leading zeros).
fn is_number(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    let digits = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit());
    digits(int) && (int == "0" || !int.starts_with('0')) && frac.is_none_or(digits)
}

/// `Name (path.md), Other (path2.md)` → [(name, href)], or `None`.
fn relations(s: &str) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut rest = s.trim();
    while !rest.is_empty() {
        let end = rest.find(".md)")? + 4;
        let item = &rest[..end];
        let open = item.rfind(" (")?;
        out.push((
            item[..open].trim().to_string(),
            item[open + 2..end - 1].to_string(),
        ));
        rest = rest[end..].trim_start_matches(',').trim_start();
    }
    (!out.is_empty()).then_some(out)
}

fn infer(values: &[&str]) -> Kind {
    let values: Vec<&str> = values
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect();
    if values.is_empty() {
        return Kind::Text;
    }
    let all = |f: &dyn Fn(&str) -> bool| values.iter().all(|v| f(v));
    if all(&|v| v == "Yes" || v == "No") {
        Kind::Bool
    } else if all(&is_number) {
        Kind::Number
    } else if all(&|v| date_value(v).is_some()) {
        Kind::Date
    } else if all(&|v| relations(v).is_some()) {
        Kind::Relation
    } else if values.iter().any(|v| v.contains(", "))
        && !values
            .iter()
            .any(|v| date_value(v).is_some() || comma_year(v))
        && all(&|v| v.chars().count() <= 200 && v.split(", ").all(|p| p.chars().count() <= 60))
    {
        Kind::List
    } else {
        Kind::Text
    }
}

/// A YAML double-quoted scalar (JSON's escapes are YAML's).
fn quoted(s: &str) -> String {
    serde_json::to_string(s).expect("a string serializes")
}

/// A key written plain when that is unambiguous, else quoted: a key YAML
/// would read as a boolean, null or number (`true`, `1`) is quoted.
fn yaml_key(k: &str) -> String {
    const RESERVED: [&str; 9] = ["true", "false", "yes", "no", "on", "off", "null", "y", "n"];
    let plain = k.chars().next().is_some_and(|c| c.is_alphabetic())
        && k.chars().all(|c| c.is_alphanumeric() || " _-".contains(c))
        && !k.ends_with(' ')
        && !RESERVED.iter().any(|r| r.eq_ignore_ascii_case(k));
    if plain { k.to_string() } else { quoted(k) }
}

impl Table {
    /// The CSV of a database; `None` when it has no header.
    pub fn parse(text: &str) -> Option<Table> {
        let mut rows = parse_csv(text);
        if rows.is_empty() {
            return None;
        }
        let headers: Vec<String> = rows
            .remove(0)
            .into_iter()
            .map(|h| h.trim().to_string())
            .collect();
        let kinds = (0..headers.len())
            .map(|i| {
                let column: Vec<&str> = rows
                    .iter()
                    .map(|r| r.get(i).map_or("", String::as_str))
                    .collect();
                infer(&column)
            })
            .collect();
        Some(Table {
            headers,
            rows,
            kinds,
        })
    }

    /// The title of row `i` (its first column).
    pub fn title(&self, i: usize) -> &str {
        self.rows[i].first().map_or("", |t| t.trim())
    }

    /// Row `i`'s frontmatter block (`---` … `---`), `None` when every
    /// property is empty. Relations resolve against `dir`, the CSV's folder.
    pub fn frontmatter(&self, i: usize, dir: &[String], r: &dyn Resolver) -> Option<String> {
        let mut lines = Vec::new();
        // A header that repeats gets ` 2`, ` 3`…: YAML keys must differ.
        let mut seen: Vec<String> = Vec::new();
        for (col, header) in self.headers.iter().enumerate().skip(1) {
            let value = self.rows[i].get(col).map_or("", |v| v.trim());
            if value.is_empty() || header.is_empty() {
                continue;
            }
            let yaml = match self.kinds[col] {
                Kind::Bool => (value == "Yes").to_string(),
                Kind::Number => value.to_string(),
                Kind::Date => date_value(value).unwrap_or_else(|| quoted(value)),
                Kind::Relation => {
                    let links: Vec<String> = relations(value)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(name, href)| {
                            let target = resolve_href(dir, &href).and_then(|p| r.target(&p));
                            let text = match target {
                                Some(Target::Page(t) | Target::Asset(t)) => t,
                                None => name,
                            };
                            quoted(&format!("[[{text}]]"))
                        })
                        .collect();
                    format!("[{}]", links.join(", "))
                }
                Kind::List => {
                    let items: Vec<String> = value.split(", ").map(|v| quoted(v.trim())).collect();
                    format!("[{}]", items.join(", "))
                }
                Kind::Text => quoted(value),
            };
            let mut key = header.clone();
            let mut n = 1;
            while seen.iter().any(|k| k.eq_ignore_ascii_case(&key)) {
                n += 1;
                key = format!("{header} {n}");
            }
            seen.push(key.clone());
            lines.push(format!("{}: {yaml}", yaml_key(&key)));
        }
        (!lines.is_empty()).then(|| format!("---\n{}\n---\n", lines.join("\n")))
    }

    /// The database's index page: its title and a table linking every row
    /// (`targets[i]`: row `i`'s vault path without `.md`).
    pub fn index_page(&self, title: &str, targets: &[String]) -> String {
        let cell = |s: &str| {
            s.trim()
                .replace('|', "\\|")
                .replace("\r\n", "<br>")
                .replace('\n', "<br>")
        };
        let mut out = format!("# {title}\n\n");
        let headers: Vec<String> = self.headers.iter().map(|h| cell(h)).collect();
        out.push_str(&format!("| {} |\n", headers.join(" | ")));
        out.push_str(&format!("|{}\n", " --- |".repeat(headers.len().max(1))));
        for (i, row) in self.rows.iter().enumerate() {
            let mut cells = vec![format!("[[{}\\|{}]]", targets[i], cell(self.title(i)))];
            cells.extend(
                (1..self.headers.len()).map(|c| cell(row.get(c).map_or("", String::as_str))),
            );
            out.push_str(&format!("| {} |\n", cells.join(" | ")));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::tests::Map;
    use std::collections::HashMap;

    #[test]
    fn m7_parses_csv() {
        let rows = parse_csv("\u{feff}Name,Notes\r\n\"A, b\",\"line\nnext \"\"q\"\"\"\r\n\r\nC,\n");
        assert_eq!(
            rows,
            [
                vec!["Name", "Notes"],
                vec!["A, b", "line\nnext \"q\""],
                vec!["C", ""]
            ]
        );
    }

    #[test]
    fn m7_dates() {
        assert_eq!(iso_date("October 18, 2026").as_deref(), Some("2026-10-18"));
        assert_eq!(
            iso_date("Oct 8, 2026 3:05 PM").as_deref(),
            Some("2026-10-08T15:05")
        );
        assert_eq!(
            iso_date("January 1, 2026 12:30 AM").as_deref(),
            Some("2026-01-01T00:30")
        );
        assert_eq!(iso_date("2026/10/18").as_deref(), Some("2026-10-18"));
        assert_eq!(
            iso_date("2026-10-18T09:00").as_deref(),
            Some("2026-10-18T09:00")
        );
        assert_eq!(iso_date("October 18, 2026 → October 20, 2026"), None);
        assert_eq!(iso_date("Maybe 1, 2026"), None);
    }

    #[test]
    fn b6_review_i1_a_multi_byte_character_after_a_date_never_panics() {
        assert_eq!(iso_date("2026-10-1é"), None);
        assert_eq!(iso_date("2026-10-18é"), None);
        let t = Table::parse("Name,When\nA,2026-10-1é\n").unwrap();
        assert_eq!(t.kinds[1], Kind::Text);
    }

    #[test]
    fn b6_review_i6_date_ranges_are_dates_never_lists() {
        let csv = "Name,Due,Where\nA,\"October 18, 2026\",\"Paris, 2026\"\nB,\"October 18, 2026 → October 20, 2026\",\"Rome, 2025\"\n";
        let t = Table::parse(csv).unwrap();
        assert_eq!(t.kinds[1], Kind::Date);
        assert_eq!(t.kinds[2], Kind::Text);
        let r = Map(HashMap::new());
        assert_eq!(
            t.frontmatter(0, &[], &r).unwrap(),
            "---\nDue: 2026-10-18\nWhere: \"Paris, 2026\"\n---\n"
        );
        assert_eq!(
            t.frontmatter(1, &[], &r).unwrap(),
            "---\nDue: \"2026-10-18 → 2026-10-20\"\nWhere: \"Rome, 2025\"\n---\n"
        );
    }

    #[test]
    fn b6_review_m4_frontmatter_can_not_be_broken_out_of() {
        assert_eq!(
            iso_date("2026-10-18T09:00").as_deref(),
            Some("2026-10-18T09:00")
        );
        assert_eq!(
            iso_date("2026-10-18T09:00:30Z").as_deref(),
            Some("2026-10-18T09:00:30Z")
        );
        assert_eq!(
            iso_date("2026-10-18T09:00+02:00").as_deref(),
            Some("2026-10-18T09:00+02:00")
        );
        assert_eq!(iso_date("2026-10-18T\n---\ncover: x"), None);
        assert_eq!(iso_date("2026-10-18Tbad"), None);
        let csv = "Name,When,true,1,null,Tag,Tag\nA,\"2026-10-18T\n---\ncover: https://evil/x.png\",a,b,c,d,e\n";
        let t = Table::parse(csv).unwrap();
        let front = t.frontmatter(0, &[], &Map(HashMap::new())).unwrap();
        assert_eq!(
            front,
            "---\nWhen: \"2026-10-18T\\n---\\ncover: https://evil/x.png\"\n\"true\": \"a\"\n\"1\": \"b\"\n\"null\": \"c\"\nTag: \"d\"\nTag 2: \"e\"\n---\n"
        );
    }

    #[test]
    fn m7_infers_column_types() {
        let csv = "Name,Done,Points,Due,Tags,Note,Code,Owner\n\
                   A,Yes,3,\"October 1, 2026\",\"red, blue\",\"Hello, world: a long sentence that is definitely more than sixty characters long\",007,Ana\n\
                   B,No,-2.5,,green,x,12,\n";
        let t = Table::parse(csv).unwrap();
        assert_eq!(
            t.kinds,
            [
                Kind::Text,
                Kind::Bool,
                Kind::Number,
                Kind::Date,
                Kind::List,
                Kind::Text,
                Kind::Text,
                Kind::Text
            ]
        );
        let r = Map(HashMap::new());
        assert_eq!(
            t.frontmatter(0, &[], &r).unwrap(),
            "---\nDone: true\nPoints: 3\nDue: 2026-10-01\nTags: [\"red\", \"blue\"]\nNote: \"Hello, world: a long sentence that is definitely more than sixty characters long\"\nCode: \"007\"\nOwner: \"Ana\"\n---\n"
        );
        assert_eq!(
            t.frontmatter(1, &[], &r).unwrap(),
            "---\nDone: false\nPoints: -2.5\nTags: [\"green\"]\nNote: \"x\"\nCode: \"12\"\n---\n"
        );
    }

    #[test]
    fn m7_relations_become_links() {
        let csv = "Name,Project,Odd: key\nA,\"Big (Projects%20abc/Big%20def.md), Gone (x.md)\",v\n";
        let t = Table::parse(csv).unwrap();
        let r = Map(HashMap::from([(
            "Tasks/Projects abc/Big def.md".to_string(),
            Target::Page("Big".to_string()),
        )]));
        assert_eq!(
            t.frontmatter(0, &["Tasks".to_string()], &r).unwrap(),
            "---\nProject: [\"[[Big]]\", \"[[Gone]]\"]\n\"Odd: key\": \"v\"\n---\n"
        );
    }

    #[test]
    fn m7_index_page() {
        let t = Table::parse("Name,Status\nA | 1,Done\nB,\"two\nlines\"\n").unwrap();
        let page = t.index_page("Tasks", &["Tasks/A - 1".into(), "Tasks/B".into()]);
        assert_eq!(
            page,
            "# Tasks\n\n| Name | Status |\n| --- | --- |\n| [[Tasks/A - 1\\|A \\| 1]] | Done |\n| [[Tasks/B\\|B]] | two<br>lines |\n"
        );
    }
}
