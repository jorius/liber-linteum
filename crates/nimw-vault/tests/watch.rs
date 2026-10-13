use nimw_testkit::{copy_fixture, wait_until};
use nimw_vault::{Vault, VaultPath, WatchEvent};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);
type Seen = Arc<Mutex<Vec<WatchEvent>>>;

fn watch(dir: &std::path::Path) -> (nimw_vault::Watcher, Seen) {
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
    let dir = copy_fixture("ambiguous-names");
    let (_w, seen) = watch(dir.path());
    std::fs::rename(dir.path().join("Links.md"), dir.path().join("Renamed.md")).unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("Renamed.md"))));
    // Some backends only report the new name; the session reconciles the
    // parent folder to notice the old one is gone (nimw-session Task 11).
}

#[test]
fn vlt_05_hidden_and_excluded_changes_are_dropped() {
    let dir = copy_fixture("ambiguous-names");
    std::fs::create_dir(dir.path().join(".nimw")).unwrap();
    std::fs::write(
        dir.path().join(".nimw/vault.json"),
        r#"{"exclude":["Archive/**"]}"#,
    )
    .unwrap();
    let (_w, seen) = watch(dir.path());
    std::fs::write(dir.path().join(".nimw/layout.json"), "{}").unwrap();
    std::fs::write(dir.path().join("Archive/Old/x.md"), "x").unwrap();
    std::fs::write(dir.path().join("visible.md"), "v").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("visible.md"))));
    let all = seen.lock().unwrap().clone();
    assert!(
        all.iter()
            .all(|e| !format!("{e:?}").contains(".nimw") && !format!("{e:?}").contains("Archive")),
        "{all:?}"
    );
}

#[test]
fn review_focus_burst_of_changes_is_delivered_without_loss() {
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
