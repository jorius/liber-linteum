use nimw_session::{SessionEvent, VaultSession};
use nimw_testkit::{copy_fixture, wait_until};
use nimw_vault::{CoverSide, PageWidth, VaultPath, WatchEvent};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Events = Arc<Mutex<Vec<SessionEvent>>>;
const WAIT: Duration = Duration::from_secs(5);

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn watched(
    fixture: &str,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    Arc<VaultSession>,
    Events,
) {
    let vault = copy_fixture(fixture);
    let cache = tempfile::tempdir().unwrap();
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), move |e| {
        sink.lock().unwrap().push(e)
    })
    .unwrap();
    let s = Arc::new(s);
    s.start_watching().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    events.lock().unwrap().clear();
    (vault, cache, s, events)
}

fn changed(events: &Events) -> Vec<SessionEvent> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, SessionEvent::Changed { .. }))
        .cloned()
        .collect()
}

#[test]
fn vlt_04_external_create_modify_delete_update_the_index() {
    let (dir, _c, s, events) = watched("obsidian-basic");
    std::fs::write(
        dir.path().join("Character Design/Generator Rex.md"),
        "# Generator Rex 2\n",
    )
    .unwrap();
    assert!(wait_until(WAIT, || s
        .page(&vp("Character Design/Generator Rex.md"))
        .unwrap()
        .is_some()));
    assert!(
        wait_until(WAIT, || {
            s.page(&vp("Character Design/My characters.md"))
                .unwrap()
                .unwrap()
                .links[1]
                .target_path
                .as_deref()
                == Some("Character Design/Generator Rex.md")
        }),
        "waiting link resolved"
    );
    std::fs::write(dir.path().join("Welcome.md"), "# Hello again\n").unwrap();
    assert!(wait_until(WAIT, || s
        .page(&vp("Welcome.md"))
        .unwrap()
        .unwrap()
        .title
        == "Hello again"));
    std::fs::remove_file(dir.path().join("Game Design/notes.txt")).unwrap();
    assert!(wait_until(WAIT, || !s
        .tree()
        .unwrap()
        .iter()
        .any(|n| n.path == "Game Design/notes.txt")));
    let all = changed(&events);
    let flat = format!("{all:?}");
    assert!(
        flat.contains("Generator Rex.md")
            && flat.contains("Welcome.md")
            && flat.contains("notes.txt"),
        "{flat}"
    );
}

#[test]
fn vlt_04_external_rename_moves_rows_without_rewriting_links() {
    let (dir, _c, s, events) = watched("obsidian-basic");
    let before = std::fs::read_to_string(dir.path().join("Character Design/rex-draft.md")).unwrap();
    std::fs::rename(
        dir.path().join("Game Design/Game 1.md"),
        dir.path().join("Game Design/Game One.md"),
    )
    .unwrap();
    assert!(wait_until(WAIT, || s
        .page(&vp("Game Design/Game One.md"))
        .unwrap()
        .is_some()));
    assert!(
        wait_until(WAIT, || s
            .page(&vp("Game Design/Game 1.md"))
            .unwrap()
            .is_none()),
        "old name noticed"
    );
    assert!(wait_until(WAIT, || format!("{:?}", changed(&events))
        .contains(
            "(\"Game Design/Game 1.md\", \"Game Design/Game One.md\")"
        )));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Character Design/rex-draft.md")).unwrap(),
        before
    );
    assert!(
        s.backlinks(&vp("Game Design/Game One.md"))
            .unwrap()
            .is_empty(),
        "links now unresolved, like Obsidian"
    );
}

#[test]
fn vlt_04_own_writes_are_not_reported_as_external_changes() {
    let (_dir, _c, s, events) = watched("obsidian-basic");
    s.create_page(&VaultPath::root(), "Fresh").unwrap();
    s.rename(
        &vp("Character Design/DMC/Sparda.md"),
        &vp("Character Design/DMC/Sparda2.md"),
        true,
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(changed(&events), Vec::new());
}

#[test]
fn vlt_04_overflow_triggers_full_rescan() {
    let vault = copy_fixture("ambiguous-names");
    let cache = tempfile::tempdir().unwrap();
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), move |e| {
        sink.lock().unwrap().push(e)
    })
    .unwrap();
    std::fs::write(vault.path().join("Unseen.md"), "# unseen").unwrap();
    s.apply(vec![WatchEvent::Overflow]).unwrap();
    assert!(s.page(&vp("Unseen.md")).unwrap().is_some());
    assert!(format!("{:?}", changed(&events)).contains("Unseen.md"));
}

#[test]
fn review_focus_git_checkout_like_burst_converges() {
    let (dir, _c, s, _events) = watched("ambiguous-names");
    std::fs::create_dir(dir.path().join("Imported")).unwrap();
    for i in 0..300 {
        std::fs::write(
            dir.path().join(format!("Imported/n{i}.md")),
            format!("# N{i}\n\n[[Ideas]]"),
        )
        .unwrap();
    }
    std::fs::remove_dir_all(dir.path().join("Archive")).unwrap();
    std::fs::rename(
        dir.path().join("Links.md"),
        dir.path().join("Imported/Links.md"),
    )
    .unwrap();
    let expected = s.vault().scan().unwrap().entries.len();
    assert!(
        wait_until(Duration::from_secs(15), || s.tree().unwrap().len()
            == expected),
        "index converges to disk"
    );
    assert!(s.page(&vp("Imported/n299.md")).unwrap().is_some());
    assert!(s.page(&vp("Archive/Old/Ideas.md")).unwrap().is_none());
    assert_eq!(s.backlinks(&vp("Ideas.md")).unwrap().len(), 300 + 1 + 1);
}

/// A session over a fresh vault, NOT watching: tests drive `apply` directly so
/// they don't depend on watcher timing.
fn unwatched(files: &[(&str, &str)]) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
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

fn target_of(s: &VaultSession, page: &str) -> Option<String> {
    s.page(&vp(page)).unwrap().unwrap().links[0]
        .target_path
        .clone()
}

/// Final review I4: a change reported only on an already-indexed folder (how
/// FSEvents asks for a folder rescan) reconciles that folder's subtree.
#[test]
fn vlt_04_change_on_indexed_folder_reconciles_its_subtree() {
    let (dir, _c, s) = unwatched(&[("F/a.md", "# a"), ("F/Sub/old.md", "# old")]);
    std::fs::write(dir.path().join("F/b.md"), "# b").unwrap();
    std::fs::remove_file(dir.path().join("F/Sub/old.md")).unwrap();
    std::fs::write(dir.path().join("F/Sub/new.md"), "# new").unwrap();
    s.apply(vec![WatchEvent::Changed(vp("F"))]).unwrap();
    assert!(s.page(&vp("F/b.md")).unwrap().is_some());
    assert!(s.page(&vp("F/Sub/new.md")).unwrap().is_some());
    assert!(s.page(&vp("F/Sub/old.md")).unwrap().is_none());
}

/// Final review I5: removing a whole folder in one event re-resolves links to
/// every file that was inside it, so they can move to another candidate.
#[test]
fn vlt_04_removed_folder_re_resolves_links_to_its_contents() {
    let (dir, _c, s) = unwatched(&[
        ("Projects/Note.md", "[[Plan]]"),
        ("Archive/Plan.md", "# archived plan"),
        ("Projects/Sub/Plan.md", "# current plan"),
    ]);
    assert_eq!(
        target_of(&s, "Projects/Note.md").as_deref(),
        Some("Archive/Plan.md")
    );
    let outside = tempfile::tempdir().unwrap();
    std::fs::rename(dir.path().join("Archive"), outside.path().join("Archive")).unwrap();
    s.apply(vec![WatchEvent::Removed(vp("Archive"))]).unwrap();
    assert_eq!(
        target_of(&s, "Projects/Note.md").as_deref(),
        Some("Projects/Sub/Plan.md")
    );
}

/// Final review I3: an unreadable new folder doesn't drop the rest of the batch.
#[cfg(unix)]
#[test]
fn vlt_04_unreadable_new_folder_does_not_drop_the_batch() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, _c, s) = unwatched(&[("a.md", "# a")]);
    let locked = dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("x.md"), "# x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    std::fs::write(dir.path().join("b.md"), "# b").unwrap();
    let result = s.apply(vec![
        WatchEvent::Changed(vp("b.md")),
        WatchEvent::Changed(vp("locked")),
    ]);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    result.unwrap();
    assert!(s.page(&vp("b.md")).unwrap().is_some());
}

/// M1b (M1a hand-off §11 o): warnings found while applying watcher events are
/// their own event, not an `Indexed` report with zero files.
#[test]
fn vlt_04_watcher_warnings_are_warning_events() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("a.md"), "# a").unwrap();
    let cache = tempfile::tempdir().unwrap();
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), move |e| {
        sink.lock().unwrap().push(e)
    })
    .unwrap();
    events.lock().unwrap().clear();
    std::fs::write(vault.path().join("bad.md"), [0xff, 0xfe, b'x']).unwrap();
    s.apply(vec![WatchEvent::Changed(vp("bad.md"))]).unwrap();
    let got = events.lock().unwrap().clone();
    assert!(
        got.iter()
            .any(|e| matches!(e, SessionEvent::Warning(m) if m.contains("bad.md"))),
        "{got:?}"
    );
    assert!(
        !got.iter().any(|e| matches!(e, SessionEvent::Indexed(_))),
        "{got:?}"
    );
}

/// Final review M10: pages deleted outside the app (one by one, or with their
/// folder) take their width with them; a rename by another program keeps it.
#[test]
fn m4b2_pages_deleted_outside_forget_their_width() {
    let (dir, _c, s) = unwatched(&[
        ("A.md", "# a"),
        ("F/B.md", "# b"),
        ("Kept.md", "# kept"),
        ("Moved.md", "# moved"),
    ]);
    for page in ["A.md", "F/B.md", "Kept.md", "Moved.md"] {
        s.vault()
            .set_page_width(page, Some(PageWidth::Full))
            .unwrap();
    }
    std::fs::remove_file(dir.path().join("A.md")).unwrap();
    std::fs::remove_dir_all(dir.path().join("F")).unwrap();
    std::fs::rename(dir.path().join("Moved.md"), dir.path().join("Renamed.md")).unwrap();
    s.apply(vec![
        WatchEvent::Removed(vp("A.md")),
        WatchEvent::Removed(vp("F")),
        WatchEvent::Removed(vp("Moved.md")),
        WatchEvent::Changed(vp("Renamed.md")),
    ])
    .unwrap();
    let pages: Vec<String> = s.vault().page_widths().pages.into_keys().collect();
    assert_eq!(pages, ["Kept.md", "Renamed.md"]);
}

/// Cover resize: pages deleted outside the app (one by one, or with their
/// folder) take their cover height with them; a rename by another program
/// keeps it, at the new path.
#[test]
fn cover_heights_of_pages_deleted_outside_are_forgotten_renames_keep_them() {
    let (dir, _c, s) = unwatched(&[
        ("A.md", "# a"),
        ("F/B.md", "# b"),
        ("Kept.md", "# kept"),
        ("Moved.md", "# moved"),
    ]);
    for page in ["A.md", "F/B.md", "Kept.md", "Moved.md"] {
        s.vault().set_cover_height(page, Some(300)).unwrap();
    }
    std::fs::remove_file(dir.path().join("A.md")).unwrap();
    std::fs::remove_dir_all(dir.path().join("F")).unwrap();
    std::fs::rename(dir.path().join("Moved.md"), dir.path().join("Renamed.md")).unwrap();
    s.apply(vec![
        WatchEvent::Removed(vp("A.md")),
        WatchEvent::Removed(vp("F")),
        WatchEvent::Removed(vp("Moved.md")),
        WatchEvent::Changed(vp("Renamed.md")),
    ])
    .unwrap();
    let heights: Vec<(String, u32)> = s.vault().cover_heights().into_iter().collect();
    assert_eq!(
        heights,
        [
            ("Kept.md".to_string(), 300),
            ("Renamed.md".to_string(), 300)
        ]
    );
}

/// M4b part 3 §3: pages deleted outside the app take their cover placement
/// and strip width with them; a rename by another program keeps them.
#[test]
fn cover_sides_and_widths_of_pages_deleted_outside_are_forgotten() {
    let (dir, _c, s) = unwatched(&[("A.md", "# a"), ("Kept.md", "# kept"), ("Moved.md", "# m")]);
    for page in ["A.md", "Kept.md", "Moved.md"] {
        s.vault().set_cover_side(page, CoverSide::Left).unwrap();
        s.vault().set_cover_width(page, Some(300)).unwrap();
    }
    std::fs::remove_file(dir.path().join("A.md")).unwrap();
    std::fs::rename(dir.path().join("Moved.md"), dir.path().join("Renamed.md")).unwrap();
    s.apply(vec![
        WatchEvent::Removed(vp("A.md")),
        WatchEvent::Removed(vp("Moved.md")),
        WatchEvent::Changed(vp("Renamed.md")),
    ])
    .unwrap();
    let kept = ["Kept.md".to_string(), "Renamed.md".to_string()];
    assert_eq!(
        s.vault().cover_sides().into_keys().collect::<Vec<_>>(),
        kept
    );
    assert_eq!(
        s.vault().cover_widths().into_keys().collect::<Vec<_>>(),
        kept
    );
}

/// M5b §4: a folder deleted outside the app takes its icon, and its
/// subfolders', with it.
#[test]
fn m5b_folder_icons_of_folders_deleted_outside_are_forgotten() {
    let (dir, _c, s) = unwatched(&[("Lore/A.md", "# a"), ("Kept/B.md", "# b")]);
    s.vault().set_folder_icon("Lore", Some("🐉")).unwrap();
    s.vault().set_folder_icon("Kept", Some("📌")).unwrap();
    std::fs::remove_dir_all(dir.path().join("Lore")).unwrap();
    s.apply(vec![WatchEvent::Removed(vp("Lore"))]).unwrap();
    assert_eq!(
        s.vault().folder_icons().into_keys().collect::<Vec<_>>(),
        vec!["Kept".to_string()]
    );
}

/// Batch 6: a text file changed outside the app is found by its new words.
#[test]
fn b6_an_outside_edit_to_a_text_file_reaches_search() {
    let (dir, _c, s, _events) = watched("obsidian-basic");
    std::fs::write(dir.path().join("Game Design/notes.txt"), "labradorite\n").unwrap();
    let find = |w: &str| {
        s.search(&nimw_session::SearchQuery {
            text: w.into(),
            ..Default::default()
        })
        .unwrap()
        .results
        .into_iter()
        .map(|h| h.path)
        .collect::<Vec<_>>()
    };
    assert!(wait_until(WAIT, || find("labradorite")
        == vec!["Game Design/notes.txt"]));
}

/// Batch 6 review M1: the same through the watcher (a rename made outside).
#[test]
fn b6_review_m1_an_outside_rename_rechecks_whether_a_file_is_text() {
    let (dir, _c, s, _events) = watched("obsidian-basic");
    let find = |w: &str| {
        s.search(&nimw_session::SearchQuery {
            text: w.into(),
            ..Default::default()
        })
        .unwrap()
        .results
        .into_iter()
        .map(|h| h.path)
        .collect::<Vec<_>>()
    };
    std::fs::write(dir.path().join("Game Design/notes.txt"), "labradorite\n").unwrap();
    assert!(wait_until(WAIT, || find("labradorite")
        == vec!["Game Design/notes.txt"]));
    std::fs::rename(
        dir.path().join("Game Design/notes.txt"),
        dir.path().join("Game Design/notes.pdf"),
    )
    .unwrap();
    assert!(wait_until(WAIT, || find("labradorite").is_empty()));
}
