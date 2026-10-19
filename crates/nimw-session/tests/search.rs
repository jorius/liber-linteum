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
    // Batch 6: text and code files are indexed for search too.
    for i in 0..1000 {
        let body = format!("generated log {i} words paragraph topic{} note\n", i % 200).repeat(40);
        write(dir.path(), &format!("Logs {}/log {i}.txt", i % 10), &body);
    }
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
            _ => q.text_files = i % 10 == 5,
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

/// M4c + M5: a quick note renamed after its first line is found by that name,
/// and no longer by its generated one.
#[test]
fn m4c_m5_a_quick_note_is_found_by_its_first_line_name() {
    let dir = tempfile::tempdir().unwrap();
    let (_c, s) = open(dir.path());
    let vp = |p: &str| VaultPath::new(p).unwrap();
    let q = s
        .create_quick_note(&vp("Scratchpad"), "Quick note 2026-10-15 09.05")
        .unwrap();
    let (_, hash) = s.vault().read(&q).unwrap();
    s.write_page(&q, "Buy oats and honey\n", hash).unwrap();
    let out = s.auto_name(&q, true).unwrap();
    assert_eq!(out.path.as_str(), "Scratchpad/Buy oats and honey.md");
    assert_eq!(find(&s, "oats"), vec!["Scratchpad/Buy oats and honey.md"]);
    assert!(
        find(&s, "quick note").is_empty(),
        "not by the generated name"
    );
    assert_eq!(
        title_of(&s, "Scratchpad/Buy oats and honey.md"),
        "Buy oats and honey"
    );
}

/// Batch 6: text and code files are found by name and content; files that
/// aren't readable text (not UTF-8, too large) are skipped, never an error.
/// Batch 6 review M1: a rename that changes whether a file is text drops or
/// loads its searchable text.
#[test]
fn b6_review_m1_a_rename_rechecks_whether_a_file_is_text() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a.txt", "dragonfruit\n");
    write(dir.path(), "b.bin", "kiwano\n");
    let (_c, s) = open(dir.path());
    assert_eq!(find(&s, "dragonfruit"), vec!["a.txt"]);
    assert!(find(&s, "kiwano").is_empty());
    let vp = |p: &str| VaultPath::new(p).unwrap();
    s.rename(&vp("a.txt"), &vp("a.pdf"), false).unwrap();
    assert!(
        find(&s, "dragonfruit").is_empty(),
        "a .pdf isn't searched by its old text"
    );
    s.rename(&vp("b.bin"), &vp("b.txt"), false).unwrap();
    assert_eq!(find(&s, "kiwano"), vec!["b.txt"]);
}

#[test]
fn b6_text_files_are_searchable_through_the_session() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Notes/todo.txt", "buy dragonfruit\n");
    write(dir.path(), "Code/main.rs", "fn obsidianite() {}\n");
    std::fs::write(dir.path().join("Notes/latin1.txt"), b"caf\xe9 malachite").unwrap();
    let big = format!("zircon {}", "x".repeat(nimw_session::TEXT_MAX_BYTES));
    write(dir.path(), "Notes/huge.log", &big);
    write(dir.path(), "pic.png", "dragonfruit");
    let (_c, s) = open(dir.path());
    assert_eq!(find(&s, "dragonfruit"), vec!["Notes/todo.txt"]);
    assert_eq!(find(&s, "obsidianite"), vec!["Code/main.rs"]);
    assert!(find(&s, "malachite").is_empty());
    assert!(find(&s, "zircon").is_empty());

    let path = VaultPath::new("Notes/todo.txt").unwrap();
    let (_, hash) = s.vault().read(&path).unwrap();
    s.write_text(&path, "sell rhubarb\n", hash).unwrap();
    assert!(find(&s, "dragonfruit").is_empty());
    assert_eq!(find(&s, "rhubarb"), vec!["Notes/todo.txt"]);

    s.create_folder(&VaultPath::root(), "Lists").unwrap();
    let to = VaultPath::new("Lists/groceries.txt").unwrap();
    s.rename(&path, &to, false).unwrap();
    assert_eq!(find(&s, "groceries"), vec!["Lists/groceries.txt"]);
    assert_eq!(find(&s, "rhubarb"), vec!["Lists/groceries.txt"]);
    assert!(find(&s, "todo").is_empty());

    // A new text file made in the app is found once it has text.
    let made = s
        .create_text_file(&VaultPath::new("Notes").unwrap(), "new.txt")
        .unwrap();
    let (_, hash) = s.vault().read(&made).unwrap();
    s.write_text(&made, "tourmaline\n", hash).unwrap();
    assert_eq!(find(&s, "tourmaline"), vec!["Notes/new.txt"]);
}
