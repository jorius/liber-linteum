//! M2c §5, §7.1, §7.2: attachments saved/imported for a page (policy, folders,
//! dedupe, sanitizing, inside-vault drops, indexing), vault settings and link
//! suggestions.

use nimw_index::FileKind;
use nimw_markdown::LinkKind;
use nimw_session::{SessionError, SessionEvent, VaultSession, cover_reference, sanitize_file_name};
use nimw_testkit::copy_fixture;
use nimw_vault::VaultPath;
use std::time::{Duration, SystemTime};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn open(dir: &std::path::Path) -> (tempfile::TempDir, VaultSession) {
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(dir, cache.path(), |_: SessionEvent| {}).unwrap();
    (cache, s)
}

fn resolves_to(s: &VaultSession, page: &str, link: &str) -> Option<String> {
    s.resolve_links(&vp(page), &[(LinkKind::Embed, link.to_string())])
        .unwrap()
        .remove(0)
}

#[test]
fn m2c_paste_goes_to_obsidians_folder_dedupes_and_resolves_at_once() {
    let dir = copy_fixture("obsidian-basic"); // attachmentFolderPath "./assets"
    let (_c, s) = open(dir.path());
    let page = vp("Character Design/rex-draft.md");
    let first = s.save_attachment(&page, "shot.png", b"png-1").unwrap();
    assert_eq!(first.path.as_str(), "Character Design/assets/shot.png");
    assert_eq!(first.link, "shot.png");
    assert!(first.copied);
    let second = s.save_attachment(&page, "shot.png", b"png-2").unwrap();
    assert_eq!(second.path.as_str(), "Character Design/assets/shot 1.png");
    assert_eq!(
        std::fs::read(dir.path().join("Character Design/assets/shot 1.png")).unwrap(),
        b"png-2"
    );
    // Indexed synchronously: the embed resolves before any watcher event.
    assert_eq!(
        resolves_to(&s, page.as_str(), &second.link).as_deref(),
        Some("Character Design/assets/shot 1.png")
    );
}

#[test]
fn m2c_default_policy_creates_and_indexes_the_attachments_folder() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir(vault.path().join("Notes")).unwrap();
    std::fs::write(vault.path().join("Notes/Today.md"), "# Today\n").unwrap();
    std::fs::create_dir(vault.path().join("Other")).unwrap();
    std::fs::write(vault.path().join("Other/shot.png"), b"old").unwrap();
    let (_c, s) = open(vault.path());
    let saved = s
        .save_attachment(&vp("Notes/Today.md"), "shot.png", b"new")
        .unwrap();
    assert_eq!(saved.path.as_str(), "Notes/attachments/shot.png");
    // `shot.png` alone would resolve to the shallower Other/shot.png.
    assert_eq!(saved.link, "attachments/shot.png");
    assert_eq!(
        resolves_to(&s, "Notes/Today.md", &saved.link).as_deref(),
        Some("Notes/attachments/shot.png")
    );
    let tree = s.tree().unwrap();
    assert!(
        tree.iter()
            .any(|n| n.path == "Notes/attachments" && n.kind == FileKind::Folder),
        "the new folder is in the tree"
    );
}

#[test]
fn m2c_names_are_sanitized_not_refused() {
    assert_eq!(sanitize_file_name("a:b|c?.png"), "a-b-c-.png");
    assert_eq!(sanitize_file_name(".env"), "-env");
    assert_eq!(sanitize_file_name("  "), "file");
    assert_eq!(sanitize_file_name("tab\there.txt"), "tab-here.txt");
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("P.md"), "").unwrap();
    let (_c, s) = open(vault.path());
    let saved = s.save_attachment(&vp("P.md"), "x#1.png", b"x").unwrap();
    assert_eq!(saved.path.as_str(), "attachments/x-1.png");
}

#[test]
fn m2c_import_copies_outside_files_and_links_inside_ones() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("P.md"), "").unwrap();
    std::fs::create_dir(vault.path().join("Docs")).unwrap();
    std::fs::write(vault.path().join("Docs/spec.pdf"), b"%PDF").unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("report.pdf"), b"%PDF-out").unwrap();
    std::fs::write(outside.path().join("Draft.md"), "# Draft title\n").unwrap();
    let (_c, s) = open(vault.path());
    let page = vp("P.md");

    let copied = s
        .import_attachment(&page, &outside.path().join("report.pdf"))
        .unwrap();
    assert_eq!(
        (copied.path.as_str(), copied.link.as_str(), copied.copied),
        ("attachments/report.pdf", "report.pdf", true)
    );
    let inside = s
        .import_attachment(&page, &vault.path().join("Docs/spec.pdf"))
        .unwrap();
    assert_eq!(
        (inside.path.as_str(), inside.link.as_str(), inside.copied),
        ("Docs/spec.pdf", "spec.pdf", false)
    );
    // A dropped Markdown file becomes a page (indexed with its title).
    let md = s
        .import_attachment(&page, &outside.path().join("Draft.md"))
        .unwrap();
    assert_eq!(md.path.as_str(), "attachments/Draft.md");
    assert_eq!(md.link, "Draft");
    assert_eq!(s.page(&md.path).unwrap().unwrap().title, "Draft title");
    // Folders are refused.
    let err = s.import_attachment(&page, outside.path()).unwrap_err();
    assert!(matches!(err, SessionError::NotAFile(_)), "{err:?}");
}

#[cfg(unix)]
#[test]
fn m2c_import_follows_a_symlink_and_keeps_the_dropped_name() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("P.md"), "").unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("real.png"), b"img").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("real.png"),
        outside.path().join("alias.png"),
    )
    .unwrap();
    let (_c, s) = open(vault.path());
    let saved = s
        .import_attachment(&vp("P.md"), &outside.path().join("alias.png"))
        .unwrap();
    assert_eq!(saved.path.as_str(), "attachments/alias.png");
    assert_eq!(
        std::fs::read(vault.path().join("attachments/alias.png")).unwrap(),
        b"img"
    );
    assert!(
        !vault
            .path()
            .join("attachments/alias.png")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn m2c_attachment_settings_respect_obsidian_and_validate_names() {
    let dir = copy_fixture("obsidian-basic");
    let (_c, s) = open(dir.path());
    assert_eq!(
        s.attachment_settings().obsidian.as_deref(),
        Some("./assets")
    );
    let err = s.set_attachment_settings("same", "").unwrap_err();
    assert!(matches!(err, SessionError::NotPermitted(_)), "{err:?}");

    let vault = tempfile::tempdir().unwrap();
    let (_c2, s) = open(vault.path());
    for (mode, path) in [
        ("subfolder", "a/b"),
        ("subfolder", ""),
        ("folder", "Media/x:y"),
        ("folder", ""),
    ] {
        let err = s.set_attachment_settings(mode, path).unwrap_err();
        assert!(
            matches!(err, SessionError::InvalidName(_)),
            "{mode} {path}: {err:?}"
        );
    }
    s.set_attachment_settings("folder", "Media/Img").unwrap();
    let settings = s.attachment_settings();
    assert_eq!(
        (settings.mode.as_str(), settings.path.as_str()),
        ("folder", "Media/Img")
    );
}

#[test]
fn pg_05_link_suggest_matches_titles_and_writes_the_shortest_target() {
    let dir = copy_fixture("obsidian-basic");
    let (_c, s) = open(dir.path());
    let found = s.link_suggest(&vp("Welcome.md"), "gen", false, 50).unwrap();
    let first = &found[0];
    assert_eq!(first.path, "Character Design/rex-draft.md");
    assert_eq!(first.title.as_deref(), Some("Generator Rex"));
    assert_eq!(first.target, "rex-draft");
    assert_eq!(first.kind, FileKind::Page);
}

#[test]
fn m2c_link_suggest_orders_pages_or_attachments_first() {
    let dir = copy_fixture("obsidian-basic");
    let (_c, s) = open(dir.path());
    let kinds = |embed| {
        s.link_suggest(&vp("Welcome.md"), "rex", embed, 50)
            .unwrap()
            .into_iter()
            .map(|x| x.path)
            .collect::<Vec<_>>()
    };
    assert_eq!(kinds(false)[0], "Character Design/rex-draft.md");
    let embed = kinds(true);
    assert!(embed[0].ends_with(".png"), "{embed:?}");
    assert_eq!(embed.last().unwrap(), "Character Design/rex-draft.md");
    // Attachments keep their extension in the target.
    let png = s
        .link_suggest(&vp("Welcome.md"), "rex-cover", true, 50)
        .unwrap();
    assert_eq!(png[0].target, "rex-cover.png");
    assert_eq!(png[0].title, None);
}

#[test]
fn m2c_link_suggest_ranks_exact_then_prefix_then_substring_and_limits() {
    let vault = tempfile::tempdir().unwrap();
    for name in [
        "Plan.md",
        "Planning notes.md",
        "Master plan.md",
        "Explanation.md",
        "p-l-a-n.md",
    ] {
        std::fs::write(vault.path().join(name), "").unwrap();
    }
    let (_c, s) = open(vault.path());
    let paths: Vec<String> = s
        .link_suggest(&vp("Plan.md"), "plan", false, 50)
        .unwrap()
        .into_iter()
        .map(|x| x.path)
        .collect();
    assert_eq!(
        paths,
        [
            "Plan.md",
            "Planning notes.md",
            "Master plan.md",
            "Explanation.md",
            "p-l-a-n.md"
        ]
    );
    assert_eq!(
        s.link_suggest(&vp("Plan.md"), "plan", false, 2)
            .unwrap()
            .len(),
        2
    );
    assert!(
        s.link_suggest(&vp("Plan.md"), "zzz", false, 50)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn m2c_link_suggest_empty_query_lists_recent_files_first() {
    let vault = tempfile::tempdir().unwrap();
    for name in ["Old.md", "New.md", "Mid.md"] {
        std::fs::write(vault.path().join(name), "").unwrap();
    }
    let now = SystemTime::now();
    for (name, age) in [("Old.md", 300), ("Mid.md", 200), ("New.md", 100)] {
        std::fs::File::options()
            .write(true)
            .open(vault.path().join(name))
            .unwrap()
            .set_modified(now - Duration::from_secs(age))
            .unwrap();
    }
    let (_c, s) = open(vault.path());
    let paths: Vec<String> = s
        .link_suggest(&vp("Old.md"), "", false, 50)
        .unwrap()
        .into_iter()
        .map(|x| x.path)
        .collect();
    assert_eq!(paths, ["New.md", "Mid.md", "Old.md"]);
}

#[test]
fn m2c_cover_reference_is_relative_inside_the_page_folder_else_rooted() {
    let r = |page: &str, file: &str| cover_reference(&vp(page), &vp(file));
    assert_eq!(
        r("Chars/Rex.md", "Chars/attachments/x.png"),
        "attachments/x.png"
    );
    assert_eq!(r("Chars/Rex.md", "Chars/x.png"), "x.png");
    assert_eq!(r("Rex.md", "attachments/x.png"), "attachments/x.png");
    assert_eq!(r("Chars/Rex.md", "Images/x.png"), "/Images/x.png");
    assert_eq!(r("Chars/Rex.md", "Characters/x.png"), "/Characters/x.png");
}
