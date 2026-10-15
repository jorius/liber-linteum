//! M5: the search index (`page_text` + FTS5) and the search query.

use nimw_index::{FileKind, FileRow, Index};
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

// ---- Task 3: the search query ----

use nimw_index::{FacetCount, FacetPage, SearchPage, SearchQuery};

impl Fixture {
    /// Adds an attachment (a cover image, a clip).
    fn attachment(&mut self, path: &str) -> &mut Fixture {
        self.ix
            .transaction(|tx| tx.upsert_file(&row(path, FileKind::Attachment, 0)))
            .unwrap();
        let files = self.ix.file_set().unwrap();
        self.ix.resolve_all(&files).unwrap();
        self
    }

    fn search(&self, q: SearchQuery) -> SearchPage {
        self.ix.search(&q).unwrap()
    }

    fn find(&self, text: &str) -> Vec<String> {
        paths(&self.search(text_query(text)))
    }
}

fn text_query(text: &str) -> SearchQuery {
    SearchQuery {
        text: text.into(),
        ..SearchQuery::default()
    }
}

fn paths(page: &SearchPage) -> Vec<String> {
    page.results.iter().map(|h| h.path.clone()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn m5_metadata_outranks_body_and_title_beats_tag_beats_body() {
    let mut f = Fixture::new();
    f.page("Body.md", "# Body\n\nthe dragon sleeps here today\n");
    f.page("Tagged.md", "# Tagged\n\nsleeps here today #dragon\n");
    f.page("Titled.md", "# Dragon\n\nsleeps here today now\n");
    assert_eq!(
        f.find("dragon"),
        strs(&["Titled.md", "Tagged.md", "Body.md"])
    );
    // A body full of the word still ranks under every metadata match.
    f.page("Many.md", "# Many\n\ndragon dragon dragon dragon dragon\n");
    let got = f.find("dragon");
    let at = |p: &str| got.iter().position(|g| g == p).unwrap();
    assert!(at("Tagged.md") < at("Many.md"), "{got:?}");
    assert!(at("Titled.md") < at("Many.md"), "{got:?}");
}

#[test]
fn m5_accents_and_prefixes() {
    let mut f = Fixture::new();
    f.page("a.md", "# Canción del dragón\n");
    f.page("b.md", "# cancion\n");
    let both = strs(&["a.md", "b.md"]);
    assert_eq!(sorted(f.find("cancion")), both);
    assert_eq!(sorted(f.find("CANCIÓN")), both);
    assert_eq!(sorted(f.find("canc")), both);
    assert_eq!(f.find("drag"), strs(&["a.md"]));
    assert_eq!(
        f.find("cancion drag"),
        strs(&["a.md"]),
        "every word must match"
    );
}

#[test]
fn m5_phrases_keep_their_order() {
    let mut f = Fixture::new();
    f.page("a.md", "# A\n\na red dragon here\n");
    f.page("b.md", "# B\n\nthe dragon is red\n");
    assert_eq!(f.find("\"red dragon\""), strs(&["a.md"]));
    assert_eq!(
        f.find("\"red drag"),
        strs(&["a.md"]),
        "unclosed, last word a prefix"
    );
    assert_eq!(sorted(f.find("red dragon")), strs(&["a.md", "b.md"]));
}

#[test]
fn m5_operators_are_text() {
    let mut f = Fixture::new();
    f.page("a.md", "# A\n\nsand and stone near a cave\n");
    f.page("b.md", "# B\n\nnothing here\n");
    for q in [
        "AND",
        "OR x",
        "NOT",
        "\"",
        "a\"b",
        "NEAR(a b)",
        "^x",
        "*",
        "x:y",
        "(",
        "-x",
        ")",
        "a*b",
        "title:x",
        "{body}:x",
        "\u{301}",
        "ـ",
        "\"\"",
        "'",
        "\\",
        "a AND",
        "NEAR",
        "\u{903}",
        "\u{903}\u{903} x",
    ] {
        assert!(f.ix.search(&text_query(q)).is_ok(), "{q:?}");
    }
    assert_eq!(f.find("AND"), strs(&["a.md"]), "AND is a word");
    assert_eq!(f.find("NEAR"), strs(&["a.md"]), "NEAR is a word");
    assert!(
        f.find("OR nothing").is_empty(),
        "OR is a word, not an operator"
    );
}

#[test]
fn m5_punctuation_only_is_an_empty_query() {
    let mut f = Fixture::new();
    f.page("a.md", "# A\n");
    for q in ["***", " - ", "\"\"", "  "] {
        let page = f.search(text_query(q));
        assert!(page.recent, "{q:?}");
        assert_eq!(paths(&page), strs(&["a.md"]));
    }
}

/// A small vault for the filters (M5 §3, §10.12).
fn filter_vault() -> Fixture {
    let mut f = Fixture::new();
    f.page(
        "Lore/Places/Erebor.md",
        "---\ntags: [lore/places]\n---\n# Erebor\n\nThe mountain of [[Smaug]]. ![[map.png]]\n",
    );
    f.page(
        "Lore/Beasts/Smaug.md",
        "---\ntags: [lore, villain]\n---\n# Smaug\n\nA wyrm. ![[roar.mp3]]\n",
    );
    f.page(
        "Game/Sessions/Session 1.md",
        "# Session 1\n\nWe met [[Smaug]] near [[Erebor]]. #session\n",
    );
    f.page("Game/Notes/Places.md", "# Places\n\nA list. #lore\n");
    f.page("Game/Places/Inn.md", "# Inn\n\nThe prancing pony.\n");
    f.page(
        "Root.md",
        "# Root\n\nAn outside [file](file:///Users/j/Smaug.md) and [up](../../Smaug.md).\n",
    );
    f
}

fn q() -> SearchQuery {
    SearchQuery::default()
}

#[test]
fn m5_each_filter_alone() {
    let f = filter_vault();
    let found = |query: SearchQuery| sorted(paths(&f.search(query)));
    assert_eq!(
        found(SearchQuery {
            project: Some("Lore".into()),
            ..q()
        }),
        strs(&["Lore/Beasts/Smaug.md", "Lore/Places/Erebor.md"])
    );
    assert_eq!(
        found(SearchQuery {
            folder: Some("Lore/Places".into()),
            ..q()
        }),
        strs(&["Lore/Places/Erebor.md"]),
        "folder by path"
    );
    assert_eq!(
        found(SearchQuery {
            folder: Some("places".into()),
            ..q()
        }),
        strs(&["Game/Places/Inn.md", "Lore/Places/Erebor.md"]),
        "folder by name, every folder so named"
    );
    assert_eq!(
        found(SearchQuery {
            folder: Some("Game".into()),
            ..q()
        }),
        strs(&[
            "Game/Notes/Places.md",
            "Game/Places/Inn.md",
            "Game/Sessions/Session 1.md"
        ]),
        "a folder holds its subfolders' pages"
    );
    assert_eq!(
        found(SearchQuery {
            tags: strs(&["lore"]),
            ..q()
        }),
        strs(&[
            "Game/Notes/Places.md",
            "Lore/Beasts/Smaug.md",
            "Lore/Places/Erebor.md"
        ]),
        "#lore matches lore/places too"
    );
    assert_eq!(
        found(SearchQuery {
            tags: strs(&["#LORE", "villain"]),
            ..q()
        }),
        strs(&["Lore/Beasts/Smaug.md"]),
        "every tag, case-insensitive, # optional"
    );
    for to in [
        "Lore/Beasts/Smaug.md",
        "Smaug",
        "smaug",
        "Lore/Beasts/Smaug",
    ] {
        assert_eq!(
            found(SearchQuery {
                links_to: Some(to.into()),
                ..q()
            }),
            strs(&["Game/Sessions/Session 1.md", "Lore/Places/Erebor.md"]),
            "links to {to:?} (an outside file named Smaug doesn't count)"
        );
    }
    for from in ["Game/Sessions/Session 1.md", "Session 1"] {
        assert_eq!(
            found(SearchQuery {
                links_from: Some(from.into()),
                ..q()
            }),
            strs(&["Lore/Beasts/Smaug.md", "Lore/Places/Erebor.md"]),
            "links from {from:?}"
        );
    }
    assert_eq!(
        found(SearchQuery {
            has_image: true,
            ..q()
        }),
        strs(&["Lore/Places/Erebor.md"])
    );
    assert_eq!(
        found(SearchQuery {
            has_audio: true,
            ..q()
        }),
        strs(&["Lore/Beasts/Smaug.md"])
    );
}

#[test]
fn m5_filters_combined() {
    let f = filter_vault();
    let found = |query: SearchQuery| sorted(paths(&f.search(query)));
    assert_eq!(
        found(SearchQuery {
            project: Some("Game".into()),
            tags: strs(&["lore"]),
            ..q()
        }),
        strs(&["Game/Notes/Places.md"])
    );
    assert_eq!(
        found(SearchQuery {
            text: "met".into(),
            links_to: Some("Smaug".into()),
            ..q()
        }),
        strs(&["Game/Sessions/Session 1.md"])
    );
    assert!(
        found(SearchQuery {
            project: Some("Lore".into()),
            has_image: true,
            has_audio: true,
            ..q()
        })
        .is_empty(),
        "both media at once"
    );
    assert_eq!(
        found(SearchQuery {
            text: "mountain".into(),
            project: Some("Lore".into()),
            folder: Some("Places".into()),
            tags: strs(&["lore"]),
            links_to: Some("Smaug".into()),
            has_image: true,
            ..q()
        }),
        strs(&["Lore/Places/Erebor.md"]),
        "everything at once"
    );
}

#[test]
fn m5_filters_without_text_and_unknown_references() {
    let f = filter_vault();
    let page = f.search(SearchQuery {
        tags: strs(&["lore"]),
        ..q()
    });
    assert!(!page.recent, "filters with no text are not Recent");
    assert_eq!(
        paths(&page),
        strs(&[
            "Game/Notes/Places.md",
            "Lore/Beasts/Smaug.md",
            "Lore/Places/Erebor.md"
        ]),
        "newest first"
    );
    assert_eq!(page.total, 3);

    let page = f.search(SearchQuery {
        links_to: Some("Nobody".into()),
        ..q()
    });
    assert_eq!(page.total, 0);
    let active: Vec<&FacetPage> = page.facets.links_to.iter().filter(|p| p.active).collect();
    assert_eq!(
        active,
        vec![&FacetPage {
            path: "Nobody".into(),
            title: "Nobody".into(),
            count: 0,
            active: true
        }],
        "an unknown page keeps its chip"
    );
    let page = f.search(SearchQuery {
        links_from: Some("Nobody".into()),
        ..q()
    });
    assert_eq!(page.total, 0);
    assert_eq!(page.facets.links_from.as_ref().map(|p| p.count), Some(0));
    let page = f.search(SearchQuery {
        folder: Some("Nowhere".into()),
        ..q()
    });
    assert_eq!(page.total, 0);
    for blank in ["", "/", "  "] {
        let page = f.search(SearchQuery {
            folder: Some(blank.into()),
            links_to: Some(blank.into()),
            ..q()
        });
        assert!(page.recent, "a blank filter is no filter: {blank:?}");
    }
    let page = f.search(SearchQuery {
        project: Some("Nope".into()),
        ..q()
    });
    assert_eq!(page.total, 0);
    assert!(
        page.facets.projects.contains(&FacetCount {
            value: "Nope".into(),
            count: 0
        }),
        "{:?}",
        page.facets.projects
    );
}

#[test]
fn m5_facets_count_and_keep_active_filters() {
    let f = filter_vault();
    let all = f.search(q());
    assert_eq!(
        all.facets.projects,
        vec![
            FacetCount {
                value: "Game".into(),
                count: 3
            },
            FacetCount {
                value: "Lore".into(),
                count: 2
            }
        ]
    );
    let tag = |page: &SearchPage, v: &str| {
        page.facets
            .tags
            .iter()
            .find(|t| t.value == v)
            .map(|t| t.count)
    };
    assert_eq!(tag(&all, "lore"), Some(2));
    assert_eq!(tag(&all, "lore/places"), Some(1));
    assert_eq!(all.facets.links_to[0].path, "Lore/Beasts/Smaug.md");
    assert_eq!(all.facets.links_to[0].title, "Smaug");
    assert_eq!(all.facets.links_to[0].count, 2);
    assert!(!all.facets.links_to[0].active);
    assert_eq!((all.facets.has_image, all.facets.has_audio), (1, 1));

    // Projects ignore their own filter: you can switch without removing it.
    let lore = f.search(SearchQuery {
        project: Some("Lore".into()),
        ..q()
    });
    assert_eq!(lore.total, 2);
    assert_eq!(lore.facets.projects, all.facets.projects);
    // Tags drill down within the other filters.
    assert_eq!(tag(&lore, "session"), None);
    assert_eq!(tag(&lore, "villain"), Some(1));
    // Media counts follow the other filters.
    assert_eq!((lore.facets.has_image, lore.facets.has_audio), (1, 1));
    let game = f.search(SearchQuery {
        project: Some("Game".into()),
        ..q()
    });
    assert_eq!((game.facets.has_image, game.facets.has_audio), (0, 0));

    // An active links-to filter stays, marked, with its resolved title.
    let to = f.search(SearchQuery {
        links_to: Some("smaug".into()),
        ..q()
    });
    let active: Vec<&FacetPage> = to.facets.links_to.iter().filter(|p| p.active).collect();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].path, "Lore/Beasts/Smaug.md");
    assert_eq!(active[0].title, "Smaug");
    let from = f.search(SearchQuery {
        links_from: Some("Session 1".into()),
        ..q()
    });
    assert_eq!(
        from.facets.links_from,
        Some(FacetPage {
            path: "Game/Sessions/Session 1.md".into(),
            title: "Session 1".into(),
            count: 2,
            active: true
        })
    );

    // An active tag with no page keeps its chip.
    let none = f.search(SearchQuery {
        tags: strs(&["ghost"]),
        ..q()
    });
    assert_eq!(tag(&none, "ghost"), Some(0));
}

#[test]
fn m5_tag_and_link_facets_are_capped() {
    let mut f = Fixture::new();
    for i in 0..20 {
        let tags: String = (0..=i).map(|t| format!(" #t{t:02}")).collect();
        f.page(&format!("p{i:02}.md"), &format!("# P{i}\n\nx{tags}\n"));
    }
    for i in 0..12 {
        for j in 0..=i {
            let text = format!("# L{i}-{j}\n\n[[p{i:02}]]\n");
            f.page(&format!("links/l{i:02}-{j:02}.md"), &text);
        }
    }
    let page = f.search(q());
    assert_eq!(page.facets.tags.len(), 12);
    assert_eq!(page.facets.tags[0].value, "t00");
    assert_eq!(page.facets.tags[0].count, 20);
    assert_eq!(page.facets.links_to.len(), 8);
    assert_eq!(page.facets.links_to[0].path, "p11.md");
    assert_eq!(page.facets.links_to[0].count, 12);
    let rare = f.search(SearchQuery {
        tags: strs(&["t19"]),
        ..q()
    });
    assert!(rare.facets.tags.iter().any(|t| t.value == "t19"));
}

#[test]
fn m5_snippets_around_the_body_match() {
    let mut f = Fixture::new();
    let words: String = (0..60).map(|i| format!("word{i} ")).collect();
    f.page(
        "long.md",
        &format!("# Long\n\n{words} the great WYRM sleeps {words}\n"),
    );
    f.page(
        "titled.md",
        "---\ntags: [wyrm]\n---\n# Other\n\nnothing to see\n",
    );
    let page = f.search(text_query("wyrm"));
    let hit = |p: &str| page.results.iter().find(|h| h.path == p).unwrap();
    let snippet = hit("long.md").snippet.clone().expect("a body match");
    let marked: Vec<&str> = snippet
        .iter()
        .filter(|s| s.hit)
        .map(|s| s.text.as_str())
        .collect();
    assert_eq!(marked, vec!["WYRM"]);
    let text: String = snippet.iter().map(|s| s.text.as_str()).collect();
    let n = text.split_whitespace().count();
    assert!((8..=16).contains(&n), "about 12 words: {text:?}");
    assert!(hit("titled.md").snippet.is_none(), "a metadata-only match");
    // No text, no snippets.
    let page = f.search(q());
    assert!(page.results.iter().all(|h| h.snippet.is_none()));
}

#[test]
fn m5_recent_for_an_empty_query() {
    let mut f = Fixture::new();
    for i in 0..25 {
        f.page(&format!("p{i:02}.md"), "# P\n");
    }
    let page = f.search(q());
    assert!(page.recent);
    assert_eq!(page.results.len(), 20);
    assert_eq!(page.total, 20);
    assert_eq!(page.results[0].path, "p24.md", "newest first");
    let page = f.search(SearchQuery {
        offset: 40,
        limit: 5,
        ..q()
    });
    assert_eq!(page.results.len(), 20, "Recent ignores paging");
}

#[test]
fn m5_paging_and_limits() {
    let mut f = Fixture::new();
    for i in 0..60 {
        f.page(&format!("p{i:02}.md"), "# P\n\ncommon\n");
    }
    let first = f.search(text_query("common"));
    assert_eq!((first.results.len(), first.total), (50, 60));
    let rest = f.search(SearchQuery {
        text: "common".into(),
        offset: 50,
        ..q()
    });
    assert_eq!((rest.results.len(), rest.total), (10, 60));
    let mut all = paths(&first);
    all.extend(paths(&rest));
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 60, "no page twice, none missing");
    let big = f.search(SearchQuery {
        text: "common".into(),
        limit: 500,
        ..q()
    });
    assert_eq!(big.results.len(), 50, "clamped");
    let small = f.search(SearchQuery {
        text: "common".into(),
        limit: 3,
        ..q()
    });
    assert_eq!(small.results.len(), 3);
}

#[test]
fn m5_hit_fields() {
    let mut f = Fixture::new();
    f.attachment("Deep/pics/c.png");
    f.page(
        "Deep/Dragon notes.md",
        "---\ncover: pics/c.png\ntags: [alpha, dragon/red]\n---\n# The Red One\n\n![[x.png]] ![[y.mp3]] #beta\n",
    );
    f.page(
        "remote.md",
        "---\ncover: https://example.com/c.png\n---\n# Remote dragon\n",
    );
    let page = f.search(text_query("drag"));
    let hit = page
        .results
        .iter()
        .find(|h| h.path == "Deep/Dragon notes.md")
        .unwrap();
    assert_eq!(hit.title, "The Red One");
    assert_eq!(hit.cover.as_deref(), Some("Deep/pics/c.png"));
    assert_eq!(
        hit.tags,
        strs(&["dragon/red", "alpha", "beta"]),
        "matching first"
    );
    assert!(hit.has_image && hit.has_audio);
    let remote = page.results.iter().find(|h| h.path == "remote.md").unwrap();
    assert_eq!(remote.cover, None, "remote covers aren't vault files");
    let tagged = f.search(SearchQuery {
        tags: strs(&["beta"]),
        ..q()
    });
    assert_eq!(tagged.results[0].tags[0], "beta", "filter tags first too");
}

#[test]
fn m5_scratch_folder_pages_are_ordinary() {
    let mut f = Fixture::new();
    f.page(
        "Scratchpad/Quick note 2026-10-15 14.32.md",
        "Call Ana about the map\n",
    );
    assert_eq!(
        f.find("ana map"),
        strs(&["Scratchpad/Quick note 2026-10-15 14.32.md"])
    );
}

/// Many matches: the leading tags and pages are found in a sample, but
/// their counts are exact.
#[test]
fn m5_facets_on_many_matches_keep_exact_counts() {
    let mut ix = Index::open_in_memory().unwrap();
    ix.transaction(|tx| {
        tx.upsert_file(&row("Target.md", FileKind::Page, 0))?;
        tx.upsert_page("Target.md", &parse_page("# Target\n", "Target"))?;
        for i in 0..2000 {
            let path = format!("p{i:04}.md");
            let mut text = format!("# P{i}\n\ncommon words #common");
            if i % 20 == 0 {
                text.push_str(" #rare");
            }
            if i % 7 == 0 {
                text.push_str(" [[Target]] [[Target]]");
            }
            tx.upsert_file(&row(&path, FileKind::Page, i))?;
            tx.upsert_page(&path, &parse_page(&text, "p"))?;
        }
        Ok(())
    })
    .unwrap();
    let files = ix.file_set().unwrap();
    ix.resolve_all(&files).unwrap();
    let page = ix.search(&text_query("common")).unwrap();
    assert_eq!(page.total, 2000);
    let tag = |v: &str| {
        page.facets
            .tags
            .iter()
            .find(|t| t.value == v)
            .map(|t| t.count)
    };
    assert_eq!(tag("common"), Some(2000));
    assert_eq!(tag("rare"), Some(100));
    assert_eq!(page.facets.links_to[0].path, "Target.md");
    assert_eq!(page.facets.links_to[0].count, 286, "pages, not links");
}

/// Final review M1: decomposed text (NFD, common in vaults from macOS) gets
/// its snippet and its whole accented word marked.
#[test]
fn m5_review_m1_decomposed_words_get_a_snippet() {
    let mut f = Fixture::new();
    f.page("n.md", "# N\n\nUna Cancio\u{301}n triste.\n");
    let page = f.search(text_query("cancion"));
    let snippet = page.results[0].snippet.clone().expect("a body snippet");
    let marked: Vec<&str> = snippet
        .iter()
        .filter(|s| s.hit)
        .map(|s| s.text.as_str())
        .collect();
    assert_eq!(marked, vec!["Cancio\u{301}n"]);
}

/// Final review M2: a tag matches whether it was written composed or
/// decomposed, and shows as one facet chip.
#[test]
fn m5_review_m2_tags_ignore_the_unicode_form() {
    let mut f = Fixture::new();
    f.page("a.md", "---\ntags: [cancio\u{301}n]\n---\n# A\n");
    f.page("b.md", "---\ntags: [canci\u{f3}n]\n---\n# B\n");
    let page = f.search(SearchQuery {
        tags: strs(&["canci\u{f3}n"]),
        ..q()
    });
    assert_eq!(sorted(paths(&page)), vec!["a.md", "b.md"]);
    let page = f.search(SearchQuery {
        tags: strs(&["cancio\u{301}n"]),
        ..q()
    });
    assert_eq!(paths(&page).len(), 2);
    assert_eq!(f.search(q()).facets.tags.len(), 1, "one chip");
}

/// Final review M3: control characters split words, and a word holding no
/// letter or digit that FTS5 indexes is ignored instead of emptying the result.
#[test]
fn m5_review_m3_odd_words_never_empty_the_result() {
    let mut f = Fixture::new();
    f.page("foo.md", "# Foo\n\nbar here\n");
    assert_eq!(f.find("foo\u{0}bar"), vec!["foo.md"]);
    assert_eq!(f.find("foo \u{93e}"), vec!["foo.md"]);
    assert_eq!(f.find("foo \u{301}"), vec!["foo.md"]);
}

/// Final review M4: a page linking to itself is not among the pages linking
/// to it, in the results or in the chip's count.
#[test]
fn m5_review_m4_self_links_count_the_same_in_filter_and_facet() {
    let mut f = Fixture::new();
    f.page("S.md", "# S\n\nSee [[S]].\n");
    f.page("A.md", "# A\n\nSee [[S]].\n");
    let page = f.search(SearchQuery {
        links_to: Some("S".into()),
        ..q()
    });
    assert_eq!(paths(&page), vec!["A.md"]);
    let chip = page
        .facets
        .links_to
        .iter()
        .find(|c| c.path == "S.md")
        .unwrap();
    assert_eq!(chip.count, page.total);
}

/// Final review M7: a match deep in a long note still gets its snippet, cut
/// on both sides.
#[test]
fn m5_review_m7_a_late_match_in_a_long_note() {
    let mut f = Fixture::new();
    let words: String = (0..5000).map(|i| format!("w{i} ")).collect();
    f.page("long.md", &format!("# L\n\n{words} the WYRM {words}\n"));
    let snippet = f.search(text_query("wyrm")).results[0]
        .snippet
        .clone()
        .unwrap();
    let text: String = snippet.iter().map(|s| s.text.as_str()).collect();
    assert!(text.starts_with('…') && text.ends_with('…'), "{text:?}");
    assert!(text.contains("w4999  the WYRM w0"), "{text:?}");
    let n = text.split_whitespace().count();
    assert!((8..=16).contains(&n), "{text:?}");
}
