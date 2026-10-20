use liber_markdown::LinkKind;
use liber_session::{SessionError, SessionEvent, VaultSession};
use liber_testkit::{copy_fixture, real_trash_tests_enabled, snapshot, trashable_fixture};
use liber_vault::VaultPath;
use std::sync::{Arc, Mutex};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn open(
    root: &std::path::Path,
    cache: &std::path::Path,
) -> (
    VaultSession,
    liber_session::IndexReport,
    Arc<Mutex<Vec<SessionEvent>>>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (s, r) = VaultSession::open(root, cache, move |e| sink.lock().unwrap().push(e)).unwrap();
    (s, r, events)
}

fn targets(s: &VaultSession, page: &str) -> Vec<(String, Option<String>)> {
    s.page(&vp(page))
        .unwrap()
        .unwrap()
        .links
        .into_iter()
        .map(|l| (l.target_raw, l.target_path))
        .collect()
}

#[test]
fn vlt_02_opening_any_fixture_changes_nothing() {
    for name in ["obsidian-basic", "ambiguous-names", "edge-cases"] {
        let vault = copy_fixture(name);
        let cache = tempfile::tempdir().unwrap();
        let before = snapshot(vault.path());
        let _ = open(vault.path(), cache.path());
        assert_eq!(
            snapshot(vault.path()),
            before,
            "{name}: vault bytes or mtimes changed"
        );
        assert!(
            !vault.path().join(".liber").exists(),
            "{name}: .liber created"
        );
        assert!(
            cache.path().join("liber").is_dir(),
            "index lives in the cache dir"
        );
    }
}

#[test]
fn pg_01_04_05_obsidian_basic_is_indexed_and_resolved() {
    let vault = copy_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (s, report, events) = open(vault.path(), cache.path());
    assert_eq!(report.pages, 5);
    assert_eq!(report.removed, 0);
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, SessionEvent::Indexed(_)))
    );

    let rex = s
        .page(&vp("Character Design/rex-draft.md"))
        .unwrap()
        .unwrap();
    assert_eq!(rex.title, "Generator Rex");
    assert_eq!(rex.subtitle.as_deref(), Some("Hero redesign · v3"));
    assert_eq!(rex.cover_y, Some(40));
    assert_eq!(rex.cover_x, None);
    assert!(rex.has_image && rex.has_audio);
    assert_eq!(
        rex.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        vec!["character", "redesign"]
    );
    let got: Vec<_> = rex
        .links
        .iter()
        .map(|l| (l.kind, l.target_path.clone().unwrap_or_default()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                LinkKind::FrontmatterCover,
                "Character Design/assets/rex-cover.png".into()
            ),
            (
                LinkKind::FrontmatterRelated,
                "Character Design/DMC/Sparda.md".into()
            ),
            (LinkKind::FrontmatterRelated, "Game Design/Game 1.md".into()),
            (
                LinkKind::Embed,
                "Character Design/assets/rex-turnaround.png".into()
            ),
            (
                LinkKind::Embed,
                "Character Design/assets/voice-reference.mp3".into()
            ),
            (LinkKind::Markdown, "Character Design/DMC/Sparda.md".into()),
            (LinkKind::Markdown, "Game Design/Game 1.md".into()),
            (LinkKind::Markdown, "Game Design/Game 1.md".into()),
        ]
    );
    assert_eq!(
        targets(&s, "Character Design/My characters.md"),
        vec![
            (
                "rex-draft".into(),
                Some("Character Design/rex-draft.md".into())
            ),
            ("Generator Rex".into(), None),
            (
                "Sparda".into(),
                Some("Character Design/DMC/Sparda.md".into())
            ),
            (
                "DMC/Sparda".into(),
                Some("Character Design/DMC/Sparda.md".into())
            ),
        ]
    );
    assert_eq!(s.backlinks(&vp("Game Design/Game 1.md")).unwrap().len(), 3);
    let tree = s.tree().unwrap();
    assert!(tree.iter().any(|n| n.path == "Game Design/notes.txt"));
    assert!(
        !tree
            .iter()
            .any(|n| n.path.contains(".obsidian") || n.path.contains(".trash"))
    );
}

#[test]
fn pg_05_ambiguous_names_follow_tie_breaks() {
    let vault = copy_fixture("ambiguous-names");
    let cache = tempfile::tempdir().unwrap();
    let (s, ..) = open(vault.path(), cache.path());
    let t = |p| {
        targets(&s, p)
            .into_iter()
            .map(|(_, t)| t.unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        t("Links.md"),
        vec![
            "Ideas.md",
            "Projects/Ideas.md",
            "Projects/Deep/Ideas.md",
            "Archive/Old/Ideas.md"
        ]
    );
    assert_eq!(t("Projects/Other.md"), vec!["Projects/Ideas.md"]);
    assert_eq!(t("Elsewhere/Note.md"), vec!["Ideas.md"]);
}

#[test]
fn edge_cases_are_indexed_with_warnings_not_errors() {
    let vault = copy_fixture("edge-cases");
    let cache = tempfile::tempdir().unwrap();
    let (s, report, _) = open(vault.path(), cache.path());
    let w = report.warnings.join("\n");
    assert!(w.contains("latin1.md") && w.contains("bad-yaml.md"), "{w}");
    assert!(
        s.page(&vp("latin1.md")).unwrap().is_none(),
        "non-UTF-8 page is an attachment"
    );
    assert_eq!(
        targets(&s, "code.md"),
        vec![("target".into(), Some("target.md".into()))]
    );
    assert_eq!(
        targets(&s, "bad-yaml.md"),
        vec![("target".into(), Some("target.md".into()))]
    );
    let crlf = s.page(&vp("crlf.md")).unwrap().unwrap();
    assert_eq!(
        (crlf.title.as_str(), crlf.subtitle.as_deref()),
        ("CRLF page", Some("Windows"))
    );
    assert_eq!(
        targets(&s, "unicode/Café ñandú 🎨.md")[0].1.as_deref(),
        Some("unicode/Café ñandú 🎨.md")
    );
    assert_eq!(s.page(&vp("empty.md")).unwrap().unwrap().title, "empty");
}

#[test]
fn nfr_03_reopen_is_incremental() {
    let vault = copy_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (_, first, _) = open(vault.path(), cache.path());
    let (_, second, _) = open(vault.path(), cache.path());
    assert_eq!(second.parsed, 0);
    assert_eq!(second.skipped_unchanged, first.parsed);
    std::fs::write(vault.path().join("Welcome.md"), "# Welcome back\n").unwrap();
    std::fs::remove_file(vault.path().join("Game Design/notes.txt")).unwrap();
    let (s, third, _) = open(vault.path(), cache.path());
    assert_eq!((third.parsed, third.removed), (1, 1));
    assert_eq!(
        s.page(&vp("Welcome.md")).unwrap().unwrap().title,
        "Welcome back"
    );
}

#[test]
fn exp_02_create_page_and_folder_resolve_waiting_links() {
    let vault = copy_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (s, ..) = open(vault.path(), cache.path());
    let dir = s.create_folder(&vp("Character Design"), "Heroes").unwrap();
    assert!(vault.path().join("Character Design/Heroes").is_dir());
    let page = s.create_page(&dir, "Generator Rex").unwrap();
    assert_eq!(page.as_str(), "Character Design/Heroes/Generator Rex.md");
    assert_eq!(
        std::fs::read(vault.path().join(page.as_str())).unwrap(),
        b""
    );
    assert_eq!(
        targets(&s, "Character Design/My characters.md")[1]
            .1
            .as_deref(),
        Some("Character Design/Heroes/Generator Rex.md")
    );
    assert!(matches!(
        s.create_page(&dir, "Generator Rex.md"),
        Err(SessionError::Vault(_))
    ));
    for bad in ["", "  ", "a/b", ".hidden"] {
        assert!(
            matches!(s.create_page(&dir, bad), Err(SessionError::InvalidName(_))),
            "{bad:?}"
        );
    }
}

#[test]
fn exp_03_trash_removes_from_index_and_unresolves_links() {
    if !real_trash_tests_enabled() {
        return;
    }
    let vault = trashable_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (s, ..) = open(vault.path(), cache.path());
    s.trash(&vp("Character Design/DMC")).unwrap();
    assert!(!vault.path().join("Character Design/DMC").exists());
    assert!(
        s.page(&vp("Character Design/DMC/Sparda.md"))
            .unwrap()
            .is_none()
    );
    assert_eq!(targets(&s, "Character Design/My characters.md")[2].1, None);
}

#[test]
fn review_focus_names_differing_only_by_case_on_case_sensitive_fs() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("ideas.md"), "# lower").unwrap();
    if vault.path().join("IDEAS.md").exists() {
        return; // case-insensitive filesystem (macOS/Windows default): nothing to test
    }
    std::fs::write(vault.path().join("Ideas.md"), "# upper").unwrap();
    std::fs::write(vault.path().join("Link.md"), "[[IDEAS]]").unwrap();
    let cache = tempfile::tempdir().unwrap();
    let (s, report, _) = open(vault.path(), cache.path());
    assert_eq!(report.pages, 3);
    assert_eq!(
        targets(&s, "Link.md")[0].1.as_deref(),
        Some("Ideas.md"),
        "deterministic: path order"
    );
}

#[test]
fn m5b_r2_folders_list_their_entries_in_their_own_order() {
    use liber_vault::FolderSort;
    use std::time::{Duration, SystemTime};
    let vault = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let root = vault.path();
    std::fs::create_dir_all(root.join("Z")).unwrap();
    std::fs::create_dir_all(root.join("A")).unwrap();
    let base = SystemTime::now() - Duration::from_secs(3600);
    for (name, age) in [("a.md", 30), ("b.md", 10), ("c.md", 20)] {
        let path = root.join(name);
        std::fs::write(&path, "x\n").unwrap();
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(base + Duration::from_secs(100 - age))
            .unwrap();
    }
    let (s, _, _) = open(root, cache.path());
    let order = |s: &VaultSession| -> Vec<String> {
        s.tree()
            .unwrap()
            .into_iter()
            .filter(|n| !n.path.contains('/'))
            .map(|n| n.path)
            .collect()
    };
    // The default, unchanged: folders first, then by name.
    assert_eq!(order(&s), ["A", "Z", "a.md", "b.md", "c.md"]);
    s.vault().set_folder_sort("", FolderSort::NameDesc).unwrap();
    assert_eq!(order(&s), ["Z", "A", "c.md", "b.md", "a.md"]);
    s.vault()
        .set_folder_sort("", FolderSort::ModifiedDesc)
        .unwrap();
    assert_eq!(order(&s), ["A", "Z", "b.md", "c.md", "a.md"]);
    s.vault()
        .set_folder_sort("", FolderSort::ModifiedAsc)
        .unwrap();
    assert_eq!(order(&s), ["A", "Z", "a.md", "c.md", "b.md"]);
    // Created: every file here was created in the same instant or so; the
    // order still holds folders first and is total (ties by name).
    s.vault()
        .set_folder_sort("", FolderSort::CreatedDesc)
        .unwrap();
    assert_eq!(&order(&s)[..2], ["A", "Z"]);
}
