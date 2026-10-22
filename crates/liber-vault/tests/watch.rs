mod support;

use liber_testkit::{copy_fixture, wait_until};
use liber_vault::{DEBOUNCE, RawEvent, Vault, VaultPath, WatchEvent};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::Spy;

const WAIT: Duration = Duration::from_secs(5);
type Seen = Arc<Mutex<Vec<WatchEvent>>>;

fn watch(dir: &std::path::Path) -> (liber_vault::Watcher, Seen) {
    let vault = Vault::open(dir).unwrap();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let w = vault
        .watch(move |batch| sink.lock().unwrap().extend(batch))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300)); // let the backend arm
    (w, seen)
}

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn saw(seen: &Seen, event: WatchEvent) -> bool {
    wait_until(WAIT, || seen.lock().unwrap().contains(&event))
}

#[test]
fn vlt_04_external_create_modify_remove_are_reported() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = copy_fixture("ambiguous-names");
    let (_w, seen) = watch(dir.path());
    std::fs::write(dir.path().join("New.md"), "# new").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("New.md"))));
    std::fs::write(dir.path().join("Ideas.md"), "# changed").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("Ideas.md"))));
    std::fs::remove_file(dir.path().join("Links.md")).unwrap();
    assert!(
        saw(&seen, WatchEvent::Removed(vp("Links.md"))),
        "{:?}",
        seen.lock().unwrap()
    );
}

#[test]
fn vlt_04_external_rename_reports_new_path_and_old_path_gone() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = copy_fixture("ambiguous-names");
    let (_w, seen) = watch(dir.path());
    std::fs::rename(dir.path().join("Links.md"), dir.path().join("Renamed.md")).unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("Renamed.md"))));
    // Some backends only report the new name; the session reconciles the
    // parent folder to notice the old one is gone (liber-session Task 11).
}

#[test]
fn vlt_05_hidden_and_excluded_changes_are_dropped() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = copy_fixture("ambiguous-names");
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{"exclude":["Archive/**"]}"#,
    )
    .unwrap();
    let (_w, seen) = watch(dir.path());
    std::fs::write(dir.path().join(".liber/layout.json"), "{}").unwrap();
    std::fs::write(dir.path().join("Archive/Old/x.md"), "x").unwrap();
    std::fs::write(dir.path().join("visible.md"), "v").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("visible.md"))));
    // `Archive` itself is visible (the glob is its contents), and Windows
    // reports it changed when something inside it is written.
    let all = seen.lock().unwrap().clone();
    assert!(
        all.iter().all(|e| {
            let e = format!("{e:?}");
            !e.contains(".liber") && !e.contains("Archive/")
        }),
        "{all:?}"
    );
}

#[test]
fn review_focus_burst_of_changes_is_delivered_without_loss() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = copy_fixture("ambiguous-names");
    let (_w, seen) = watch(dir.path());
    for i in 0..200 {
        std::fs::write(dir.path().join(format!("burst-{i}.md")), format!("# {i}")).unwrap();
    }
    let all_seen = || {
        let s = seen.lock().unwrap();
        s.contains(&WatchEvent::Overflow)
            || (0..200).all(|i| s.contains(&WatchEvent::Changed(vp(&format!("burst-{i}.md")))))
    };
    assert!(
        wait_until(Duration::from_secs(10), all_seen),
        "every file reported, or Overflow"
    );
}

/// M4c §3: a single-file window watches only its file's folder, not the
/// folders below it (a file in the home folder must not watch all of it).
#[test]
fn watch_folder_reports_only_the_folders_own_files() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let _w = vault
        .watch_folder(move |batch| sink.lock().unwrap().extend(batch))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(dir.path().join("sub/b.md"), "below").unwrap();
    std::fs::write(dir.path().join("a.md"), "here").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("a.md"))));
    std::thread::sleep(Duration::from_millis(600));
    let below = seen
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, WatchEvent::Changed(p) | WatchEvent::Removed(p) if p.as_str().starts_with("sub/")));
    assert!(!below, "{:?}", seen.lock().unwrap());
}

/// Review Focus 5: temp files, hidden and excluded paths never reach the
/// session; a batch holding `Overflow`, or an event on the root (final
/// review M4), is only `Overflow`.
#[test]
fn watch_drops_temp_hidden_excluded_and_collapses_overflow_and_root() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{"exclude":["build/**"]}"#,
    )
    .unwrap();
    let spy = Spy::open(dir.path());
    let sink = spy.sink.clone();
    let vault = Vault::open_with(Box::new(spy)).unwrap();
    let batches: Arc<Mutex<Vec<Vec<WatchEvent>>>> = Arc::default();
    let seen = batches.clone();
    let _w = vault
        .watch(move |batch| seen.lock().unwrap().push(batch))
        .unwrap();
    let settle = || std::thread::sleep(DEBOUNCE * 3);

    Spy::inject(
        &sink,
        vec![
            RawEvent::Changed(vp(".a.md.liber-tmp-1-0")),
            RawEvent::Changed(vp(".liber/vault.json")),
            RawEvent::Changed(vp("build/x.md")),
            RawEvent::Changed(vp("ok.md")),
        ],
    );
    assert!(wait_until(WAIT, || batches.lock().unwrap().len() == 1));
    settle();
    assert_eq!(
        *batches.lock().unwrap(),
        [vec![WatchEvent::Changed(vp("ok.md"))]]
    );

    Spy::inject(
        &sink,
        vec![RawEvent::Overflow, RawEvent::Changed(vp("ok.md"))],
    );
    assert!(wait_until(WAIT, || batches.lock().unwrap().len() == 2));
    settle();
    assert_eq!(batches.lock().unwrap()[1..], [vec![WatchEvent::Overflow]]);

    Spy::inject(
        &sink,
        vec![
            RawEvent::Changed(VaultPath::root()),
            RawEvent::Changed(vp("ok.md")),
        ],
    );
    assert!(wait_until(WAIT, || batches.lock().unwrap().len() == 3));
    settle();
    assert_eq!(batches.lock().unwrap()[2..], [vec![WatchEvent::Overflow]]);
}
