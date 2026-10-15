//! M5: search through an open vault, and the NFR-03 budget.

use nimw_session::{SearchQuery, SessionEvent, VaultSession};
use nimw_vault::VaultPath;
use std::path::Path;
use std::time::{Duration, Instant};

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn open(dir: &Path) -> (tempfile::TempDir, VaultSession) {
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(dir, cache.path(), |_: SessionEvent| {}).unwrap();
    (cache, s)
}

fn find(s: &VaultSession, text: &str) -> Vec<String> {
    let q = SearchQuery {
        text: text.into(),
        ..SearchQuery::default()
    };
    s.search(&q)
        .unwrap()
        .results
        .into_iter()
        .map(|h| h.path)
        .collect()
}

#[test]
fn m5_search_through_the_session_follows_edits() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Lore/Smaug.md", "# Smaug\n\nA red wyrm.\n");
    let (_c, s) = open(dir.path());
    assert_eq!(find(&s, "wyrm"), vec!["Lore/Smaug.md"]);
    let path = VaultPath::new("Lore/Smaug.md").unwrap();
    let (_, hash) = s.vault().read(&path).unwrap();
    s.write_page(&path, "# Smaug\n\nA golden dragon.\n", hash)
        .unwrap();
    assert!(find(&s, "wyrm").is_empty());
    assert_eq!(find(&s, "golden"), vec!["Lore/Smaug.md"]);
    assert!(!s.search(&SearchQuery::default()).unwrap().indexing);
}

fn title_of(s: &VaultSession, path: &str) -> String {
    s.page(&VaultPath::new(path).unwrap())
        .unwrap()
        .unwrap()
        .title
}

/// Final review I1: a page with no H1 takes its title from its file name, so a
/// rename must re-title it and search must find it by the new name only.
#[test]
fn m5_review_i1_a_renamed_page_is_found_by_its_new_name_only() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Notes/Old Name.md", "Just text.\n");
    write(dir.path(), "Notes/Kept.md", "# Heading Title\n\nMore.\n");
    let (_c, s) = open(dir.path());
    let vp = |p: &str| VaultPath::new(p).unwrap();
    s.rename(&vp("Notes/Old Name.md"), &vp("Notes/Fresh.md"), true)
        .unwrap();
    assert!(
        find(&s, "old").is_empty(),
        "no longer found by the old name"
    );
    assert_eq!(find(&s, "fresh"), vec!["Notes/Fresh.md"]);
    assert_eq!(title_of(&s, "Notes/Fresh.md"), "Fresh");
    // An H1 title survives a rename, and a folder rename keeps file names.
    s.rename(&vp("Notes/Kept.md"), &vp("Notes/Moved.md"), true)
        .unwrap();
    assert_eq!(title_of(&s, "Notes/Moved.md"), "Heading Title");
    s.rename(&vp("Notes"), &vp("Archive"), true).unwrap();
    assert_eq!(title_of(&s, "Archive/Fresh.md"), "Fresh");
    assert_eq!(find(&s, "archive fresh"), vec!["Archive/Fresh.md"]);
}

/// Final review I1, the watcher's half: a rename made by another program.
#[test]
fn m5_review_i1_an_outside_rename_is_found_by_its_new_name_only() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Old Name.md", "Just text.\n");
    let (_c, s) = open(dir.path());
    let s = std::sync::Arc::new(s);
    s.start_watching().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::rename(dir.path().join("Old Name.md"), dir.path().join("Fresh.md")).unwrap();
    assert!(nimw_testkit::wait_until(Duration::from_secs(5), || find(
        &s, "fresh"
    ) == vec![
        "Fresh.md"
    ]));
    assert!(find(&s, "old").is_empty());
    assert_eq!(title_of(&s, "Fresh.md"), "Fresh");
}

/// NFR-03 (M5 §6): on the 10,000-note reference vault, `search` p95 < 50 ms
/// over 200 queries of 1–3 words and filter mixes; the first index, FTS
/// included, < 30 s; re-indexing a changed page < 100 ms. Release only:
/// `cargo test --release -p nimw-session --test search -- --ignored --nocapture`.
#[test]
#[ignore = "perf: run in release with --ignored"]
fn nfr_03_search_p95_under_50_ms() {
    use nimw_testkit::{VaultShape, generate_vault};
    let dir = tempfile::tempdir().unwrap();
    generate_vault(dir.path(), VaultShape::TEN_K, 42);
    let started = Instant::now();
    let (_c, s) = open(dir.path());
    let indexed = started.elapsed();
    eprintln!("first index: {indexed:?}");
    assert!(indexed < Duration::from_secs(30), "{indexed:?}");

    const WORDS: &[&str] = &[
        "note",
        "generated",
        "paragraph",
        "words",
        "excerpt",
        "topic1",
        "topic12",
        "batch3",
        "gen",
        "hub",
        "folder",
        "back",
        "no",
        "gene",
        "par",
        "wor",
        "note 12",
        "zzz",
        "some",
        "the",
        "x",
    ];
    let mut seed: u64 = 7;
    let mut next = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n as u64) as usize
    };
    let mut times = Vec::new();
    for i in 0..200 {
        let words: Vec<&str> = (0..1 + next(3)).map(|_| WORDS[next(WORDS.len())]).collect();
        let mut q = SearchQuery {
            text: words.join(" "),
            ..SearchQuery::default()
        };
        match i % 5 {
            1 => q.tags = vec![format!("topic{}", next(200))],
            2 => q.has_image = true,
            3 => q.links_to = Some("hub.md".into()),
            4 => {
                q.project = Some("Folder 0".into());
                q.tags = vec!["gen".into()];
            }
            _ => {}
        }
        if i % 20 == 0 {
            q.text.clear();
        }
        let t = Instant::now();
        let page = s.search(&q).unwrap();
        times.push(t.elapsed());
        assert!(page.results.len() <= 50);
    }
    times.sort();
    let p = |q: f64| times[((times.len() as f64 * q) as usize).min(times.len() - 1)];
    eprintln!(
        "search p50 {:?}, p95 {:?}, max {:?}",
        p(0.5),
        p(0.95),
        times[times.len() - 1]
    );
    assert!(p(0.95) < Duration::from_millis(50), "p95 {:?}", p(0.95));

    let path = VaultPath::new("hub.md").unwrap();
    let (_, hash) = s.vault().read(&path).unwrap();
    let t = Instant::now();
    s.write_page(&path, "# Hub\n\nChanged words for search.\n", hash)
        .unwrap();
    let rewrite = t.elapsed();
    eprintln!("re-index one page: {rewrite:?}");
    assert!(rewrite < Duration::from_millis(100), "{rewrite:?}");
}
