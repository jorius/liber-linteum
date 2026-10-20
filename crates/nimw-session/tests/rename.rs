use nimw_session::{SessionError, SessionEvent, VaultSession};
use nimw_testkit::{copy_fixture, snapshot};
use nimw_vault::{CoverSide, VaultPath};

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
    let (dir, _c, s) = vault_with(&[
        ("x.png", b"png"),
        ("A.md", b"# A\n"),
        ("p.md", b"[![alt](x.png)](x.png)\n"),
        ("q.md", b"---\n\nrelated:\n  - \"[[A]]\"\n---\n# Q\n"),
    ]);
    let out = s.rename(&vp("x.png"), &vp("new name.png"), true).unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(
        read(&dir, "p.md"),
        "[![alt](new%20name.png)](new%20name.png)\n"
    );
    let out = s.rename(&vp("A.md"), &vp("Longer Name.md"), true).unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(
        read(&dir, "q.md"),
        "---\n\nrelated:\n  - \"[[Longer Name]]\"\n---\n# Q\n"
    );
}

/// Final review I1: names that cannot be linked to are refused up front.
#[test]
fn exp_02_names_that_would_break_links_are_rejected() {
    let (dir, _c, s) = vault_with(&[("A.md", b"# A\n"), ("p.md", b"[[A]]\n")]);
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
    assert_eq!(read(&dir, "p.md"), "[[A]]\n");
}

/// Final review I1: an existing folder whose name needs escaping in a Markdown
/// destination gets %-encoded, so the link keeps pointing at the file.
#[test]
fn exp_04_markdown_destination_into_hash_folder_is_encoded() {
    let (dir, _c, s) = vault_with(&[
        ("A.md", b"# A\n"),
        ("C#/keep.md", b"x\n"),
        ("p.md", b"[a](A.md)\n"),
    ]);
    let out = s.rename(&vp("A.md"), &vp("C#/A.md"), true).unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(read(&dir, "p.md"), "[a](C%23/A.md)\n");
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
    let (dir, _c, s) = vault_with(&[
        ("A.md", b"# A\n"),
        ("B/A.md", b"# other A\n"),
        ("C#/keep.md", b"x\n"),
        ("Q/p.md", b"[[A]]\n"),
    ]);
    let out = s.rename(&vp("A.md"), &vp("C#/A.md"), true).unwrap();
    assert_eq!(read(&dir, "Q/p.md"), "[[A]]\n");
    assert_eq!(out.failed.len(), 1, "{out:?}");
    assert_eq!(out.failed[0].0, "Q/p.md");
}

/// Final review (M1, re-graded Important): a symlinked note is never replaced
/// by a plain file; its link edits happen through the real file.
#[cfg(unix)]
#[test]
fn exp_04_symlinked_notes_stay_symlinks() {
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
    assert_eq!(read(&dir, "real.md"), "[[B]]\n");
    assert_eq!(read(&dir, "alias.md"), "[[B]]\n");
}

/// Cover resize: a page's cover height (`.nimw/vault.json` `coverHeights`)
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
        read(&vault, ".archive/Old notes.md"),
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
    let (dir, _c, s) = lore_session(&[]);
    let out = s.rename(&vp("Lore"), &vp("Myths"), true).unwrap();
    assert!(dir.path().join("Myths/Myths.md").exists());
    assert!(!dir.path().join("Myths/Lore.md").exists());
    assert!(dir.path().join("Myths/Other.md").exists());
    assert_eq!(out.pair, pair("Myths/Lore.md", "Myths/Myths.md"));
    assert!(
        read(&dir, "Index.md").contains("[[Myths]]"),
        "{}",
        read(&dir, "Index.md")
    );
}

#[test]
fn r3b_renaming_a_folder_page_renames_its_folder() {
    let (dir, _c, s) = lore_session(&[]);
    let out = s
        .rename(&vp("Lore/Lore.md"), &vp("Lore/Myths.md"), true)
        .unwrap();
    assert!(dir.path().join("Myths/Myths.md").exists());
    assert!(dir.path().join("Myths/Other.md").exists());
    assert!(!dir.path().join("Lore").exists());
    assert_eq!(out.pair, pair("Lore", "Myths"));
    assert!(
        read(&dir, "Index.md").contains("[[Myths]]"),
        "{}",
        read(&dir, "Index.md")
    );
}

#[test]
fn r3b_a_taken_pair_name_refuses_the_whole_rename() {
    let (dir, _c, s) = lore_session(&["Myths"]);
    let err = s
        .rename(&vp("Lore/Lore.md"), &vp("Lore/Myths.md"), true)
        .unwrap_err();
    assert!(
        matches!(
            err,
            SessionError::Vault(nimw_vault::VaultError::AlreadyExists(_))
        ),
        "{err:?}"
    );
    assert!(dir.path().join("Lore/Lore.md").exists());
    assert!(!dir.path().join("Lore/Myths.md").exists());
}

#[test]
fn r3b_moving_a_page_into_its_namesake_folder_is_a_plain_move() {
    let (dir, _c, s) = lore_session(&["Saga"]);
    s.create_page(&VaultPath::root(), "Saga").unwrap();
    let out = s.rename(&vp("Saga.md"), &vp("Saga/Saga.md"), true).unwrap();
    assert_eq!(out.pair, None);
    assert!(dir.path().join("Saga/Saga.md").exists());
}

#[test]
fn r3b_plain_renames_have_no_pair() {
    let (dir, _c, s) = lore_session(&[]);
    let out = s
        .rename(&vp("Lore/Other.md"), &vp("Lore/Else.md"), true)
        .unwrap();
    assert_eq!(out.pair, None);
    assert!(dir.path().join("Lore/Lore.md").exists());
}

// Round 3b final review #1: the pair's second step is checked in post-move
// coordinates before anything moves.
#[test]
fn r3b_review_folder_renamed_onto_a_sibling_page_name_refuses_before_moving() {
    let (dir, _c, s) = lore_session(&[]);
    // `Lore/Other.md` is where the paired page would land as `Other/Other.md`.
    let err = s.rename(&vp("Lore"), &vp("Other"), true).unwrap_err();
    assert!(
        matches!(
            err,
            SessionError::Vault(nimw_vault::VaultError::AlreadyExists(_))
        ),
        "{err:?}"
    );
    assert!(dir.path().join("Lore/Lore.md").exists());
    assert!(dir.path().join("Lore/Other.md").exists());
    assert!(!dir.path().join("Other").exists());
    assert!(read(&dir, "Index.md").contains("[[Lore]]"));
}

#[test]
fn r3b_review_a_folder_name_the_vault_refuses_stops_the_page_rename_too() {
    let (dir, _c, s) = lore_session(&[]);
    let err = s.rename(&vp("Lore/Lore.md"), &vp("Lore/Myths .md"), true);
    assert!(err.is_err(), "{err:?}");
    assert!(dir.path().join("Lore/Lore.md").exists());
    assert!(!dir.path().join("Lore/Myths .md").exists());
}

// Round 3b final review #5: files rewritten by the first step are reported
// at the paths they have after the second.
#[test]
fn r3b_review_updated_files_are_reported_where_they_end_up() {
    let (dir, _c, s) = vault_with(&[
        ("Lore/Lore.md", b"# Lore\n"),
        ("Lore/Other.md", b"# Other\n\nUp: [[Lore]]\n"),
    ]);
    let out = s
        .rename(&vp("Lore/Lore.md"), &vp("Lore/Myths.md"), true)
        .unwrap();
    assert!(!out.updated_files.is_empty());
    for f in &out.updated_files {
        assert!(dir.path().join(f).exists(), "{f} is not on disk: {out:?}");
    }
    assert!(
        out.updated_files.contains(&"Myths/Other.md".to_string()),
        "{out:?}"
    );
    assert!(read(&dir, "Myths/Other.md").contains("[[Myths]]"));
}

// Round 3b final review #6: a case-only pair rename is the same entry,
// whatever the letters (Unicode, not ASCII, case).
#[test]
fn r3b_review_case_only_pair_rename_with_an_accented_letter() {
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
