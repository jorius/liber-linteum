use nimw_session::{SessionError, SessionEvent, VaultSession};
use nimw_testkit::{copy_fixture, snapshot};
use nimw_vault::VaultPath;

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn session(fixture: &str) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
    let vault = copy_fixture(fixture);
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    (vault, cache, s)
}

fn read(dir: &tempfile::TempDir, p: &str) -> String {
    std::fs::read_to_string(dir.path().join(p)).unwrap()
}

/// Every resolved link target of every page, as (src, target).
fn all_targets(s: &VaultSession) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for node in s.tree().unwrap() {
        if let Some(page) = s.page(&vp(&node.path)).unwrap() {
            out.extend(
                page.links
                    .into_iter()
                    .map(|l| (node.path.clone(), l.target_path)),
            );
        }
    }
    out
}

#[test]
fn exp_04_rename_page_rewrites_wikilinks_related_and_markdown_links() {
    let (dir, _c, s) = session("obsidian-basic");
    let out = s
        .rename(
            &vp("Character Design/DMC/Sparda.md"),
            &vp("Character Design/DMC/Sparda the Dark Knight.md"),
            true,
        )
        .unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(
        out.updated_files,
        vec![
            "Character Design/My characters.md",
            "Character Design/rex-draft.md"
        ]
    );
    assert_eq!(out.updated_links, 4);
    let mine = read(&dir, "Character Design/My characters.md");
    assert!(
        mine.contains("- [[Sparda the Dark Knight#Coat|the demon knight]]\n"),
        "{mine}"
    );
    assert!(
        mine.contains("- [[Sparda the Dark Knight]]\n"),
        "path form rewritten to shortest: {mine}"
    );
    let rex = read(&dir, "Character Design/rex-draft.md");
    assert!(
        rex.contains("  - \"[[Sparda the Dark Knight]]\"\n"),
        "{rex}"
    );
    assert!(
        rex.contains("[Sparda's page](DMC/Sparda%20the%20Dark%20Knight.md#Palette)"),
        "{rex}"
    );
    assert!(
        all_targets(&s)
            .iter()
            .all(|(_, t)| t.as_deref() != Some("Character Design/DMC/Sparda.md"))
    );
    assert_eq!(
        s.backlinks(&vp("Character Design/DMC/Sparda the Dark Knight.md"))
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn exp_04_rename_attachment_rewrites_cover_and_embeds() {
    let (dir, _c, s) = session("obsidian-basic");
    s.rename(
        &vp("Character Design/assets/rex-cover.png"),
        &vp("Character Design/assets/cover.png"),
        true,
    )
    .unwrap();
    s.rename(
        &vp("Character Design/assets/rex-turnaround.png"),
        &vp("Character Design/assets/turn.png"),
        true,
    )
    .unwrap();
    let rex = read(&dir, "Character Design/rex-draft.md");
    assert!(rex.contains("cover: assets/cover.png\n"), "{rex}");
    assert!(rex.contains("Turnaround: ![[turn.png]]\n"), "{rex}");
}

#[test]
fn exp_02_04_move_folder_rewrites_only_links_that_would_break() {
    let (dir, _c, s) = session("obsidian-basic");
    let before_mine = read(&dir, "Character Design/My characters.md");
    s.create_folder(&VaultPath::root(), "Archive").unwrap();
    let out = s
        .rename(&vp("Character Design/DMC"), &vp("Archive/DMC"), true)
        .unwrap();
    assert_eq!(
        out.moved,
        vec![(
            "Character Design/DMC/Sparda.md".into(),
            "Archive/DMC/Sparda.md".into()
        )]
    );
    assert_eq!(
        read(&dir, "Character Design/My characters.md"),
        before_mine,
        "[[Sparda]] and [[DMC/Sparda]] still resolve"
    );
    let rex = read(&dir, "Character Design/rex-draft.md");
    assert!(
        rex.contains("[Sparda's page](../Archive/DMC/Sparda.md#Palette)"),
        "{rex}"
    );
    assert!(rex.contains("  - \"[[Sparda]]\"\n"), "{rex}");
    assert!(dir.path().join("Archive/DMC/Sparda.md").is_file());
    assert_eq!(
        s.page(&vp("Archive/DMC/Sparda.md")).unwrap().unwrap().links[0]
            .target_path
            .as_deref(),
        Some("Character Design/My characters.md")
    );
}

#[test]
fn exp_04_moving_a_page_fixes_its_own_relative_links() {
    let (dir, _c, s) = session("obsidian-basic");
    s.rename(
        &vp("Character Design/rex-draft.md"),
        &vp("Game Design/rex-draft.md"),
        true,
    )
    .unwrap();
    let rex = read(&dir, "Game Design/rex-draft.md");
    assert!(
        rex.contains("cover: ../Character Design/assets/rex-cover.png\n"),
        "{rex}"
    );
    assert!(
        rex.contains("[Sparda's page](../Character%20Design/DMC/Sparda.md#Palette)"),
        "{rex}"
    );
    assert!(
        rex.contains("[the game](</Game Design/Game 1.md>)"),
        "rooted link untouched: {rex}"
    );
    assert!(
        rex.contains("[encoded](../Game%20Design/Game%201.md)"),
        "still resolves, untouched: {rex}"
    );
    assert!(
        rex.contains("![[rex-turnaround.png]]"),
        "name-based embed untouched"
    );
    let resolved: Vec<_> = s
        .page(&vp("Game Design/rex-draft.md"))
        .unwrap()
        .unwrap()
        .links
        .into_iter()
        .map(|l| l.target_path)
        .collect();
    assert!(resolved.iter().all(Option::is_some), "{resolved:?}");
    assert_eq!(
        s.backlinks(&vp("Game Design/rex-draft.md")).unwrap().len(),
        2,
        "[[rex-draft]] links still resolve"
    );
}

#[test]
fn exp_04_ambiguity_keeps_every_link_on_its_target() {
    let (dir, _c, s) = session("ambiguous-names");
    let out = s
        .rename(&vp("Archive/Old/Ideas.md"), &vp("Elsewhere/Ideas.md"), true)
        .unwrap();
    assert!(out.failed.is_empty());
    assert_eq!(
        read(&dir, "Elsewhere/Note.md"),
        "# Note\n\n[[/Ideas]]\n",
        "shadowed root file → rooted form"
    );
    let links = read(&dir, "Links.md");
    assert!(
        links.contains(
            "- [[Ideas]]\n- [[Projects/Ideas]]\n- [[Deep/Ideas]]\n- [[Elsewhere/Ideas]]\n"
        ),
        "{links}"
    );
    let t: Vec<_> = s
        .page(&vp("Elsewhere/Note.md"))
        .unwrap()
        .unwrap()
        .links
        .into_iter()
        .map(|l| l.target_path)
        .collect();
    assert_eq!(t, vec![Some("Ideas.md".to_string())]);
}

#[test]
fn exp_04_rewrite_disabled_only_moves() {
    let (dir, _c, s) = session("obsidian-basic");
    let before = snapshot(dir.path());
    let out = s
        .rename(
            &vp("Game Design/Game 1.md"),
            &vp("Game Design/Game One.md"),
            false,
        )
        .unwrap();
    assert!(out.updated_files.is_empty());
    let after = snapshot(dir.path());
    let changed: Vec<_> = before
        .keys()
        .filter(|k| after.get(*k) != before.get(*k))
        .collect();
    assert_eq!(
        changed.len(),
        2,
        "only the moved file and its folder mtime: {changed:?}"
    );
    assert_eq!(
        s.backlinks(&vp("Game Design/Game One.md")).unwrap().len(),
        0,
        "links now unresolved"
    );
}

#[test]
fn exp_02_case_only_rename_of_a_page() {
    let (dir, _c, s) = session("ambiguous-names");
    s.rename(&vp("Links.md"), &vp("links.md"), true).unwrap();
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(names.contains(&"links.md".to_string()) && !names.contains(&"Links.md".to_string()));
    assert!(s.page(&vp("links.md")).unwrap().is_some());
}

#[test]
fn rename_rejects_invalid_requests() {
    let (_d, _c, s) = session("obsidian-basic");
    assert!(matches!(
        s.rename(&vp("Character Design"), &vp("Character Design/DMC/x"), true),
        Err(SessionError::InvalidName(_))
    ));
    assert!(matches!(
        s.rename(&vp("nope.md"), &vp("x.md"), true),
        Err(SessionError::NotIndexed(_))
    ));
    assert!(matches!(
        s.rename(&vp("Welcome.md"), &vp("Game Design/Game 1.md"), true),
        Err(SessionError::Vault(_))
    ));
    assert!(matches!(
        s.rename(&vp("Welcome.md"), &vp("Welcome.md"), true),
        Err(SessionError::InvalidName(_))
    ));
}
