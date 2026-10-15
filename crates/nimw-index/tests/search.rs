//! M5: the search index (`page_text` + FTS5) and the search query.

use nimw_index::{FileKind, FileRow, Index, SCHEMA_VERSION};
use nimw_markdown::parse_page;
use std::path::{Path, PathBuf};

fn row(path: &str, kind: FileKind, mtime_ns: i64) -> FileRow {
    FileRow {
        path: path.into(),
        kind,
        mtime_ns,
        size: 1,
        hash: (kind != FileKind::Folder).then(|| "h".into()),
    }
}

/// An index in a temp file, so a second connection can read what it wrote.
struct Fixture {
    _dir: tempfile::TempDir,
    db: PathBuf,
    ix: Index,
    clock: i64,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("index.sqlite");
        let ix = Index::open(&db).unwrap();
        Fixture {
            _dir: dir,
            db,
            ix,
            clock: 0,
        }
    }

    /// Adds (or replaces) a page and its folders, then resolves every link.
    fn page(&mut self, path: &str, text: &str) -> &mut Fixture {
        self.clock += 1;
        let mtime = self.clock;
        let stem = path
            .rsplit('/')
            .next()
            .unwrap()
            .trim_end_matches(".md")
            .to_string();
        let folders: Vec<String> = {
            let parts: Vec<&str> = path.split('/').collect();
            (1..parts.len()).map(|i| parts[..i].join("/")).collect()
        };
        self.ix
            .transaction(|tx| {
                for f in &folders {
                    tx.upsert_file(&row(f, FileKind::Folder, 0))?;
                }
                tx.upsert_file(&row(path, FileKind::Page, mtime))?;
                tx.upsert_page(path, &parse_page(text, &stem))
            })
            .unwrap();
        let files = self.ix.file_set().unwrap();
        self.ix.resolve_all(&files).unwrap();
        self
    }

    /// Paths whose FTS row matches `q` (raw FTS5 syntax), read by another
    /// connection.
    fn fts(&self, q: &str) -> Vec<String> {
        fts_paths(&self.db, q)
    }
}

fn fts_paths(db: &Path, q: &str) -> Vec<String> {
    let conn = rusqlite::Connection::open(db).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT pt.path FROM fts JOIN page_text pt ON pt.rowid = fts.rowid \
             WHERE fts MATCH ?1 ORDER BY pt.path",
        )
        .unwrap();
    stmt.query_map([q], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

// ---- Task 2: the index keeps page_text and fts in sync ----

#[test]
fn m5_schema_is_3() {
    assert_eq!(SCHEMA_VERSION, 3);
}

#[test]
fn m5_pages_are_searchable_by_every_column() {
    let mut f = Fixture::new();
    f.page(
        "Lore/Dragons/Smaug.md",
        "---\ntags: [villain, lore/beasts]\n---\n# The Golden Wyrm\n\nSleeps on gold under [[Erebor|the mountain]].\n\n[pdf](file:///Users/j/secret%20plans.pdf)\n",
    );
    let p = vec!["Lore/Dragons/Smaug.md".to_string()];
    assert_eq!(f.fts("title : golden"), p, "title");
    assert_eq!(f.fts("name : smaug"), p, "file name");
    assert_eq!(f.fts("folders : dragons"), p, "folder");
    assert_eq!(f.fts("folders : lore"), p, "project");
    assert_eq!(f.fts("tags : villain"), p, "tag");
    assert_eq!(f.fts("tags : beasts"), p, "nested tag");
    assert_eq!(f.fts("links : erebor"), p, "link target");
    assert_eq!(f.fts("body : mountain"), p, "alias in the body");
    assert!(
        f.fts("links : secret").is_empty(),
        "an outside file is not a vault link"
    );
    assert!(f.fts("body : secret").is_empty(), "URLs are not text");
    assert_eq!(f.fts("wyrm"), p, "any column");
    assert_eq!(f.fts("wyr*"), p, "prefix");
}

#[test]
fn m5_accents_fold_both_ways() {
    let mut f = Fixture::new();
    f.page("a.md", "# Canción\n\nel DRAGÓN\n");
    f.page("b.md", "# cancion\n\nDragon\n");
    let both = vec!["a.md".to_string(), "b.md".to_string()];
    assert_eq!(f.fts("cancion"), both);
    assert_eq!(f.fts("CANCIÓN"), both);
    assert_eq!(f.fts("dragón"), both);
}

#[test]
fn m5_fts_follows_edit_rename_move_and_delete() {
    let mut f = Fixture::new();
    f.page("Lore/Dragons/Smaug.md", "# Smaug\n\nA red wyrm.\n");
    let one = |p: &str| vec![p.to_string()];
    assert_eq!(f.fts("dragons"), one("Lore/Dragons/Smaug.md"));

    f.page("Lore/Dragons/Smaug.md", "# Smaug\n\nA golden worm.\n");
    assert!(f.fts("wyrm").is_empty(), "an edit replaces the old words");
    assert_eq!(f.fts("golden"), one("Lore/Dragons/Smaug.md"));

    f.ix.transaction(|tx| tx.rename("Lore/Dragons", "Lore/Wyrms"))
        .unwrap();
    assert!(f.fts("dragons").is_empty(), "the old folder is gone");
    assert_eq!(f.fts("wyrms"), one("Lore/Wyrms/Smaug.md"));

    f.ix.transaction(|tx| tx.rename("Lore/Wyrms/Smaug.md", "Lore/Wyrms/Glaurung.md"))
        .unwrap();
    assert_eq!(f.fts("name : glaurung"), one("Lore/Wyrms/Glaurung.md"));
    assert!(f.fts("name : smaug").is_empty());
    assert_eq!(
        f.fts("title : smaug"),
        one("Lore/Wyrms/Glaurung.md"),
        "the title comes from the H1"
    );

    f.ix.transaction(|tx| tx.rename("Lore", "World")).unwrap();
    assert_eq!(f.fts("folders : world"), one("World/Wyrms/Glaurung.md"));
    assert!(f.fts("folders : lore").is_empty());

    // Not UTF-8 any more: indexed as an attachment, gone from search.
    f.ix.transaction(|tx| tx.upsert_file(&row("World/Wyrms/Glaurung.md", FileKind::Attachment, 9)))
        .unwrap();
    assert!(f.fts("golden").is_empty());

    f.page("B.md", "# B\n\nwyrm\n");
    f.ix.transaction(|tx| tx.remove("B.md")).unwrap();
    assert!(f.fts("wyrm").is_empty());

    f.page("C/D/E.md", "# E\n\nnested\n");
    f.ix.transaction(|tx| tx.remove("C")).unwrap();
    assert!(
        f.fts("nested").is_empty(),
        "a removed folder takes its pages"
    );
}

#[test]
fn m5_an_index_from_schema_2_is_rebuilt_with_search() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nimw/abc/index.sqlite");
    {
        let mut idx = Index::open(&db).unwrap();
        idx.transaction(|tx| tx.upsert_file(&row("x.md", FileKind::Page, 1)))
            .unwrap();
    }
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "DROP TABLE fts; DROP TABLE page_text; \
             UPDATE meta SET value = '2' WHERE key = 'schema_version';",
        )
        .unwrap();
    }
    let idx = Index::open(&db).unwrap();
    assert_eq!(idx.counts().unwrap().0, 0, "rebuilt from scratch");
    drop(idx);
    assert!(
        fts_paths(&db, "anything").is_empty(),
        "with the search tables"
    );
}
