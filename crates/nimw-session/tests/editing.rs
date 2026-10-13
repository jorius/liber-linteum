//! Editing support for M2a (spec §3.1): CAS page writes, conflict copies and
//! link resolution against the live file set.

use nimw_markdown::LinkKind;
use nimw_session::{SessionError, SessionEvent, VaultSession};
use nimw_testkit::copy_fixture;
use nimw_vault::{Hash, VaultError, VaultPath};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn session(fixture: &str) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
    let vault = copy_fixture(fixture);
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    (vault, cache, s)
}

#[test]
fn ed_08_write_page_is_compare_and_swap_and_reindexes() {
    let (dir, _c, s) = session("obsidian-basic");
    let path = vp("Welcome.md");
    let (_, hash) = s.vault().read_to_string(&path).unwrap();
    let new_hash = s
        .write_page(&path, "# Hello again\n\n[[Sparda]]\n", hash)
        .unwrap();
    assert_eq!(new_hash, Hash::of(b"# Hello again\n\n[[Sparda]]\n"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Welcome.md")).unwrap(),
        "# Hello again\n\n[[Sparda]]\n"
    );
    let page = s.page(&path).unwrap().unwrap();
    assert_eq!(page.title, "Hello again");
    assert_eq!(
        page.links[0].target_path.as_deref(),
        Some("Character Design/DMC/Sparda.md")
    );
    // A stale expected hash is refused and nothing is written.
    let err = s.write_page(&path, "lost", hash).unwrap_err();
    assert!(
        matches!(err, SessionError::Vault(VaultError::Conflict { current, .. }) if current == new_hash),
        "{err:?}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Welcome.md")).unwrap(),
        "# Hello again\n\n[[Sparda]]\n"
    );
}

#[test]
fn ed_08_conflict_copies_get_free_names_next_to_the_page() {
    let (dir, _c, s) = session("obsidian-basic");
    let first = s
        .create_conflict_copy(&vp("Game Design/Game 1.md"), "theirs 1")
        .unwrap();
    let second = s
        .create_conflict_copy(&vp("Game Design/Game 1.md"), "theirs 2")
        .unwrap();
    assert_eq!(first.as_str(), "Game Design/Game 1 (conflict).md");
    assert_eq!(second.as_str(), "Game Design/Game 1 (conflict 2).md");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Game Design/Game 1 (conflict 2).md")).unwrap(),
        "theirs 2"
    );
    assert!(
        s.page(&second).unwrap().is_some(),
        "conflict copy is indexed"
    );
}

#[test]
fn pg_05_resolve_links_uses_the_live_file_set() {
    let (_d, _c, s) = session("ambiguous-names");
    let targets = vec![
        (LinkKind::Wiki, "Ideas".to_string()),
        (LinkKind::Wiki, "Deep/Ideas".to_string()),
        (LinkKind::Markdown, "Ideas.md".to_string()),
        (LinkKind::Wiki, "Nowhere".to_string()),
    ];
    let got = s.resolve_links(&vp("Projects/Other.md"), &targets).unwrap();
    assert_eq!(
        got,
        vec![
            Some("Projects/Ideas.md".to_string()),
            Some("Projects/Deep/Ideas.md".to_string()),
            Some("Projects/Ideas.md".to_string()),
            None,
        ]
    );
    s.create_page(&VaultPath::root(), "Nowhere").unwrap();
    let again = s
        .resolve_links(
            &vp("Projects/Other.md"),
            &[(LinkKind::Wiki, "Nowhere".to_string())],
        )
        .unwrap();
    assert_eq!(again, vec![Some("Nowhere.md".to_string())]);
}
