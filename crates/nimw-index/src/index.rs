use crate::rows::{
    CardRow, FileKind, FileRow, LinkCandidate, LinkRow, PageLink, PageRow, Stat, TreeNode, ext_of,
    split_path,
};
use crate::schema::{SCHEMA, SCHEMA_VERSION};
use crate::text::{folders_column, name_column, text_columns};
use nimw_markdown::{FileSet, LinkKind, PageMeta, Tag, link_key, name_key, resolve};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("index database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("index file error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, IndexError>;

/// The SQLite cache of one vault (spec §5). Never touches vault files.
pub struct Index {
    pub(crate) conn: Connection,
}

impl std::fmt::Debug for Index {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Index")
    }
}

/// Writes inside one transaction.
pub struct Tx<'a> {
    tx: rusqlite::Transaction<'a>,
}

const LINK_COLUMNS: &str = "id, src, kind, target_raw, target_key, target_path, heading, alias, start, end, encoded, angle, label, directed";

fn link_row(r: &Row<'_>) -> rusqlite::Result<LinkRow> {
    Ok(LinkRow {
        id: r.get(0)?,
        src: r.get(1)?,
        kind: LinkKind::parse(&r.get::<_, String>(2)?).unwrap_or(LinkKind::Wiki),
        target_raw: r.get(3)?,
        target_key: r.get(4)?,
        target_path: r.get(5)?,
        heading: r.get(6)?,
        alias: r.get(7)?,
        start: r.get::<_, i64>(8)? as usize,
        end: r.get::<_, i64>(9)? as usize,
        encoded: r.get(10)?,
        angle: r.get(11)?,
        label: r.get(12)?,
        directed: r.get(13)?,
    })
}

const CARD_SELECT: &str = "SELECT f.path, f.parent, f.name, f.kind, p.title, p.subtitle, p.cover, \
     (SELECT l.target_path FROM links l WHERE l.src = f.path AND l.kind = 'cover' LIMIT 1), \
     p.cover_y, p.excerpt, p.has_image, p.has_audio, p.cover_x \
     FROM files f LEFT JOIN pages p ON p.path = f.path";

fn card_row(r: &Row<'_>) -> rusqlite::Result<CardRow> {
    Ok(CardRow {
        path: r.get(0)?,
        parent: r.get(1)?,
        name: r.get(2)?,
        kind: FileKind::parse(&r.get::<_, String>(3)?),
        title: r.get(4)?,
        subtitle: r.get(5)?,
        cover: r.get(6)?,
        cover_path: r.get(7)?,
        cover_y: r.get::<_, Option<i64>>(8)?.map(|v| v.clamp(0, 100) as u8),
        excerpt: r.get(9)?,
        has_image: r.get::<_, Option<bool>>(10)?.unwrap_or(false),
        has_audio: r.get::<_, Option<bool>>(11)?.unwrap_or(false),
        cover_x: r.get::<_, Option<i64>>(12)?.map(|v| v.clamp(0, 100) as u8),
    })
}

/// Link kinds that connect pages in the Global View.
const PAGE_LINK_KINDS: &str = "('wiki', 'embed', 'markdown', 'related')";

fn page_link(r: &Row<'_>) -> rusqlite::Result<PageLink> {
    page_link_at(r, 0)
}

/// A `PageLink` from the five columns starting at `at`.
fn page_link_at(r: &Row<'_>, at: usize) -> rusqlite::Result<PageLink> {
    Ok(PageLink {
        src: r.get(at)?,
        target: r.get(at + 1)?,
        kind: LinkKind::parse(&r.get::<_, String>(at + 2)?).unwrap_or(LinkKind::Wiki),
        label: r.get(at + 3)?,
        directed: r.get(at + 4)?,
    })
}

/// `?1` is the path itself or a folder containing it.
const IN_SUBTREE: &str =
    "(path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1) + 1) = ?1 || '/'))";

impl Index {
    /// Opens (or creates) the cache at `db_path`. A wrong schema version, a
    /// corrupt or foreign file is deleted and rebuilt: the index is only a cache.
    pub fn open(db_path: &Path) -> Result<Index> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        match Self::try_open(db_path) {
            Ok(Some(index)) => Ok(index),
            _ => {
                for suffix in ["", "-wal", "-shm"] {
                    let mut p = db_path.as_os_str().to_owned();
                    p.push(suffix);
                    let _ = std::fs::remove_file(p);
                }
                let conn = Connection::open(db_path)?;
                Self::init(conn)
            }
        }
    }

    pub fn open_in_memory() -> Result<Index> {
        Self::init(Connection::open_in_memory()?)
    }

    /// `Ok(None)` when the file exists but is not a usable v1 index.
    fn try_open(db_path: &Path) -> Result<Option<Index>> {
        let fresh = !db_path.exists();
        let conn = Connection::open(db_path)?;
        if fresh {
            return Self::init(conn).map(Some);
        }
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Ok(None);
        }
        let version: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if version.as_deref() != Some(&SCHEMA_VERSION.to_string()) {
            return Ok(None);
        }
        Self::configure(&conn)?;
        Ok(Some(Index { conn }))
    }

    fn configure(conn: &Connection) -> Result<()> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }

    fn init(conn: Connection) -> Result<Index> {
        Self::configure(&conn)?;
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)",
            [SCHEMA_VERSION.to_string()],
        )?;
        Ok(Index { conn })
    }

    /// Runs `f` in one transaction (committed if it returns `Ok`).
    pub fn transaction<T>(&mut self, f: impl FnOnce(&Tx<'_>) -> Result<T>) -> Result<T> {
        let tx = Tx {
            tx: self.conn.transaction()?,
        };
        let out = f(&tx)?;
        tx.tx.commit()?;
        Ok(out)
    }

    // ---- reads ----

    /// Every stored entry's stat, keyed by path (for incremental indexing).
    pub fn stats(&self) -> Result<HashMap<String, Stat>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, kind, mtime_ns, size, hash FROM files")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Stat {
                    kind: FileKind::parse(&r.get::<_, String>(1)?),
                    mtime_ns: r.get(2)?,
                    size: r.get::<_, i64>(3)? as u64,
                    hash: r.get(4)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn stat(&self, path: &str) -> Result<Option<Stat>> {
        Ok(self
            .conn
            .query_row(
                "SELECT kind, mtime_ns, size, hash FROM files WHERE path = ?1",
                [path],
                |r| {
                    Ok(Stat {
                        kind: FileKind::parse(&r.get::<_, String>(0)?),
                        mtime_ns: r.get(1)?,
                        size: r.get::<_, i64>(2)? as u64,
                        hash: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// All non-folder paths, for link resolution.
    pub fn file_set(&self) -> Result<FileSet> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM files WHERE kind != 'folder'")?;
        let paths = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(FileSet::new(paths.collect::<rusqlite::Result<Vec<_>>>()?))
    }

    /// Explorer rows: grouped by parent, folders first, then by name (case- and
    /// accent-insensitive key).
    pub fn tree(&self) -> Result<Vec<TreeNode>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.path, f.parent, f.name, f.kind, p.title FROM files f LEFT JOIN pages p ON p.path = f.path",
        )?;
        let mut nodes = stmt
            .query_map([], |r| {
                Ok(TreeNode {
                    path: r.get(0)?,
                    parent: r.get(1)?,
                    name: r.get(2)?,
                    kind: FileKind::parse(&r.get::<_, String>(3)?),
                    title: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        nodes.sort_by_cached_key(|n| {
            (
                n.parent.clone(),
                n.kind != FileKind::Folder,
                name_key(&n.name),
                n.name.clone(),
            )
        });
        Ok(nodes)
    }

    /// The entries directly inside `parent` (`""`: the vault root) with their
    /// card data, folders first, then by name like the explorer (M3a §3).
    pub fn card_children(&self, parent: &str) -> Result<Vec<CardRow>> {
        let mut stmt = self
            .conn
            .prepare_cached(&format!("{CARD_SELECT} WHERE f.parent = ?1"))?;
        let mut rows = stmt
            .query_map([parent], card_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.sort_by_cached_key(|r| {
            (
                r.kind != FileKind::Folder,
                name_key(&r.name),
                r.name.clone(),
            )
        });
        Ok(rows)
    }

    /// One entry with its card data.
    pub fn card(&self, path: &str) -> Result<Option<CardRow>> {
        let mut stmt = self
            .conn
            .prepare_cached(&format!("{CARD_SELECT} WHERE f.path = ?1"))?;
        Ok(stmt.query_row([path], card_row).optional()?)
    }

    /// Resolved links between two pages that start at one of `paths` or
    /// inside it (folders), each once, in index order (M3a §6): one indexed
    /// range query per path, so a level costs what it shows, not the vault.
    pub fn page_links_from(&self, paths: &[String]) -> Result<Vec<PageLink>> {
        let mut found: std::collections::BTreeMap<i64, PageLink> =
            std::collections::BTreeMap::new();
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT l.id, l.src, l.target_path, l.kind, l.label, l.directed FROM links l \
             JOIN files t ON t.path = l.target_path \
             WHERE t.kind = 'page' AND l.kind IN {PAGE_LINK_KINDS} \
             AND (l.src = ?1 OR (l.src >= ?2 AND l.src < ?3))"
        ))?;
        for path in paths {
            // Everything inside `path/`: '/' + 1 is '0'.
            let rows = stmt
                .query_map(params![path, format!("{path}/"), format!("{path}0")], |r| {
                    Ok((r.get::<_, i64>(0)?, page_link_at(r, 1)?))
                })?;
            for row in rows {
                let (id, link) = row?;
                found.entry(id).or_insert(link);
            }
        }
        Ok(found.into_values().collect())
    }

    /// Resolved page-to-page links from or to `path` (a page's neighbourhood).
    pub fn page_links_of(&self, path: &str) -> Result<Vec<PageLink>> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT l.src, l.target_path, l.kind, l.label, l.directed FROM links l \
             JOIN files t ON t.path = l.target_path \
             WHERE t.kind = 'page' AND l.kind IN {PAGE_LINK_KINDS} \
             AND (l.src = ?1 OR l.target_path = ?1) ORDER BY l.src, l.start"
        ))?;
        Ok(stmt
            .query_map([path], page_link)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every page and attachment with its title (pages) and mtime (M2c §7.2).
    pub fn link_candidates(&self) -> Result<Vec<LinkCandidate>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.path, f.kind, p.title, f.mtime_ns FROM files f \
             LEFT JOIN pages p ON p.path = f.path WHERE f.kind != 'folder'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(LinkCandidate {
                path: r.get(0)?,
                kind: FileKind::parse(&r.get::<_, String>(1)?),
                title: r.get(2)?,
                mtime_ns: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn page(&self, path: &str) -> Result<Option<PageRow>> {
        let page = self
            .conn
            .query_row(
                "SELECT title, subtitle, cover, cover_y, excerpt, has_image, has_audio, frontmatter_error, cover_x FROM pages WHERE path = ?1",
                [path],
                |r| {
                    Ok(PageRow {
                        path: path.to_string(),
                        title: r.get(0)?,
                        subtitle: r.get(1)?,
                        cover: r.get(2)?,
                        cover_y: r.get::<_, Option<i64>>(3)?.map(|v| v as u8),
                        excerpt: r.get(4)?,
                        has_image: r.get(5)?,
                        has_audio: r.get(6)?,
                        frontmatter_error: r.get(7)?,
                        cover_x: r.get::<_, Option<i64>>(8)?.map(|v| v.clamp(0, 100) as u8),
                        tags: Vec::new(),
                        links: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut page) = page else {
            return Ok(None);
        };
        let mut stmt = self
            .conn
            .prepare("SELECT tag FROM tags WHERE path = ?1 ORDER BY rowid")?;
        page.tags = stmt
            .query_map([path], |r| r.get::<_, String>(0))?
            .map(|t| t.map(|t| Tag::new(&t)))
            .collect::<rusqlite::Result<_>>()?;
        page.links = self.links_from(path)?;
        Ok(Some(page))
    }

    pub fn links_from(&self, src: &str) -> Result<Vec<LinkRow>> {
        self.query_links(
            &format!("SELECT {LINK_COLUMNS} FROM links WHERE src = ?1 ORDER BY start"),
            [src],
        )
    }

    /// Links whose resolved target is `path` (EXP-04 input; backlinks panel later).
    pub fn backlinks(&self, path: &str) -> Result<Vec<LinkRow>> {
        self.query_links(
            &format!("SELECT {LINK_COLUMNS} FROM links WHERE target_path = ?1 ORDER BY src, start"),
            [path],
        )
    }

    /// Links whose resolved target is `prefix` or inside the folder `prefix`.
    pub fn links_into(&self, prefix: &str) -> Result<Vec<LinkRow>> {
        let cond = IN_SUBTREE.replace("path", "target_path");
        self.query_links(
            &format!("SELECT {LINK_COLUMNS} FROM links WHERE {cond} ORDER BY src, start"),
            [prefix],
        )
    }

    /// Links whose `target_key` is one of `keys` (see `nimw_markdown::link_key`).
    pub fn links_by_key(&self, keys: &[String]) -> Result<Vec<LinkRow>> {
        let mut out = Vec::new();
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {LINK_COLUMNS} FROM links WHERE target_key = ?1 ORDER BY src, start"
        ))?;
        for key in keys {
            out.extend(
                stmt.query_map([key], link_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }
        Ok(out)
    }

    fn query_links<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<LinkRow>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, link_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn counts(&self) -> Result<(usize, usize)> {
        let files: i64 = self
            .conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))?;
        let pages: i64 = self
            .conn
            .query_row("SELECT count(*) FROM pages", [], |r| r.get(0))?;
        Ok((files as usize, pages as usize))
    }

    // ---- resolution ----

    /// Re-resolves every link against `files`.
    pub fn resolve_all(&mut self, files: &FileSet) -> Result<usize> {
        let links = self.query_links(&format!("SELECT {LINK_COLUMNS} FROM links"), [])?;
        self.apply_resolution(files, links)
    }

    /// Re-resolves links whose `target_key` is in `keys`.
    pub fn resolve_affected(&mut self, files: &FileSet, keys: &[String]) -> Result<usize> {
        let links = self.links_by_key(keys)?;
        self.apply_resolution(files, links)
    }

    /// Re-resolves the outgoing links of `src` (after it was re-parsed or moved).
    pub fn resolve_from(&mut self, files: &FileSet, src: &str) -> Result<usize> {
        let links = self.links_from(src)?;
        self.apply_resolution(files, links)
    }

    fn apply_resolution(&mut self, files: &FileSet, links: Vec<LinkRow>) -> Result<usize> {
        self.transaction(|tx| {
            let mut stmt = tx
                .tx
                .prepare_cached("UPDATE links SET target_path = ?2 WHERE id = ?1")?;
            let mut changed = 0;
            for l in &links {
                let target = resolve(l.kind, &l.target_raw, &l.src, files);
                if target != l.target_path {
                    stmt.execute(params![l.id, target])?;
                    changed += 1;
                }
            }
            Ok(changed)
        })
    }
}

impl Tx<'_> {
    pub fn upsert_file(&self, row: &FileRow) -> Result<()> {
        let (parent, name) = split_path(&row.path);
        self.tx.prepare_cached(
            "INSERT INTO files (path, parent, name, ext, kind, mtime_ns, size, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(path) DO UPDATE SET kind = ?5, mtime_ns = ?6, size = ?7, hash = ?8",
        )?
        .execute(params![row.path, parent, name, ext_of(name), row.kind.as_str(), row.mtime_ns, row.size as i64, row.hash])?;
        if row.kind != FileKind::Page {
            self.tx
                .prepare_cached("DELETE FROM pages WHERE path = ?1")?
                .execute([&row.path])?;
            self.tx
                .prepare_cached("DELETE FROM page_text WHERE path = ?1")?
                .execute([&row.path])?;
            self.tx
                .prepare_cached("DELETE FROM tags WHERE path = ?1")?
                .execute([&row.path])?;
            self.tx
                .prepare_cached("DELETE FROM links WHERE src = ?1")?
                .execute([&row.path])?;
        }
        Ok(())
    }

    /// Replaces the page row, tags and links of `path` (which must be in `files`).
    /// New links start unresolved; call a `resolve_*` method afterwards.
    pub fn upsert_page(&self, path: &str, meta: &PageMeta) -> Result<()> {
        self.tx.prepare_cached(
            "INSERT OR REPLACE INTO pages (path, title, subtitle, cover, cover_y, excerpt, has_image, has_audio, frontmatter_error, cover_x)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?
        .execute(params![
            path, meta.title, meta.subtitle, meta.cover, meta.cover_y.map(i64::from), meta.excerpt,
            meta.has_image, meta.has_audio, meta.frontmatter_error, meta.cover_x.map(i64::from)
        ])?;
        let [title, name, folders, tags, links, body] = text_columns(path, meta);
        self.tx
            .prepare_cached(
                "INSERT INTO page_text (path, title, name, folders, tags, links, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(path) DO UPDATE SET title = ?2, name = ?3, folders = ?4,
                 tags = ?5, links = ?6, body = ?7",
            )?
            .execute(params![path, title, name, folders, tags, links, body])?;
        self.tx
            .prepare_cached("DELETE FROM tags WHERE path = ?1")?
            .execute([path])?;
        self.tx
            .prepare_cached("DELETE FROM links WHERE src = ?1")?
            .execute([path])?;
        let mut tag_stmt = self
            .tx
            .prepare_cached("INSERT INTO tags (path, tag, tag_key) VALUES (?1, ?2, ?3)")?;
        for tag in &meta.tags {
            tag_stmt.execute(params![path, tag.text, tag.key])?;
        }
        let mut link_stmt = self.tx.prepare_cached(
            "INSERT INTO links (src, kind, target_raw, target_key, target_path, heading, alias, start, end, encoded, angle, label, directed)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        for l in &meta.links {
            link_stmt.execute(params![
                path,
                l.kind.as_str(),
                l.target,
                link_key(&l.target),
                l.heading,
                l.alias,
                l.range.start as i64,
                l.range.end as i64,
                l.encoded,
                l.angle,
                l.label,
                l.directed
            ])?;
        }
        Ok(())
    }

    /// Removes `path` and, for folders, everything inside it. Links pointing at
    /// removed files become unresolved.
    pub fn remove(&self, path: &str) -> Result<()> {
        let cond = IN_SUBTREE.replace("path", "target_path");
        self.tx.execute(
            &format!("UPDATE links SET target_path = NULL WHERE {cond}"),
            [path],
        )?;
        self.tx
            .execute(&format!("DELETE FROM files WHERE {IN_SUBTREE}"), [path])?;
        Ok(())
    }

    /// Moves `from` (file or folder subtree) to `to`, including resolved link targets.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let mut stmt = self
            .tx
            .prepare(&format!("SELECT path FROM files WHERE {IN_SUBTREE}"))?;
        let paths: Vec<String> = stmt
            .query_map([from], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut update = self.tx.prepare_cached(
            "UPDATE files SET path = ?2, parent = ?3, name = ?4, ext = ?5 WHERE path = ?1",
        )?;
        let mut retarget = self
            .tx
            .prepare_cached("UPDATE links SET target_path = ?2 WHERE target_path = ?1")?;
        // The path cascades into `page_text`; the name and folder words that
        // search finds a page by follow here.
        let mut words = self
            .tx
            .prepare_cached("UPDATE page_text SET name = ?2, folders = ?3 WHERE path = ?1")?;
        for old in paths {
            let new = format!("{to}{}", &old[from.len()..]);
            let (parent, name) = split_path(&new);
            update.execute(params![old, new, parent, name, ext_of(name)])?;
            retarget.execute(params![old, new])?;
            words.execute(params![new, name_column(&new), folders_column(&new)])?;
        }
        Ok(())
    }
}
