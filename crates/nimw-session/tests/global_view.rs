//! M3a §3, §4, §8: Global View levels (vault, folder, page neighbourhood),
//! cards (index notes, folder summaries, covers), edges and layouts.

use nimw_session::{CardKind, GvCard, GvLevel, Relation, SessionEvent, VaultSession};
use nimw_vault::VaultPath;
use std::path::Path;

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

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

/// Alpha (index note named like the folder, a Sub folder with index.md),
/// Beta (a single page), Gamma (an index pick), Delta (no index note: a
/// summary; its attachments folder is not a card), a root attachments
/// folder, and two root pages that link to each other.
fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    write(
        r,
        "Alpha/Alpha.md",
        "---\nsubtitle: The first project\n---\n# Alpha home\n\nAll about alpha.\n",
    );
    write(
        r,
        "Alpha/note.md",
        "---\nrelated: \"[[Welcome]]\"\n---\n# A note\n",
    );
    write(r, "Alpha/Sub/index.md", "# Sub index\n");
    write(r, "Alpha/Sub/deep.md", "# Deep\n");
    write(r, "Beta/only.md", "# Only page\n\nSee [[Welcome]].\n");
    write(r, "Gamma/a.md", "# Gamma A\n");
    write(
        r,
        "Gamma/b.md",
        "# Gamma B\n\nPicked as the folder's preview.\n",
    );
    write(r, "Delta/x.md", "---\ncover: missing.png\n---\n# X title\n");
    write(
        r,
        "Delta/y.md",
        "---\nrelated:\n  - { link: \"[[Welcome]]\", label: inspired, directed: true }\n---\n# y\n",
    );
    write(r, "Delta/Inner/i.md", "# I\n");
    write(r, "Delta/attachments/pic.png", "png");
    write(r, "attachments/w.png", "png");
    write(
        r,
        "Welcome.md",
        "---\ncover: attachments/w.png\ncover-y: 30\n---\n# Welcome\n\nStart at [[note]] or [[zeta]]. ![[w.png]]\n",
    );
    write(
        r,
        "zeta.md",
        "---\ncover: https://example.com/x.png\n---\n# Zeta\n\nBack to [[Welcome]].\n",
    );
    write(
        r,
        ".nimw/vault.json",
        r#"{"version":1,"indexPicks":{"Gamma":"Gamma/b.md"}}"#,
    );
    dir
}

fn card<'a>(cards: &'a [GvCard], path: &str) -> &'a GvCard {
    cards
        .iter()
        .find(|c| c.path == path)
        .unwrap_or_else(|| panic!("no card {path} in {:?}", paths(cards)))
}

fn paths(cards: &[GvCard]) -> Vec<&str> {
    cards.iter().map(|c| c.path.as_str()).collect()
}

#[test]
fn gv_10_vault_level_shows_projects_then_root_pages_without_attachment_folders() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let level = s.gv_children(&GvLevel::Vault).unwrap();
    assert_eq!(
        paths(&level.cards),
        ["Alpha", "Beta", "Delta", "Gamma", "Welcome.md", "zeta.md"]
    );
    assert!(level.centre.is_none());
    assert!(level.cards[..4].iter().all(|c| c.kind == CardKind::Project));
    assert!(level.cards[4..].iter().all(|c| c.kind == CardKind::Page));
}

#[test]
fn gv_02_folder_cards_preview_their_index_note_or_summarise_their_children() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;

    // 1. A page named like the folder.
    let alpha = card(&cards, "Alpha");
    assert_eq!(alpha.index_page.as_deref(), Some("Alpha/Alpha.md"));
    assert_eq!(alpha.title, "Alpha home");
    assert_eq!(alpha.subtitle.as_deref(), Some("The first project"));
    assert_eq!(alpha.excerpt, "All about alpha.");
    assert_eq!((alpha.pages, alpha.folders), (2, 1));
    // 4. The only page of a folder with no subfolders.
    assert_eq!(
        card(&cards, "Beta").index_page.as_deref(),
        Some("Beta/only.md")
    );
    // 3. The page picked in .nimw/vault.json.
    let gamma = card(&cards, "Gamma");
    assert_eq!(gamma.index_page.as_deref(), Some("Gamma/b.md"));
    assert_eq!(gamma.title, "Gamma B");
    // No index note: a summary (the attachments folder is not counted).
    let delta = card(&cards, "Delta");
    assert_eq!(delta.index_page, None);
    assert_eq!(delta.title, "Delta");
    assert_eq!(delta.subtitle.as_deref(), Some("Delta"));
    assert_eq!((delta.pages, delta.folders), (2, 1));
    assert_eq!(delta.child_titles, ["Inner", "X title", "y"]);
    assert_eq!(delta.excerpt, "Inner · X title · y");

    // 2. index.md, one level down; subfolders there are "folder" cards.
    let alpha_level = s.gv_children(&GvLevel::Folder(vp("Alpha"))).unwrap();
    assert_eq!(
        paths(&alpha_level.cards),
        ["Alpha/Sub", "Alpha/Alpha.md", "Alpha/note.md"]
    );
    let sub = card(&alpha_level.cards, "Alpha/Sub");
    assert_eq!(sub.kind, CardKind::Folder);
    assert_eq!(sub.index_page.as_deref(), Some("Alpha/Sub/index.md"));
    assert_eq!(sub.title, "Sub index");
}

#[test]
fn m3a_covers_are_resolved_remote_ones_flagged_missing_ones_dropped() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;
    let welcome = card(&cards, "Welcome.md");
    assert_eq!(welcome.cover.as_deref(), Some("attachments/w.png"));
    assert_eq!(welcome.cover_y, Some(30));
    assert!(!welcome.cover_remote);
    assert!(welcome.has_image);
    let zeta = card(&cards, "zeta.md");
    assert_eq!(zeta.cover, None);
    assert!(zeta.cover_remote);
    let delta = s.gv_children(&GvLevel::Folder(vp("Delta"))).unwrap();
    let x = card(&delta.cards, "Delta/x.md");
    assert_eq!((x.cover.as_deref(), x.cover_remote), (None, false));
    assert_eq!(
        paths(&delta.cards),
        ["Delta/Inner", "Delta/x.md", "Delta/y.md"],
        "the attachments folder is not a card"
    );
}

#[test]
fn gv_16_page_level_is_the_page_and_its_neighbourhood() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let level = s.gv_children(&GvLevel::Page(vp("Welcome.md"))).unwrap();
    assert_eq!(level.centre.as_deref(), Some("Welcome.md"));
    let rel = |p: &str| card(&level.cards, p).relation;
    assert_eq!(rel("Welcome.md"), Some(Relation::Centre));
    assert_eq!(level.cards[0].path, "Welcome.md", "the centre comes first");
    // Links out; an undirected `related:` pointing here goes right too.
    assert_eq!(rel("Alpha/note.md"), Some(Relation::Out));
    assert_eq!(rel("zeta.md"), Some(Relation::Both));
    assert_eq!(rel("Beta/only.md"), Some(Relation::In));
    // A directed relationship towards this page comes in.
    assert_eq!(rel("Delta/y.md"), Some(Relation::In));
    assert_eq!(level.cards.len(), 5, "no image card, no duplicates");
    assert!(level.cards.iter().all(|c| c.kind == CardKind::Page));
}

#[test]
fn m3a_levels_that_do_not_exist_are_errors() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    assert!(s.gv_children(&GvLevel::Folder(vp("Nope"))).is_err());
    assert!(s.gv_children(&GvLevel::Folder(vp("Welcome.md"))).is_err());
    assert!(s.gv_children(&GvLevel::Page(vp("Alpha"))).is_err());
    assert!(s.gv_children(&GvLevel::Page(vp("gone.md"))).is_err());
}

#[test]
fn m3a_an_obsidian_attachment_folder_is_hidden_and_a_fixed_one_too() {
    let dir = vault();
    write(
        dir.path(),
        ".obsidian/app.json",
        r#"{"attachmentFolderPath":"Gamma"}"#,
    );
    let (_c, s) = open(dir.path());
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;
    assert_eq!(
        paths(&cards),
        [
            "Alpha",
            "attachments",
            "Beta",
            "Delta",
            "Welcome.md",
            "zeta.md"
        ],
        "Gamma is now the attachment folder; `attachments` is an ordinary folder"
    );
}
