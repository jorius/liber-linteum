use nimw_session::{SessionEvent, VaultSession};
use nimw_testkit::{copy_fixture, wait_until};
use nimw_vault::{VaultPath, WatchEvent};
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
