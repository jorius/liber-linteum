use liber_session::{SessionError, SessionEvent, VaultSession};
use liber_testkit::{copy_fixture, snapshot};
use liber_vault::{CoverSide, Follow, VaultPath};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn session(fixture: &str) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
    let vault = copy_fixture(fixture);
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    (vault, cache, s)
}

/// Through the vault, so the test runs on the encrypted switch too.
fn read(s: &VaultSession, p: &str) -> String {
    String::from_utf8(s.vault().read(&vp(p)).unwrap().0).unwrap()
}

fn exists(s: &VaultSession, p: &str) -> bool {
    s.vault().meta(&vp(p), Follow::No).unwrap().is_some()
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
    let (_dir, _c, s) = session("obsidian-basic");
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
    let mine = read(&s, "Character Design/My characters.md");
    assert!(
        mine.contains("- [[Sparda the Dark Knight#Coat|the demon knight]]\n"),
        "{mine}"
    );
    assert!(
        mine.contains("- [[Sparda the Dark Knight]]\n"),
        "path form rewritten to shortest: {mine}"
    );
    let rex = read(&s, "Character Design/rex-draft.md");
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
    let (_dir, _c, s) = session("obsidian-basic");
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
    let rex = read(&s, "Character Design/rex-draft.md");
    assert!(rex.contains("cover: assets/cover.png\n"), "{rex}");
    assert!(rex.contains("Turnaround: ![[turn.png]]\n"), "{rex}");
}

#[test]
fn exp_02_04_move_folder_rewrites_only_links_that_would_break() {
    let (_dir, _c, s) = session("obsidian-basic");
    let before_mine = read(&s, "Character Design/My characters.md");
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
        read(&s, "Character Design/My characters.md"),
        before_mine,
        "[[Sparda]] and [[DMC/Sparda]] still resolve"
    );
    let rex = read(&s, "Character Design/rex-draft.md");
    assert!(
        rex.contains("[Sparda's page](../Archive/DMC/Sparda.md#Palette)"),
        "{rex}"
    );
    assert!(rex.contains("  - \"[[Sparda]]\"\n"), "{rex}");
    assert!(exists(&s, "Archive/DMC/Sparda.md"));
    assert_eq!(
        s.page(&vp("Archive/DMC/Sparda.md")).unwrap().unwrap().links[0]
            .target_path
            .as_deref(),
        Some("Character Design/My characters.md")
    );
}

#[test]
fn exp_04_moving_a_page_fixes_its_own_relative_links() {
    let (_dir, _c, s) = session("obsidian-basic");
    s.rename(
        &vp("Character Design/rex-draft.md"),
        &vp("Game Design/rex-draft.md"),
        true,
    )
    .unwrap();
    let rex = read(&s, "Game Design/rex-draft.md");
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
    let (_dir, _c, s) = session("ambiguous-names");
    let out = s
        .rename(&vp("Archive/Old/Ideas.md"), &vp("Elsewhere/Ideas.md"), true)
        .unwrap();
    assert!(out.failed.is_empty());
    assert_eq!(
        read(&s, "Elsewhere/Note.md"),
        "# Note\n\n[[/Ideas]]\n",
        "shadowed root file → rooted form"
    );
    let links = read(&s, "Links.md");
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
    if liber_testkit::plain_disk_only() {
        return;
    }
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

/// A fresh vault from `(path, content)` pairs, opened in a session.
fn vault_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
    let vault = tempfile::tempdir().unwrap();
    for (p, c) in files {
        let full = vault.path().join(p);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, c).unwrap();
    }
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    (vault, cache, s)
}

/// Final review C1: a linked image and frontmatter that pulldown-cmark does not
/// recognise used to produce overlapping edits that corrupted the note.
#[test]
fn exp_04_linked_image_and_unrecognised_frontmatter_rewrite_cleanly() {
    let (_dir, _c, s) = vault_with(&[
        ("x.png", b"png"),
        ("A.md", b"# A\n"),
        ("p.md", b"[![alt](x.png)](x.png)\n"),
        ("q.md", b"---\n\nrelated:\n  - \"[[A]]\"\n---\n# Q\n"),
    ]);
    let out = s.rename(&vp("x.png"), &vp("new name.png"), true).unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(
        read(&s, "p.md"),
        "[![alt](new%20name.png)](new%20name.png)\n"
    );
    let out = s.rename(&vp("A.md"), &vp("Longer Name.md"), true).unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(
        read(&s, "q.md"),
        "---\n\nrelated:\n  - \"[[Longer Name]]\"\n---\n# Q\n"
    );
}

/// Final review I1: names that cannot be linked to are refused up front.
#[test]
fn exp_02_names_that_would_break_links_are_rejected() {
    let (_dir, _c, s) = vault_with(&[("A.md", b"# A\n"), ("p.md", b"[[A]]\n")]);
    for bad in [
        "C# basics.md",
        "a|b.md",
        "x^y.md",
        "[x].md",
        "q?.md",
        "note: draft.md",
        ".hidden.md",
    ] {
        assert!(
            matches!(
                s.rename(&vp("A.md"), &vp(bad), true),
                Err(SessionError::InvalidName(_))
            ),
            "{bad}"
        );
    }
    assert!(matches!(
        s.create_page(&VaultPath::root(), "C#"),
        Err(SessionError::InvalidName(_))
    ));
    assert!(matches!(
        s.create_folder(&VaultPath::root(), "a|b"),
        Err(SessionError::InvalidName(_))
    ));
    assert_eq!(read(&s, "p.md"), "[[A]]\n");
}

/// Final review I1: an existing folder whose name needs escaping in a Markdown
/// destination gets %-encoded, so the link keeps pointing at the file.
#[test]
fn exp_04_markdown_destination_into_hash_folder_is_encoded() {
    let (_dir, _c, s) = vault_with(&[
        ("A.md", b"# A\n"),
        ("C#/keep.md", b"x\n"),
        ("p.md", b"[a](A.md)\n"),
    ]);
    let out = s.rename(&vp("A.md"), &vp("C#/A.md"), true).unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(read(&s, "p.md"), "[a](C%23/A.md)\n");
    assert_eq!(
        s.page(&vp("p.md")).unwrap().unwrap().links[0]
            .target_path
            .as_deref(),
        Some("C#/A.md")
    );
}

/// Final review I1: when no link text can point at the moved file (a wikilink
/// path through a folder named with `#`), the file is left unchanged and
/// reported instead of being rewritten to a link that resolves elsewhere.
#[test]
fn exp_04_unlinkable_rewrite_is_reported_not_written() {
    let (_dir, _c, s) = vault_with(&[
        ("A.md", b"# A\n"),
        ("B/A.md", b"# other A\n"),
        ("C#/keep.md", b"x\n"),
        ("Q/p.md", b"[[A]]\n"),
    ]);
    let out = s.rename(&vp("A.md"), &vp("C#/A.md"), true).unwrap();
    assert_eq!(read(&s, "Q/p.md"), "[[A]]\n");
    assert_eq!(out.failed.len(), 1, "{out:?}");
    assert_eq!(out.failed[0].0, "Q/p.md");
}

/// Final review (M1, re-graded Important): a symlinked note is never replaced
/// by a plain file; its link edits happen through the real file.
#[cfg(unix)]
#[test]
fn exp_04_symlinked_notes_stay_symlinks() {
    // No symlinks in an encrypted vault (E3).
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("A.md", b"# A\n"), ("real.md", b"[[A]]\n")]);
    std::os::unix::fs::symlink(dir.path().join("real.md"), dir.path().join("alias.md")).unwrap();
    drop(s);
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(dir.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    s.rename(&vp("A.md"), &vp("B.md"), true).unwrap();
    let meta = std::fs::symlink_metadata(dir.path().join("alias.md")).unwrap();
    assert!(
        meta.file_type().is_symlink(),
        "alias.md must stay a symlink"
    );
    assert_eq!(read(&s, "real.md"), "[[B]]\n");
    assert_eq!(read(&s, "alias.md"), "[[B]]\n");
}

/// Cover resize: a page's cover height (`.liber/vault.json` `coverHeights`)
/// follows an in-app rename, and a folder move takes its pages' with it.
#[test]
fn cover_heights_follow_in_app_renames_and_folder_moves() {
    let (_dir, _c, s) = session("obsidian-basic");
    s.vault().set_cover_height("Welcome.md", Some(280)).unwrap();
    s.vault()
        .set_cover_height("Game Design/Game 1.md", Some(360))
        .unwrap();
    s.rename(&vp("Welcome.md"), &vp("Hello.md"), true).unwrap();
    s.rename(&vp("Game Design"), &vp("Design"), true).unwrap();
    assert_eq!(
        s.vault().cover_heights().into_iter().collect::<Vec<_>>(),
        vec![
            ("Design/Game 1.md".to_string(), 360),
            ("Hello.md".to_string(), 280),
        ]
    );
}

/// M4b part 3 §3: a page's cover placement and strip width follow an in-app
/// rename, and a folder move takes its pages' with them.
#[test]
fn cover_sides_and_widths_follow_in_app_renames_and_folder_moves() {
    let (_dir, _c, s) = session("obsidian-basic");
    s.vault()
        .set_cover_side("Welcome.md", CoverSide::Left)
        .unwrap();
    s.vault().set_cover_width("Welcome.md", Some(320)).unwrap();
    s.vault()
        .set_cover_side("Game Design/Game 1.md", CoverSide::Right)
        .unwrap();
    s.rename(&vp("Welcome.md"), &vp("Hello.md"), true).unwrap();
    s.rename(&vp("Game Design"), &vp("Design"), true).unwrap();
    assert_eq!(
        s.vault().cover_sides().into_iter().collect::<Vec<_>>(),
        vec![
            ("Design/Game 1.md".to_string(), CoverSide::Right),
            ("Hello.md".to_string(), CoverSide::Left),
        ]
    );
    assert_eq!(
        s.vault().cover_widths().into_iter().collect::<Vec<_>>(),
        vec![("Hello.md".to_string(), 320)]
    );
}

/// M5b §4: a folder's icon follows an in-app rename.
#[test]
fn m5b_folder_icons_follow_renames() {
    let (_dir, _c, s) = session("obsidian-basic");
    s.vault()
        .set_folder_icon("Game Design", Some("🎮"))
        .unwrap();
    s.rename(&vp("Game Design"), &vp("Design"), true).unwrap();
    assert_eq!(
        s.vault().folder_icons().into_iter().collect::<Vec<_>>(),
        vec![("Design".to_string(), "🎮".to_string())]
    );
}

/// Round-2 review M1 (ruling, spec §17): link maintenance is exempt from the
/// read-only Archive — renaming a live page rewrites links inside archived
/// pages too, so they keep working once unarchived.
#[test]
fn m5b_r2_review_m1_a_rename_rewrites_links_inside_archived_pages() {
    let vault = copy_fixture("obsidian-basic");
    std::fs::create_dir_all(vault.path().join(".archive")).unwrap();
    std::fs::write(
        vault.path().join(".archive/Old notes.md"),
        "See [[Sparda]].\n",
    )
    .unwrap();
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    let out = s
        .rename(
            &vp("Character Design/DMC/Sparda.md"),
            &vp("Character Design/DMC/Sparda the Dark Knight.md"),
            true,
        )
        .unwrap();
    assert!(
        out.updated_files
            .iter()
            .any(|f| f == ".archive/Old notes.md"),
        "{:?}",
        out.updated_files
    );
    assert_eq!(
        read(&s, ".archive/Old notes.md"),
        "See [[Sparda the Dark Knight]].\n"
    );
}

// ---- Round 3b §6.3: folder pages (`X/X.md`) rename with their folder ----

/// obsidian-basic plus `Lore/Lore.md`, `Lore/Other.md` and `Index.md` → `[[Lore]]`.
fn lore_session(extra: &[&str]) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
    let vault = copy_fixture("obsidian-basic");
    std::fs::create_dir_all(vault.path().join("Lore")).unwrap();
    std::fs::write(vault.path().join("Lore/Lore.md"), "# Lore\n").unwrap();
    std::fs::write(vault.path().join("Lore/Other.md"), "# Other\n").unwrap();
    std::fs::write(vault.path().join("Index.md"), "See [[Lore]].\n").unwrap();
    for dir in extra {
        std::fs::create_dir_all(vault.path().join(dir)).unwrap();
    }
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    (vault, cache, s)
}

fn pair(a: &str, b: &str) -> Option<(String, String)> {
    Some((a.to_string(), b.to_string()))
}

#[test]
fn r3b_renaming_a_folder_renames_its_page() {
    let (_dir, _c, s) = lore_session(&[]);
    let out = s.rename(&vp("Lore"), &vp("Myths"), true).unwrap();
    assert!(exists(&s, "Myths/Myths.md"));
    assert!(!exists(&s, "Myths/Lore.md"));
    assert!(exists(&s, "Myths/Other.md"));
    assert_eq!(out.pair, pair("Myths/Lore.md", "Myths/Myths.md"));
    assert!(
        read(&s, "Index.md").contains("[[Myths]]"),
        "{}",
        read(&s, "Index.md")
    );
}

#[test]
fn r3b_renaming_a_folder_page_renames_its_folder() {
    let (_dir, _c, s) = lore_session(&[]);
    let out = s
        .rename(&vp("Lore/Lore.md"), &vp("Lore/Myths.md"), true)
        .unwrap();
    assert!(exists(&s, "Myths/Myths.md"));
    assert!(exists(&s, "Myths/Other.md"));
    assert!(!exists(&s, "Lore"));
    assert_eq!(out.pair, pair("Lore", "Myths"));
    assert!(
        read(&s, "Index.md").contains("[[Myths]]"),
        "{}",
        read(&s, "Index.md")
    );
}

#[test]
fn r3b_a_taken_pair_name_refuses_the_whole_rename() {
    let (_dir, _c, s) = lore_session(&["Myths"]);
    let err = s
        .rename(&vp("Lore/Lore.md"), &vp("Lore/Myths.md"), true)
        .unwrap_err();
    assert!(
        matches!(
            err,
            SessionError::Vault(liber_vault::VaultError::AlreadyExists(_))
        ),
        "{err:?}"
    );
    assert!(exists(&s, "Lore/Lore.md"));
    assert!(!exists(&s, "Lore/Myths.md"));
}

#[test]
fn r3b_moving_a_page_into_its_namesake_folder_is_a_plain_move() {
    let (_dir, _c, s) = lore_session(&["Saga"]);
    s.create_page(&VaultPath::root(), "Saga").unwrap();
    let out = s.rename(&vp("Saga.md"), &vp("Saga/Saga.md"), true).unwrap();
    assert_eq!(out.pair, None);
    assert!(exists(&s, "Saga/Saga.md"));
}

#[test]
fn r3b_plain_renames_have_no_pair() {
    let (_dir, _c, s) = lore_session(&[]);
    let out = s
        .rename(&vp("Lore/Other.md"), &vp("Lore/Else.md"), true)
        .unwrap();
    assert_eq!(out.pair, None);
    assert!(exists(&s, "Lore/Lore.md"));
}

// Round 3b final review #1: the pair's second step is checked in post-move
// coordinates before anything moves.
#[test]
fn r3b_review_folder_renamed_onto_a_sibling_page_name_refuses_before_moving() {
    let (_dir, _c, s) = lore_session(&[]);
    // `Lore/Other.md` is where the paired page would land as `Other/Other.md`.
    let err = s.rename(&vp("Lore"), &vp("Other"), true).unwrap_err();
    assert!(
        matches!(
            err,
            SessionError::Vault(liber_vault::VaultError::AlreadyExists(_))
        ),
        "{err:?}"
    );
    assert!(exists(&s, "Lore/Lore.md"));
    assert!(exists(&s, "Lore/Other.md"));
    assert!(!exists(&s, "Other"));
    assert!(read(&s, "Index.md").contains("[[Lore]]"));
}

#[test]
fn r3b_review_a_folder_name_the_vault_refuses_stops_the_page_rename_too() {
    let (_dir, _c, s) = lore_session(&[]);
    let err = s.rename(&vp("Lore/Lore.md"), &vp("Lore/Myths .md"), true);
    assert!(err.is_err(), "{err:?}");
    assert!(exists(&s, "Lore/Lore.md"));
    assert!(!exists(&s, "Lore/Myths .md"));
}

// Round 3b final review #5: files rewritten by the first step are reported
// at the paths they have after the second.
#[test]
fn r3b_review_updated_files_are_reported_where_they_end_up() {
    let (_dir, _c, s) = vault_with(&[
        ("Lore/Lore.md", b"# Lore\n"),
        ("Lore/Other.md", b"# Other\n\nUp: [[Lore]]\n"),
    ]);
    let out = s
        .rename(&vp("Lore/Lore.md"), &vp("Lore/Myths.md"), true)
        .unwrap();
    assert!(!out.updated_files.is_empty());
    for f in &out.updated_files {
        assert!(exists(&s, f), "{f} is not on disk: {out:?}");
    }
    assert!(
        out.updated_files.contains(&"Myths/Other.md".to_string()),
        "{out:?}"
    );
    assert!(read(&s, "Myths/Other.md").contains("[[Myths]]"));
}

// Round 3b final review #6: a case-only pair rename is the same entry,
// whatever the letters (Unicode, not ASCII, case).
#[test]
fn r3b_review_case_only_pair_rename_with_an_accented_letter() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let vault = copy_fixture("obsidian-basic");
    std::fs::create_dir_all(vault.path().join("árbol")).unwrap();
    std::fs::write(vault.path().join("árbol/árbol.md"), "# árbol\n").unwrap();
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    s.rename(&vp("árbol/árbol.md"), &vp("árbol/Árbol.md"), true)
        .unwrap();
    let names: Vec<String> = std::fs::read_dir(vault.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().any(|n| n == "Árbol"), "{names:?}");
    let inner: Vec<String> = std::fs::read_dir(vault.path().join("Árbol"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(inner, vec!["Árbol.md".to_string()]);
}

fn names(dir: &tempfile::TempDir, rel: &str) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir.path().join(rel))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

/// Round 3 §9: `SmartJob/Smartjob.md` is its folder's page despite the case.
#[test]
fn subpages_case_variant_page_renames_with_its_folder() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[
        ("SmartJob/Smartjob.md", b"# S\n"),
        ("SmartJob/Teams.md", b""),
    ]);
    s.rename(&vp("SmartJob"), &vp("Work"), true).unwrap();
    assert_eq!(names(&dir, "Work"), vec!["Teams.md", "Work.md"]);
}

#[test]
fn subpages_renaming_a_case_variant_page_moves_its_folder() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[
        ("SmartJob/Smartjob.md", b"# S\n"),
        ("SmartJob/Teams.md", b""),
    ]);
    let out = s
        .rename(&vp("SmartJob/Smartjob.md"), &vp("SmartJob/Career.md"), true)
        .unwrap();
    assert_eq!(names(&dir, "Career"), vec!["Career.md", "Teams.md"]);
    assert!(out.pair.is_some());
}

/// "Match the page name to the folder": a case-only page rename that leaves
/// the folder where it is.
#[test]
fn subpages_matching_the_page_name_keeps_the_folder() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("SmartJob/Smartjob.md", b"# S\n")]);
    let out = s
        .rename(
            &vp("SmartJob/Smartjob.md"),
            &vp("SmartJob/SmartJob.md"),
            true,
        )
        .unwrap();
    assert_eq!(names(&dir, "."), vec!["SmartJob"]);
    assert_eq!(names(&dir, "SmartJob"), vec!["SmartJob.md"]);
    assert!(out.pair.is_none());
}

/// Add sub-page on a plain page: `P.md` becomes `P/P.md`, links follow.
#[test]
fn subpages_plain_page_becomes_its_folder_page() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[
        ("Notes/P.md", b"# P\n"),
        ("Other.md", b"See [p](Notes/P.md).\n"),
    ]);
    let (folder, page, _out) = s.make_folder_page(&vp("Notes/P.md"), true).unwrap();
    assert_eq!((folder, page), (vp("Notes/P"), vp("Notes/P/P.md")));
    assert_eq!(names(&dir, "Notes"), vec!["P"]);
    assert_eq!(names(&dir, "Notes/P"), vec!["P.md"]);
    assert_eq!(read(&s, "Other.md"), "See [p](Notes/P/P.md).\n");
}

#[test]
fn subpages_existing_folder_without_a_page_takes_it() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("P.md", b""), ("p/child.md", b"")]);
    let (folder, page, _) = s.make_folder_page(&vp("P.md"), true).unwrap();
    if case_insensitive(&dir) {
        assert_eq!((folder, page), (vp("p"), vp("p/p.md")));
        assert_eq!(names(&dir, "p"), vec!["child.md", "p.md"]);
    } else {
        // A different folder on a case-sensitive disk: the page gets its own.
        assert_eq!((folder, page), (vp("P"), vp("P/P.md")));
        assert_eq!(names(&dir, "p"), vec!["child.md"]);
    }
}

#[test]
fn subpages_refuses_and_moves_nothing() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    // The folder name is taken by a file.
    let (dir, _c, s) = vault_with(&[("P.md", b""), ("P", b"not a folder")]);
    assert!(s.make_folder_page(&vp("P.md"), true).is_err());
    assert_eq!(names(&dir, "."), vec!["P", "P.md"]);
    // The folder already has its own page.
    let (dir, _c, s) = vault_with(&[("Q.md", b""), ("Q/Q.md", b"")]);
    assert!(s.make_folder_page(&vp("Q.md"), true).is_err());
    assert_eq!(names(&dir, "."), vec!["Q", "Q.md"]);
    // It is already its folder's page.
    assert!(s.make_folder_page(&vp("Q/Q.md"), true).is_err());
    assert_eq!(names(&dir, "Q"), vec!["Q.md"]);
}

/// Whether this file system treats `X` and `x` as the same name.
fn case_insensitive(dir: &tempfile::TempDir) -> bool {
    let probe = dir.path().join(".case-probe");
    std::fs::write(&probe, "").unwrap();
    let same = dir.path().join(".CASE-PROBE").exists();
    std::fs::remove_file(probe).unwrap();
    same
}

fn in_tree(s: &VaultSession, path: &str) -> bool {
    s.tree().unwrap().iter().any(|n| n.path == path)
}

/// Review #1, input A: on a case-insensitive disk `projects/` *is* the
/// folder `Projects.md` would get, and `a.md` is already in it, so nothing
/// moves. A case-sensitive disk gets a separate `Projects/`.
#[test]
fn subpages_review_moving_into_the_folder_it_is_already_in_moves_nothing() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("Projects.md", b"# P\n"), ("projects/a.md", b"")]);
    let res = s.move_under_page(&vp("projects/a.md"), &vp("Projects.md"), true);
    if case_insensitive(&dir) {
        assert!(res.is_err());
        assert_eq!(names(&dir, "."), vec!["Projects.md", "projects"]);
        assert_eq!(names(&dir, "projects"), vec!["a.md"]);
    } else {
        res.unwrap();
        assert_eq!(names(&dir, "Projects"), vec!["Projects.md", "a.md"]);
        assert_eq!(names(&dir, "projects"), Vec::<String>::new());
    }
}

/// Review #1, input B: a name clash in the target folder refuses before
/// the page is converted.
#[test]
fn subpages_review_a_name_clash_refuses_before_the_page_moves() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("P.md", b"# P\n"), ("P/a.md", b"old"), ("Art/a.md", b"new")]);
    assert!(
        s.move_under_page(&vp("Art/a.md"), &vp("P.md"), true)
            .is_err()
    );
    assert_eq!(names(&dir, "."), vec!["Art", "P", "P.md"]);
    assert_eq!(read(&s, "P/a.md"), "old");
    assert_eq!(read(&s, "Art/a.md"), "new");
}

/// Review #1: a folder can't go under its own namesake page when the disk
/// treats the two names as one folder.
#[test]
fn subpages_review_a_folder_onto_its_own_case_variant_page() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("P.md", b"# P\n"), ("p/c.md", b"")]);
    let res = s.move_under_page(&vp("p"), &vp("P.md"), true);
    if case_insensitive(&dir) {
        assert!(res.is_err());
        assert_eq!(names(&dir, "."), vec!["P.md", "p"]);
    } else {
        res.unwrap();
        assert_eq!(names(&dir, "P"), vec!["P.md", "p"]);
    }
}

/// Review #1: when the move itself fails after the conversion, the page
/// goes back where it was and the new folder disappears (disk and index).
#[test]
fn subpages_review_a_failed_move_rolls_the_conversion_back() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("P.md", b"# P\n")]);
    // On disk but not indexed: the move refuses only after the conversion.
    std::fs::write(dir.path().join("late.md"), "").unwrap();
    assert!(
        s.move_under_page(&vp("late.md"), &vp("P.md"), true)
            .is_err()
    );
    assert_eq!(names(&dir, "."), vec!["P.md", "late.md"]);
    assert!(in_tree(&s, "P.md"));
    assert!(!in_tree(&s, "P"));
}

#[test]
fn subpages_review_move_under_page_moves_and_rewrites() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[
        ("P.md", b"# P\n"),
        ("Notes/a.md", b"# A\n"),
        ("Other.md", b"See [a](Notes/a.md).\n"),
    ]);
    let out = s
        .move_under_page(&vp("Notes/a.md"), &vp("P.md"), true)
        .unwrap();
    assert_eq!(out.folder, vp("P"));
    assert_eq!(out.page, vp("P/P.md"));
    assert!(out.converted.is_some());
    assert_eq!(names(&dir, "P"), vec!["P.md", "a.md"]);
    assert_eq!(read(&s, "Other.md"), "See [a](P/a.md).\n");
    // A second move under the same (now folder) page converts nothing.
    std::fs::write(dir.path().join("Notes/b.md"), "").unwrap();
    s.apply(vec![liber_vault::WatchEvent::Overflow]).unwrap();
    let out = s
        .move_under_page(&vp("Notes/b.md"), &vp("P/P.md"), true)
        .unwrap();
    assert!(out.converted.is_none());
    assert_eq!(names(&dir, "P"), vec!["P.md", "a.md", "b.md"]);
}

/// Review #2 (spec §9.2): a folder the command had just created is removed
/// again, from disk and from the index, when the page can't move.
#[test]
fn subpages_review_a_created_folder_is_removed_again() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("Keep.md", b"")]);
    std::fs::write(dir.path().join("Late.md"), "").unwrap(); // not indexed
    assert!(s.make_folder_page(&vp("Late.md"), true).is_err());
    assert_eq!(names(&dir, "."), vec!["Keep.md", "Late.md"]);
    assert!(!in_tree(&s, "Late"));
}

/// Review #2: a page under a hidden folder is refused before anything is made.
#[test]
fn subpages_review_hidden_parents_are_refused_first() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[(".trash/x.md", b"")]);
    assert!(s.make_folder_page(&vp(".trash/x.md"), true).is_err());
    assert_eq!(names(&dir, ".trash"), vec!["x.md"]);
}

/// Review #5: `.MD` is a page too, and keeps its own extension.
#[test]
fn subpages_review_upper_case_md_is_a_page() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, _c, s) = vault_with(&[("Notes.MD", b"# N\n")]);
    let (_f, page, _) = s.make_folder_page(&vp("Notes.MD"), true).unwrap();
    assert_eq!(page, vp("Notes/Notes.MD"));
    assert_eq!(names(&dir, "Notes"), vec!["Notes.MD"]);
}

/// Review #8: links *from* the converted page follow its new folder.
#[test]
fn subpages_review_links_from_the_converted_page_follow() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (_dir, _c, s) = vault_with(&[("P.md", b"See [o](Other.md).\n"), ("Other.md", b"")]);
    s.make_folder_page(&vp("P.md"), true).unwrap();
    assert_eq!(read(&s, "P/P.md"), "See [o](../Other.md).\n");
}

/// Review #8: on a case-sensitive disk (Linux CI only) `X/X.md` and
/// `X/x.md` are two pages; renaming the variant leaves the folder alone.
#[test]
fn subpages_review_two_distinct_case_variants_stay_apart() {
    let (dir, _c, s) = vault_with(&[("X/X.md", b"# X\n")]);
    if case_insensitive(&dir) {
        return; // runs on case-sensitive file systems (Linux CI)
    }
    std::fs::write(dir.path().join("X/x.md"), "").unwrap();
    s.apply(vec![liber_vault::WatchEvent::Overflow]).unwrap();
    s.rename(&vp("X/x.md"), &vp("X/y.md"), true).unwrap();
    assert_eq!(names(&dir, "."), vec!["X"]);
    assert_eq!(names(&dir, "X"), vec!["X.md", "y.md"]);
}
