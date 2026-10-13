use nimw_index::{FileKind, FileRow, Index, SCHEMA_VERSION};
use nimw_markdown::{LinkKind, parse_page};

fn file(path: &str, kind: FileKind) -> FileRow {
    FileRow {
        path: path.into(),
        kind,
        mtime_ns: 1,
        size: 1,
        hash: (kind != FileKind::Folder).then(|| "h".into()),
    }
}

/// Small vault: folder A with a page and an image, a root page linking into A.
fn sample() -> Index {
    let mut idx = Index::open_in_memory().unwrap();
    idx.transaction(|tx| {
        tx.upsert_file(&file("A", FileKind::Folder))?;
        tx.upsert_file(&file("A/Ideas.md", FileKind::Page))?;
        tx.upsert_file(&file("A/pic.png", FileKind::Attachment))?;
        tx.upsert_file(&file("Home.md", FileKind::Page))?;
        tx.upsert_page(
            "A/Ideas.md",
            &parse_page("# Ideas\n\n![[pic.png]] #idea", "Ideas"),
        )?;
        tx.upsert_page(
            "Home.md",
            &parse_page("# Home\n\n[[Ideas]] and [[Missing]] #Home", "Home"),
        )?;
        Ok(())
    })
    .unwrap();
    let files = idx.file_set().unwrap();
    idx.resolve_all(&files).unwrap();
    idx
}

#[test]
fn pg_05_resolve_all_and_backlinks() {
    let idx = sample();
    let home = idx.page("Home.md").unwrap().unwrap();
    assert_eq!(home.title, "Home");
    let targets: Vec<_> = home
        .links
        .iter()
        .map(|l| (l.target_raw.as_str(), l.target_path.as_deref()))
        .collect();
    assert_eq!(
        targets,
        vec![("Ideas", Some("A/Ideas.md")), ("Missing", None)]
    );
    assert_eq!(idx.backlinks("A/Ideas.md").unwrap()[0].src, "Home.md");
    assert_eq!(
        idx.page("A/Ideas.md").unwrap().unwrap().links[0].kind,
        LinkKind::Embed
    );
    assert_eq!(
        idx.links_into("A").unwrap().len(),
        2,
        "link to page + embed of image"
    );
}

#[test]
fn pg_04_tags_are_stored_with_keys() {
    let idx = sample();
    let tags = idx.page("Home.md").unwrap().unwrap().tags;
    assert_eq!(
        (tags[0].text.as_str(), tags[0].key.as_str()),
        ("Home", "home")
    );
}

#[test]
fn pg_05_resolve_affected_picks_up_created_and_removed_files() {
    let mut idx = sample();
    idx.transaction(|tx| tx.upsert_file(&file("Missing.md", FileKind::Page)))
        .unwrap();
    let files = idx.file_set().unwrap();
    assert_eq!(
        idx.resolve_affected(&files, &["missing".into()]).unwrap(),
        1
    );
    assert_eq!(idx.backlinks("Missing.md").unwrap().len(), 1);
    idx.transaction(|tx| tx.remove("Missing.md")).unwrap();
    assert!(idx.backlinks("Missing.md").unwrap().is_empty());
    let home = idx.page("Home.md").unwrap().unwrap();
    assert_eq!(home.links[1].target_path, None);
}

#[test]
fn exp_02_rename_folder_moves_subtree_and_link_targets() {
    let mut idx = sample();
    idx.transaction(|tx| tx.rename("A", "B/A2")).unwrap();
    let paths: Vec<_> = idx.tree().unwrap().into_iter().map(|n| n.path).collect();
    assert!(
        paths.contains(&"B/A2/Ideas.md".to_string()) && !paths.iter().any(|p| p.starts_with("A/"))
    );
    assert_eq!(idx.backlinks("B/A2/Ideas.md").unwrap()[0].src, "Home.md");
    assert!(
        idx.page("B/A2/Ideas.md").unwrap().is_some(),
        "page row followed via ON UPDATE CASCADE"
    );
    assert_eq!(idx.links_from("B/A2/Ideas.md").unwrap().len(), 1);
}

#[test]
fn exp_03_remove_folder_removes_subtree() {
    let mut idx = sample();
    idx.transaction(|tx| tx.remove("A")).unwrap();
    assert_eq!(idx.counts().unwrap(), (1, 1));
    assert_eq!(
        idx.page("Home.md").unwrap().unwrap().links[0].target_path,
        None
    );
}

#[test]
fn exp_01_tree_orders_folders_first_then_name() {
    let mut idx = sample();
    idx.transaction(|tx| {
        tx.upsert_file(&file("b.md", FileKind::Page))?;
        tx.upsert_file(&file("Z", FileKind::Folder))?;
        tx.upsert_page("b.md", &parse_page("", "b"))
    })
    .unwrap();
    let root: Vec<_> = idx
        .tree()
        .unwrap()
        .into_iter()
        .filter(|n| n.parent.is_empty())
        .map(|n| n.name)
        .collect();
    assert_eq!(root, vec!["A", "Z", "b.md", "Home.md"]);
    let home = idx
        .tree()
        .unwrap()
        .into_iter()
        .find(|n| n.path == "Home.md")
        .unwrap();
    assert_eq!(home.title.as_deref(), Some("Home"));
}

#[test]
fn upsert_file_as_attachment_drops_page_data() {
    let mut idx = sample();
    idx.transaction(|tx| tx.upsert_file(&file("Home.md", FileKind::Attachment)))
        .unwrap();
    assert!(idx.page("Home.md").unwrap().is_none());
    assert!(idx.links_from("Home.md").unwrap().is_empty());
}

#[test]
fn review_focus_corrupt_or_foreign_or_old_db_is_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("nimw/abc/index.sqlite");
    {
        let mut idx = Index::open(&db).unwrap();
        idx.transaction(|tx| tx.upsert_file(&file("x.md", FileKind::Page)))
            .unwrap();
    }
    assert_eq!(
        Index::open(&db).unwrap().counts().unwrap().0,
        1,
        "reopen keeps data"
    );

    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'schema_version'",
            [(SCHEMA_VERSION + 1).to_string()],
        )
        .unwrap();
    }
    assert_eq!(
        Index::open(&db).unwrap().counts().unwrap().0,
        0,
        "version mismatch → fresh"
    );

    std::fs::write(&db, b"this is not a database at all, just junk bytes").unwrap();
    assert_eq!(
        Index::open(&db).unwrap().counts().unwrap().0,
        0,
        "garbage → fresh"
    );

    let foreign = dir.path().join("foreign.sqlite");
    rusqlite::Connection::open(&foreign)
        .unwrap()
        .execute_batch("CREATE TABLE other (x);")
        .unwrap();
    assert_eq!(
        Index::open(&foreign).unwrap().counts().unwrap().0,
        0,
        "foreign db → fresh"
    );
}

#[test]
fn stats_return_stored_stat() {
    let idx = sample();
    let stats = idx.stats().unwrap();
    assert_eq!(stats["A"].kind, FileKind::Folder);
    assert_eq!(
        idx.stat("Home.md").unwrap().unwrap().hash.as_deref(),
        Some("h")
    );
    assert!(idx.stat("nope").unwrap().is_none());
}
