//! Search (M5 §2–§3, amendments §10): the typed text as an injection-safe
//! FTS5 query, the filters, ranking, facets and snippets.

use crate::fold::fold;
use crate::index::{Index, Result};
use nimw_markdown::{LinkKind, Tag, resolve};
use rusqlite::types::Value;
use rusqlite::{OptionalExtension, params, params_from_iter};
use unicode_normalization::char::is_combining_mark;

/// Hits per page of results.
pub const MAX_LIMIT: u32 = 50;
/// Pages "Recent" shows for an empty query.
pub const RECENT: u32 = 20;
const TOP_PROJECTS: usize = 20;
const TOP_TAGS: usize = 12;
const TOP_LINKS: usize = 8;
/// Matches above this many are sampled to find the leading tags and pages
/// (their counts stay exact; NFR-03).
const SAMPLE: i64 = 1500;
/// Candidates read per facet entry shown, from the sample.
const LEAD: usize = 3;
/// bm25 weights: title, name, folders, tags, links, body (§2).
const WEIGHTS: &str = "10.0, 8.0, 5.0, 6.0, 4.0, 1.0";
const META_COLUMNS: &str = "{title name folders tags links}";
/// Words in a snippet.
const SNIPPET_WORDS: usize = 12;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchQuery {
    pub text: String,
    /// A top-level folder.
    pub project: Option<String>,
    /// A folder path, or a folder name anywhere (§10.12).
    pub folder: Option<String>,
    /// All must be present; a tag also matches its nested tags.
    pub tags: Vec<String>,
    /// A page path, or a name resolved like `[[name]]`, else a title.
    pub links_to: Option<String>,
    pub links_from: Option<String>,
    pub has_image: bool,
    pub has_audio: bool,
    pub offset: u32,
    /// Clamped to 1–[`MAX_LIMIT`]; 0 means [`MAX_LIMIT`].
    pub limit: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchPage {
    pub results: Vec<SearchHit>,
    pub total: u32,
    pub facets: Facets,
    /// No text and no filters: the most recently modified pages.
    pub recent: bool,
    /// A full re-index is running (set by the session).
    pub indexing: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// The resolved cover's vault path.
    pub cover: Option<String>,
    /// As written, matching ones first.
    pub tags: Vec<String>,
    pub has_image: bool,
    pub has_audio: bool,
    /// About 12 words around the first body match.
    pub snippet: Option<Vec<SnippetPart>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetPart {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facets {
    pub projects: Vec<FacetCount>,
    pub tags: Vec<FacetCount>,
    pub links_to: Vec<FacetPage>,
    /// The active `links_from` filter, resolved (no row offers it).
    pub links_from: Option<FacetPage>,
    pub has_image: u32,
    pub has_audio: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetCount {
    pub value: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetPage {
    pub path: String,
    pub title: String,
    pub count: u32,
    pub active: bool,
}

/// The typed text as FTS5 queries: every word must match (`all`); `any`
/// matches pages where at least one does (the metadata bonus, snippets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FtsText {
    pub all: String,
    pub any: String,
    /// Folded words, for matching tags.
    pub words: Vec<String>,
}

/// A letter or digit, or a combining mark inside a word (FTS5 keeps marks in
/// tokens, so decomposed `Cancio\u{301}n` is one word).
fn word_char(c: char) -> bool {
    c.is_alphanumeric() || is_combining_mark(c)
}

/// Holds a character FTS5 indexes: a word of marks only (`\u{93e}`) would be
/// an empty phrase that matches nothing (final review M3).
// shortcut: alphanumeric minus marks approximates unicode61's L*/N*; symbols
// such as `Ⓐ` slip through, upgrade with a general-category table if it bites.
fn searchable(w: &str) -> bool {
    w.chars()
        .any(|c| c.is_alphanumeric() && !is_combining_mark(c))
}

/// A quoted FTS5 string: whatever it holds is text, never syntax.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Words and `"quoted phrases"` (an unclosed quote runs to the end); `None`
/// when no word holds a letter or digit (an empty query).
pub fn fts_query(text: &str) -> Option<FtsText> {
    // A pasted NUL or other control character splits words (final review M3).
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let text = text.as_str();
    let mut terms: Vec<String> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut add = |chunk: &str, terms: &mut Vec<String>| {
        let ws: Vec<&str> = chunk.split_whitespace().filter(|w| searchable(w)).collect();
        if ws.is_empty() {
            return;
        }
        for w in &ws {
            words.extend(
                w.split(|c: char| !word_char(c))
                    .filter(|t| !t.is_empty())
                    .map(fold),
            );
        }
        terms.push(format!("{} *", quote(&ws.join(" "))));
    };
    let mut rest = text;
    while let Some(i) = rest.find('"') {
        for w in rest[..i].split_whitespace() {
            add(w, &mut terms);
        }
        let after = &rest[i + 1..];
        let end = after.find('"').unwrap_or(after.len());
        add(&after[..end], &mut terms);
        rest = after.get(end + 1..).unwrap_or("");
    }
    for w in rest.split_whitespace() {
        add(w, &mut terms);
    }
    (!terms.is_empty()).then(|| FtsText {
        all: terms.join(" AND "),
        any: terms.join(" OR "),
        words,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dim {
    Project,
    Folder,
    Tags,
    LinksTo,
    LinksFrom,
    Image,
    Audio,
}

struct Filter {
    dim: Dim,
    sql: String,
    params: Vec<Value>,
}

/// Paths in `prefix/` (the byte after `/` is `0`).
fn under(prefix: &str) -> (String, Vec<Value>) {
    (
        "(p.path >= ? AND p.path < ?)".into(),
        vec![
            Value::Text(format!("{prefix}/")),
            Value::Text(format!("{prefix}0")),
        ],
    )
}

fn blank(v: &Option<String>) -> Option<&str> {
    v.as_deref()
        .map(|s| s.trim().trim_matches('/').trim())
        .filter(|s| !s.is_empty())
}

fn tag_key(t: &str) -> String {
    Tag::new(t.trim().trim_start_matches('#')).key
}

fn where_sql(filters: &[Filter], except: Option<Dim>) -> (String, Vec<Value>) {
    let mut sql = vec!["1".to_string()];
    let mut params = Vec::new();
    for f in filters.iter().filter(|f| Some(f.dim) != except) {
        sql.push(f.sql.clone());
        params.extend(f.params.iter().cloned());
    }
    (sql.join(" AND "), params)
}

/// A page reference: its path and title, if it resolves.
type PageRef = Option<(String, String)>;

impl Index {
    /// One page of results, with the facets (M5 §3).
    pub fn search(&self, q: &SearchQuery) -> Result<SearchPage> {
        let text = fts_query(&q.text);
        let project = blank(&q.project);
        let folder = blank(&q.folder);
        let tags: Vec<String> = q
            .tags
            .iter()
            .map(|t| tag_key(t))
            .filter(|t| !t.is_empty())
            .collect();
        let links_to = blank(&q.links_to);
        let links_from = blank(&q.links_from);
        let to = links_to.map(|v| self.page_ref(v)).transpose()?;
        let from = links_from.map(|v| self.page_ref(v)).transpose()?;

        let mut filters = Vec::new();
        if let Some(p) = project {
            let (sql, params) = under(p);
            filters.push(Filter {
                dim: Dim::Project,
                sql,
                params,
            });
        }
        if let Some(v) = folder {
            let mut sql = Vec::new();
            let mut params = Vec::new();
            for path in self.folder_paths(v)? {
                let (s, p) = under(&path);
                sql.push(s);
                params.extend(p);
            }
            let sql = if sql.is_empty() {
                "0".into()
            } else {
                format!("({})", sql.join(" OR "))
            };
            filters.push(Filter {
                dim: Dim::Folder,
                sql,
                params,
            });
        }
        for key in &tags {
            filters.push(Filter {
                dim: Dim::Tags,
                sql: "EXISTS (SELECT 1 FROM tags t WHERE t.path = p.path \
                      AND (t.tag_key = ? OR (t.tag_key >= ? AND t.tag_key < ?)))"
                    .into(),
                params: vec![
                    Value::Text(key.clone()),
                    Value::Text(format!("{key}/")),
                    Value::Text(format!("{key}0")),
                ],
            });
        }
        let page_filter = |dim, resolved: &PageRef, sql: &str| match resolved {
            Some((path, _)) => Filter {
                dim,
                sql: sql.into(),
                params: vec![Value::Text(path.clone())],
            },
            None => Filter {
                dim,
                sql: "0".into(),
                params: Vec::new(),
            },
        };
        if let Some(r) = &to {
            filters.push(page_filter(
                Dim::LinksTo,
                r,
                // A page's link to itself doesn't count, as in the facet (review M4).
                "EXISTS (SELECT 1 FROM links l WHERE l.src = p.path AND l.target_path = ? \
                 AND l.src != l.target_path)",
            ));
        }
        if let Some(r) = &from {
            filters.push(page_filter(
                Dim::LinksFrom,
                r,
                "p.path IN (SELECT l.target_path FROM links l \
                 WHERE l.src = ? AND l.target_path IS NOT NULL)",
            ));
        }
        if q.has_image {
            filters.push(Filter {
                dim: Dim::Image,
                sql: "p.has_image".into(),
                params: Vec::new(),
            });
        }
        if q.has_audio {
            filters.push(Filter {
                dim: Dim::Audio,
                sql: "p.has_audio".into(),
                params: Vec::new(),
            });
        }

        let recent = text.is_none() && filters.is_empty();
        let base = match &text {
            Some(t) => {
                self.fill_hits(t)?;
                "temp.nimw_hits h JOIN pages p ON p.path = h.path JOIN files f ON f.path = p.path"
            }
            None => "pages p JOIN files f ON f.path = p.path",
        };
        let scored = if text.is_some() {
            "h.meta, h.score"
        } else {
            "0, 0"
        };
        let (cond, params) = where_sql(&filters, None);
        // Every match once, in a temp table: the count, the page of results
        // and most facets read it instead of joining again (NFR-03).
        self.conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS nimw_match (path TEXT PRIMARY KEY, \
             meta INTEGER NOT NULL, score REAL NOT NULL, mtime INTEGER NOT NULL, \
             has_image INTEGER NOT NULL, has_audio INTEGER NOT NULL); \
             DELETE FROM temp.nimw_match;",
        )?;
        self.conn.execute(
            &format!(
                "INSERT INTO temp.nimw_match \
                 SELECT p.path, {scored}, f.mtime_ns, p.has_image, p.has_audio \
                 FROM {base} WHERE {cond}"
            ),
            params_from_iter(params.iter()),
        )?;
        let total: i64 = self
            .conn
            .query_row("SELECT count(*) FROM temp.nimw_match", [], |r| r.get(0))?;
        let (limit, offset) = if recent {
            (RECENT, 0)
        } else if q.limit == 0 {
            (MAX_LIMIT, q.offset)
        } else {
            (q.limit.min(MAX_LIMIT), q.offset)
        };
        let total = if recent {
            (total as u32).min(RECENT)
        } else {
            total as u32
        };
        let order = if text.is_some() {
            "meta DESC, score, length(path), mtime DESC, path"
        } else {
            "mtime DESC, path"
        };
        let paths = self
            .conn
            .prepare_cached(&format!(
                "SELECT path FROM temp.nimw_match ORDER BY {order} LIMIT ?1 OFFSET ?2"
            ))?
            .query_map(params![limit, offset], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let words = text.as_ref().map(|t| t.words.as_slice()).unwrap_or(&[]);
        let mut results = Vec::with_capacity(paths.len());
        for path in paths {
            let mut hit = self.conn.prepare_cached(
                "SELECT p.path, p.title, \
                 (SELECT l.target_path FROM links l WHERE l.src = p.path AND l.kind = 'cover' LIMIT 1), \
                 p.has_image, p.has_audio FROM pages p WHERE p.path = ?1",
            )?
            .query_row([&path], |r| {
                Ok(SearchHit {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    cover: r.get(2)?,
                    has_image: r.get(3)?,
                    has_audio: r.get(4)?,
                    tags: Vec::new(),
                    snippet: None,
                })
            })?;
            hit.tags = self.hit_tags(&hit.path, words, &tags)?;
            if !words.is_empty() {
                hit.snippet = self.snippet(&hit.path, words)?;
            }
            results.push(hit);
        }

        let facets = self.facets(
            base,
            &filters,
            total,
            project,
            &q.tags,
            to.as_ref().map(|r| (links_to.unwrap_or_default(), r)),
            from.as_ref().map(|r| (links_from.unwrap_or_default(), r)),
        )?;
        Ok(SearchPage {
            results,
            total,
            facets,
            recent,
            indexing: false,
        })
    }

    /// The text's matches, scored, into the connection's temp table.
    fn fill_hits(&self, text: &FtsText) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS nimw_hits \
             (path TEXT PRIMARY KEY, score REAL NOT NULL, meta INTEGER NOT NULL); \
             DELETE FROM temp.nimw_hits;",
        )?;
        self.conn
            .prepare_cached(&format!(
                "INSERT INTO temp.nimw_hits (path, score, meta) \
                 SELECT pt.path, bm25(fts, {WEIGHTS}), \
                 fts.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?2) \
                 FROM fts JOIN page_text pt ON pt.rowid = fts.rowid WHERE fts MATCH ?1"
            ))?
            .execute(params![
                text.all,
                format!("{META_COLUMNS} : ({})", text.any)
            ])?;
        Ok(())
    }

    /// Folders whose path is `value`, or whose name folds like it.
    fn folder_paths(&self, value: &str) -> Result<Vec<String>> {
        let key = fold(value);
        let mut stmt = self
            .conn
            .prepare_cached("SELECT path, name FROM files WHERE kind = 'folder' ORDER BY path")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (path, name) = row?;
            if path == value || fold(&path) == key || fold(&name) == key {
                out.push(path);
            }
        }
        Ok(out)
    }

    fn page_title(&self, path: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .prepare_cached("SELECT title FROM pages WHERE path = ?1")?
            .query_row([path], |r| r.get(0))
            .optional()?)
    }

    /// A page path, the path plus `.md`, a name resolved like `[[name]]`,
    /// else the first page whose title folds like it.
    fn page_ref(&self, value: &str) -> Result<PageRef> {
        let v = value.trim_start_matches("[[").trim_end_matches("]]").trim();
        if v.is_empty() {
            return Ok(None);
        }
        let mut candidates = vec![v.to_string()];
        if !v.to_lowercase().ends_with(".md") {
            candidates.push(format!("{v}.md"));
        }
        for c in &candidates {
            if let Some(title) = self.page_title(c)? {
                return Ok(Some((c.clone(), title)));
            }
        }
        if let Some(path) = resolve(LinkKind::Wiki, v, "", &self.file_set()?)
            && let Some(title) = self.page_title(&path)?
        {
            return Ok(Some((path, title)));
        }
        let key = fold(v);
        let mut stmt = self
            .conn
            .prepare_cached("SELECT path, title FROM pages ORDER BY path")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (path, title) = row?;
            if fold(&title) == key {
                return Ok(Some((path, title)));
            }
        }
        Ok(None)
    }

    /// The page's tags as written; those a query word starts (or a tag
    /// filter names) first.
    fn hit_tags(&self, path: &str, words: &[String], filters: &[String]) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT tag FROM tags WHERE path = ?1 ORDER BY rowid")?;
        let all = stmt
            .query_map([path], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let matches = |tag: &str| {
            let key = tag.to_lowercase();
            let folded = fold(tag);
            filters
                .iter()
                .any(|f| key == *f || key.starts_with(&format!("{f}/")))
                || words.iter().any(|w| {
                    folded.starts_with(w.as_str())
                        || folded.split('/').any(|s| s.starts_with(w.as_str()))
                })
        };
        let (mut first, rest): (Vec<String>, Vec<String>) =
            all.into_iter().partition(|t| matches(t));
        first.extend(rest);
        Ok(first)
    }

    /// About 12 words around the first body word a query word starts; `None`
    /// when there is none. Read from the stored body in Rust: FTS5's
    /// `snippet()` re-expands every prefix term for each call (NFR-03).
    fn snippet(&self, path: &str, words: &[String]) -> Result<Option<Vec<SnippetPart>>> {
        let body: Option<String> = self
            .conn
            .prepare_cached("SELECT body FROM page_text WHERE path = ?1")?
            .query_row([path], |r| r.get(0))
            .optional()?;
        Ok(body.and_then(|b| snippet_of(&b, words)))
    }

    /// The matches with every filter but `dim`'s, as a temp table: the
    /// materialized matches when `dim` has no active filter, else
    /// `nimw_except`, filled now (one facet at a time uses it). Also its size.
    fn matches_except(
        &self,
        base: &str,
        filters: &[Filter],
        dim: Dim,
    ) -> Result<(&'static str, i64)> {
        let table = if filters.iter().all(|f| f.dim != dim) {
            "temp.nimw_match"
        } else {
            let (cond, params) = where_sql(filters, Some(dim));
            self.conn.execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS nimw_except (path TEXT PRIMARY KEY, \
                 has_image INTEGER NOT NULL, has_audio INTEGER NOT NULL); \
                 DELETE FROM temp.nimw_except;",
            )?;
            self.conn.execute(
                &format!(
                    "INSERT INTO temp.nimw_except \
                     SELECT p.path, p.has_image, p.has_audio FROM {base} WHERE {cond}"
                ),
                params_from_iter(params.iter()),
            )?;
            "temp.nimw_except"
        };
        let n: i64 = self
            .conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
        Ok((table, n))
    }

    /// `table`, or an even sample of about [`SAMPLE`] of its rows when it is
    /// larger: which tags and pages lead is read from it, their counts from
    /// all the matches.
    fn sampled(table: &str, n: i64) -> String {
        if n <= SAMPLE {
            table.to_string()
        } else {
            let step = (n + SAMPLE - 1) / SAMPLE;
            // Rows scattered by an LCG's high bits, so a pattern in the
            // vault (every 20th page tagged) doesn't alias with the step.
            format!(
                "(SELECT path FROM {table} \
                 WHERE ((rowid * 1103515245 + 12345) / 65536) % {step} = 0)"
            )
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn facets(
        &self,
        base: &str,
        filters: &[Filter],
        total: u32,
        project: Option<&str>,
        tags: &[String],
        to: Option<(&str, &PageRef)>,
        from: Option<(&str, &PageRef)>,
    ) -> Result<Facets> {
        let mut facets = Facets::default();

        let (src, _) = self.matches_except(base, filters, Dim::Project)?;
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT substr(m.path, 1, instr(m.path, '/') - 1) AS proj, count(*) AS n \
             FROM {src} m WHERE instr(m.path, '/') > 0 \
             GROUP BY proj ORDER BY n DESC, proj LIMIT {TOP_PROJECTS}"
        ))?;
        facets.projects = stmt
            .query_map([], |r| {
                Ok(FacetCount {
                    value: r.get(0)?,
                    count: r.get::<_, i64>(1)? as u32,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        if let Some(p) = project
            && !facets.projects.iter().any(|f| f.value == p)
        {
            let (_, range) = under(p);
            let n: i64 = self.conn.query_row(
                &format!("SELECT count(*) FROM {src} m WHERE m.path >= ? AND m.path < ?"),
                params_from_iter(range.iter()),
                |r| r.get(0),
            )?;
            facets.projects.push(FacetCount {
                value: p.to_string(),
                count: n as u32,
            });
        }

        // Tags drill down: every filter applies.
        let n: i64 = self
            .conn
            .query_row("SELECT count(*) FROM temp.nimw_match", [], |r| r.get(0))?;
        let sample = Self::sampled("temp.nimw_match", n);
        // CROSS JOIN keeps the matches as the outer loop.
        let lead = self
            .conn
            .prepare_cached(&format!(
                "SELECT t.tag_key FROM {sample} m CROSS JOIN tags t ON t.path = m.path \
                 GROUP BY t.tag_key ORDER BY count(*) DESC, t.tag_key LIMIT {}",
                TOP_TAGS * LEAD
            ))?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut counted = Vec::new();
        for key in lead {
            let (tag, count): (String, i64) = self
                .conn
                .prepare_cached(
                    // A join (key lookups), not `IN (SELECT …)`, which
                    // would copy the matches again for every tag.
                    "SELECT min(t.tag), count(*) FROM tags t \
                     CROSS JOIN temp.nimw_match m ON m.path = t.path WHERE t.tag_key = ?1",
                )?
                .query_row([&key], |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        r.get(1)?,
                    ))
                })?;
            counted.push((
                key,
                FacetCount {
                    value: tag,
                    count: count as u32,
                },
            ));
        }
        counted.sort_by(|a, b| b.1.count.cmp(&a.1.count).then_with(|| a.0.cmp(&b.0)));
        counted.truncate(TOP_TAGS);
        let keys: Vec<String> = counted.iter().map(|(k, _)| k.clone()).collect();
        facets.tags = counted.into_iter().map(|(_, f)| f).collect();
        for t in tags {
            let value = t.trim().trim_start_matches('#');
            if !value.is_empty() && !keys.contains(&tag_key(value)) {
                // Every result has an active tag.
                facets.tags.push(FacetCount {
                    value: value.to_string(),
                    count: total,
                });
            }
        }

        // Links to: the leading targets in (a sample of) the matches, then
        // each one's exact count; a page linking twice counts once.
        let (src, n) = self.matches_except(base, filters, Dim::LinksTo)?;
        let sample = Self::sampled(src, n);
        let lead = self
            .conn
            .prepare_cached(&format!(
                "SELECT l.target_path FROM {sample} m CROSS JOIN links l ON l.src = m.path \
                 WHERE l.target_path IS NOT NULL AND l.target_path != m.path \
                 AND l.target_path LIKE '%.md' \
                 GROUP BY l.target_path ORDER BY count(DISTINCT m.path) DESC, l.target_path \
                 LIMIT {}",
                TOP_LINKS * LEAD
            ))?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut counted = Vec::new();
        for path in lead {
            // Pages only (a `.md` that isn't UTF-8 is an attachment).
            let Some(title) = self.page_title(&path)? else {
                continue;
            };
            let count: i64 = self
                .conn
                .prepare_cached(&format!(
                    "SELECT count(DISTINCT l.src) FROM links l \
                     CROSS JOIN {src} m ON m.path = l.src \
                     WHERE l.target_path = ?1 AND l.src != ?1"
                ))?
                .query_row([&path], |r| r.get(0))?;
            counted.push(FacetPage {
                path,
                title,
                count: count as u32,
                active: false,
            });
        }
        counted.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.path.cmp(&b.path)));
        counted.truncate(TOP_LINKS);
        facets.links_to = counted;
        if let Some((raw, resolved)) = to {
            match resolved {
                Some((path, title)) => match facets.links_to.iter_mut().find(|f| &f.path == path) {
                    Some(f) => f.active = true,
                    None => facets.links_to.push(FacetPage {
                        path: path.clone(),
                        title: title.clone(),
                        count: total,
                        active: true,
                    }),
                },
                None => facets.links_to.push(unresolved(raw)),
            }
        }
        facets.links_from = from.map(|(raw, resolved)| match resolved {
            Some((path, title)) => FacetPage {
                path: path.clone(),
                title: title.clone(),
                count: total,
                active: true,
            },
            None => unresolved(raw),
        });

        for dim in [Dim::Image, Dim::Audio] {
            let (src, _) = self.matches_except(base, filters, dim)?;
            let column = if dim == Dim::Image {
                "has_image"
            } else {
                "has_audio"
            };
            let n: i64 = self.conn.query_row(
                &format!("SELECT count(*) FROM {src} WHERE {column}"),
                [],
                |r| r.get(0),
            )?;
            if dim == Dim::Image {
                facets.has_image = n as u32;
            } else {
                facets.has_audio = n as u32;
            }
        }
        Ok(facets)
    }
}

fn unresolved(raw: &str) -> FacetPage {
    FacetPage {
        path: raw.to_string(),
        title: raw.to_string(),
        count: 0,
        active: true,
    }
}

/// About [`SNIPPET_WORDS`] words of `body` around the first word that a
/// (folded) query word starts, matching words marked; `…` where it was cut.
fn snippet_of(body: &str, words: &[String]) -> Option<Vec<SnippetPart>> {
    let mut chars = body.char_indices().peekable();
    let mut next_token = || {
        while chars.next_if(|&(_, c)| !word_char(c)).is_some() {}
        let (a, _) = *chars.peek()?;
        while chars.next_if(|&(_, c)| word_char(c)).is_some() {}
        Some((a, chars.peek().map_or(body.len(), |&(i, _)| i)))
    };
    let hit = |&(a, b): &(usize, usize)| {
        let folded = fold(&body[a..b]);
        words.iter().any(|w| folded.starts_with(w.as_str()))
    };
    // Only a window of tokens is kept: before the first match, the last
    // SNIPPET_WORDS; after it, its context plus one (final review M7).
    let mut tokens: std::collections::VecDeque<(usize, usize)> = Default::default();
    let mut cut_before = false;
    let mut first = None;
    while let Some(t) = next_token() {
        match first {
            None => {
                if tokens.len() == SNIPPET_WORDS {
                    tokens.pop_front();
                    cut_before = true;
                }
                tokens.push_back(t);
                if hit(&t) {
                    first = Some(tokens.len() - 1);
                }
            }
            Some(f) if tokens.len() > f + SNIPPET_WORDS => break,
            Some(_) => tokens.push_back(t),
        }
    }
    let first = first?;
    let tokens = Vec::from(tokens);
    let from = first
        .saturating_sub(SNIPPET_WORDS / 3)
        .min(tokens.len().saturating_sub(SNIPPET_WORDS));
    let to = (from + SNIPPET_WORDS).min(tokens.len());
    let mut parts: Vec<SnippetPart> = Vec::new();
    let mut push = |text: &str, hit: bool| {
        let text = text.replace(['\n', '\r', '\t'], " ");
        match parts.last_mut() {
            Some(last) if last.hit == hit => last.text.push_str(&text),
            _ if text.is_empty() => {}
            _ => parts.push(SnippetPart { text, hit }),
        }
    };
    if from > 0 || cut_before {
        push("…", false);
    }
    let mut at = tokens[from].0;
    for t in &tokens[from..to] {
        push(&body[at..t.0], false);
        push(&body[t.0..t.1], hit(t));
        at = t.1;
    }
    if to < tokens.len() {
        push("…", false);
    }
    Some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_and_phrases_are_quoted() {
        let q = fts_query("red \"big dragon\" a\"b").unwrap();
        assert_eq!(
            q.all,
            "\"red\" * AND \"big dragon\" * AND \"a\" * AND \"b\" *"
        );
        assert_eq!(q.any, "\"red\" * OR \"big dragon\" * OR \"a\" * OR \"b\" *");
        assert_eq!(q.words, vec!["red", "big", "dragon", "a", "b"]);
    }

    #[test]
    fn operators_and_punctuation_are_text_or_nothing() {
        assert_eq!(fts_query("AND").unwrap().all, "\"AND\" *");
        assert_eq!(fts_query("NEAR(a").unwrap().all, "\"NEAR(a\" *");
        assert!(fts_query("*** - \"\" \u{301}").is_none());
        assert!(fts_query("").is_none());
    }

    #[test]
    fn snippets_mark_prefixes_around_the_first_match() {
        let words = vec!["drag".to_string()];
        let body = "one two three four five six seven eight Dragón nine ten eleven twelve thirteen fourteen";
        let parts = snippet_of(body, &words).unwrap();
        let text: String = parts.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(
            text,
            "…four five six seven eight Dragón nine ten eleven twelve thirteen fourteen"
        );
        assert_eq!(
            parts
                .iter()
                .filter(|p| p.hit)
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Dragón"]
        );
        let short = snippet_of("a\nDRAGON b", &words).unwrap();
        assert_eq!(
            short,
            vec![
                SnippetPart {
                    text: "a ".into(),
                    hit: false
                },
                SnippetPart {
                    text: "DRAGON".into(),
                    hit: true
                },
                SnippetPart {
                    text: " b".into(),
                    hit: false
                },
            ]
        );
        assert!(snippet_of("no match here", &words).is_none());
        assert!(snippet_of("", &words).is_none());
        assert!(snippet_of("undragon", &words).is_none(), "word starts only");
    }
}
