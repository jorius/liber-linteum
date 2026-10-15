//! Search (M5 §2–§3, amendments §10): the typed text as an injection-safe
//! FTS5 query, the filters, ranking, facets and snippets.

use crate::fold::fold;
use crate::index::{Index, Result};
use nimw_markdown::{LinkKind, Tag, resolve};
use rusqlite::types::Value;
use rusqlite::{OptionalExtension, params, params_from_iter};

/// Hits per page of results.
pub const MAX_LIMIT: u32 = 50;
/// Pages "Recent" shows for an empty query.
pub const RECENT: u32 = 20;
const TOP_PROJECTS: usize = 20;
const TOP_TAGS: usize = 12;
const TOP_LINKS: usize = 8;
/// bm25 weights: title, name, folders, tags, links, body (§2).
const WEIGHTS: &str = "10.0, 8.0, 5.0, 6.0, 4.0, 1.0";
const META_COLUMNS: &str = "{title name folders tags links}";
/// Snippet markers: control characters, which body text never holds.
const OPEN: char = '\u{1}';
const CLOSE: char = '\u{2}';

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

fn searchable(w: &str) -> bool {
    w.chars().any(char::is_alphanumeric)
}

/// A quoted FTS5 string: whatever it holds is text, never syntax.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Words and `"quoted phrases"` (an unclosed quote runs to the end); `None`
/// when no word holds a letter or digit (an empty query).
pub fn fts_query(text: &str) -> Option<FtsText> {
    let mut terms: Vec<String> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut add = |chunk: &str, terms: &mut Vec<String>| {
        let ws: Vec<&str> = chunk.split_whitespace().filter(|w| searchable(w)).collect();
        if ws.is_empty() {
            return;
        }
        for w in &ws {
            words.extend(
                w.split(|c: char| !c.is_alphanumeric())
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
                "EXISTS (SELECT 1 FROM links l WHERE l.src = p.path AND l.target_path = ?)",
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
        let order = if text.is_some() {
            "h.meta DESC, h.score, length(p.path), f.mtime_ns DESC, p.path"
        } else {
            "f.mtime_ns DESC, p.path"
        };
        let (limit, offset) = if recent {
            (RECENT, 0)
        } else {
            let limit = if q.limit == 0 {
                MAX_LIMIT
            } else {
                q.limit.min(MAX_LIMIT)
            };
            (limit, q.offset)
        };
        let (cond, mut params) = where_sql(&filters, None);
        let total = self.count(base, &cond, &params)?;
        let total = if recent { total.min(RECENT) } else { total };

        params.push(Value::Integer(limit.into()));
        params.push(Value::Integer(offset.into()));
        let mut stmt = self.conn.prepare(&format!(
            "SELECT p.path, p.title, \
             (SELECT l.target_path FROM links l WHERE l.src = p.path AND l.kind = 'cover' LIMIT 1), \
             p.has_image, p.has_audio FROM {base} WHERE {cond} ORDER BY {order} LIMIT ? OFFSET ?"
        ))?;
        let rows = stmt
            .query_map(params_from_iter(params), |r| {
                Ok(SearchHit {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    cover: r.get(2)?,
                    has_image: r.get(3)?,
                    has_audio: r.get(4)?,
                    tags: Vec::new(),
                    snippet: None,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let words = text.as_ref().map(|t| t.words.as_slice()).unwrap_or(&[]);
        let mut results = Vec::with_capacity(rows.len());
        for mut hit in rows {
            hit.tags = self.hit_tags(&hit.path, words, &tags)?;
            if let Some(t) = &text {
                hit.snippet = self.snippet(&hit.path, &t.any)?;
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

    fn count(&self, base: &str, cond: &str, params: &[Value]) -> Result<u32> {
        let n: i64 = self.conn.query_row(
            &format!("SELECT count(*) FROM {base} WHERE {cond}"),
            params_from_iter(params.iter()),
            |r| r.get(0),
        )?;
        Ok(n as u32)
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

    /// About 12 words around the first body match; `None` when the body
    /// doesn't match.
    fn snippet(&self, path: &str, any: &str) -> Result<Option<Vec<SnippetPart>>> {
        let found: Option<String> = self
            .conn
            .prepare_cached(
                "SELECT snippet(fts, 5, char(1), char(2), '…', 12) FROM fts \
                 WHERE fts MATCH ?1 AND rowid = (SELECT rowid FROM page_text WHERE path = ?2)",
            )?
            .query_row(params![format!("{{body}} : ({any})"), path], |r| r.get(0))
            .optional()?;
        Ok(found.and_then(|s| snippet_parts(&s)))
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

        let (cond, params) = where_sql(filters, Some(Dim::Project));
        let mut stmt = self.conn.prepare(&format!(
            "SELECT substr(p.path, 1, instr(p.path, '/') - 1) AS proj, count(*) AS n \
             FROM {base} WHERE instr(p.path, '/') > 0 AND {cond} \
             GROUP BY proj ORDER BY n DESC, proj LIMIT {TOP_PROJECTS}"
        ))?;
        facets.projects = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                Ok(FacetCount {
                    value: r.get(0)?,
                    count: r.get::<_, i64>(1)? as u32,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        if let Some(p) = project
            && !facets.projects.iter().any(|f| f.value == p)
        {
            let (sql, mut own) = under(p);
            let mut all = params.clone();
            all.append(&mut own);
            let count = self.count(base, &format!("{cond} AND {sql}"), &all)?;
            facets.projects.push(FacetCount {
                value: p.to_string(),
                count,
            });
        }

        let (cond, params) = where_sql(filters, None);
        let mut stmt = self.conn.prepare(&format!(
            "SELECT t.tag_key, min(t.tag), count(DISTINCT p.path) AS n \
             FROM {base} JOIN tags t ON t.path = p.path WHERE {cond} \
             GROUP BY t.tag_key ORDER BY n DESC, t.tag_key LIMIT {TOP_TAGS}"
        ))?;
        let rows = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    FacetCount {
                        value: r.get(1)?,
                        count: r.get::<_, i64>(2)? as u32,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let keys: Vec<String> = rows.iter().map(|(k, _)| k.clone()).collect();
        facets.tags = rows.into_iter().map(|(_, f)| f).collect();
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

        let (cond, params) = where_sql(filters, Some(Dim::LinksTo));
        let mut stmt = self.conn.prepare(&format!(
            "SELECT l.target_path, count(DISTINCT p.path) AS n FROM {base} \
             JOIN links l ON l.src = p.path JOIN files tf ON tf.path = l.target_path \
             WHERE tf.kind = 'page' AND l.target_path != p.path AND {cond} \
             GROUP BY l.target_path ORDER BY n DESC, l.target_path LIMIT {TOP_LINKS}"
        ))?;
        let rows = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (path, count) in rows {
            let title = self.page_title(&path)?.unwrap_or_else(|| path.clone());
            facets.links_to.push(FacetPage {
                path,
                title,
                count,
                active: false,
            });
        }
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

        for (dim, column) in [(Dim::Image, "p.has_image"), (Dim::Audio, "p.has_audio")] {
            let (cond, params) = where_sql(filters, Some(dim));
            let n = self.count(base, &format!("{column} AND {cond}"), &params)?;
            if dim == Dim::Image {
                facets.has_image = n;
            } else {
                facets.has_audio = n;
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

/// FTS5's marked snippet as parts; `None` without a marked word.
fn snippet_parts(s: &str) -> Option<Vec<SnippetPart>> {
    if !s.contains(OPEN) {
        return None;
    }
    let mut parts: Vec<SnippetPart> = Vec::new();
    let mut push = |text: &str, hit: bool| {
        let text = text.replace('\n', " ");
        if !text.is_empty() {
            parts.push(SnippetPart { text, hit });
        }
    };
    for (i, chunk) in s.split(OPEN).enumerate() {
        if i == 0 {
            push(chunk, false);
            continue;
        }
        match chunk.split_once(CLOSE) {
            Some((hit, rest)) => {
                push(hit, true);
                push(rest, false);
            }
            None => push(chunk, true),
        }
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
    fn snippet_markers_become_parts() {
        let parts = snippet_parts("…the \u{1}WYRM\u{2} sleeps\nhere").unwrap();
        assert_eq!(
            parts,
            vec![
                SnippetPart {
                    text: "…the ".into(),
                    hit: false
                },
                SnippetPart {
                    text: "WYRM".into(),
                    hit: true
                },
                SnippetPart {
                    text: " sleeps here".into(),
                    hit: false
                },
            ]
        );
        assert!(snippet_parts("no marks").is_none());
    }
}
