//! M3a §3, §4, §8: Global View levels (vault, folder, page neighbourhood),
//! cards (index notes, folder summaries, covers), edges and layouts.

use nimw_session::{
    CardKind, EdgeKind, GvCard, GvEdge, GvLevel, Relation, SessionEvent, VaultSession,
};
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
    write(r, "Alpha/note.md", "# A note\n");
    write(r, "Alpha/Sub/index.md", "# Sub index\n");
    write(r, "Alpha/Sub/deep.md", "# Deep\n");
    write(r, "Beta/only.md", "# Only page\n\nSee [[Welcome]].\n");
    write(
        r,
        "Gamma/a.md",
        "---\nrelated:\n  - \"[[Welcome]]\"\n---\n# Gamma A\n",
    );
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
    assert_eq!(rel("Gamma/a.md"), Some(Relation::Out));
    assert_eq!(rel("zeta.md"), Some(Relation::Both));
    assert_eq!(rel("Beta/only.md"), Some(Relation::In));
    // A directed relationship towards this page comes in.
    assert_eq!(rel("Delta/y.md"), Some(Relation::In));
    assert_eq!(level.cards.len(), 6, "no image card, no duplicates");
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

/// Pages in folders A and B linking across, a relationship with a label and
/// a direction, an image embed (never an edge) and a link inside A.
fn linked_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    write(r, "A/p.md", "# P\n\n[[q]] and [[s]] ![[pic.png]]\n");
    write(r, "A/r.md", "# R\n\n[[q]] [[p]]\n");
    write(r, "A/pic.png", "png");
    write(
        r,
        "B/q.md",
        "---\nrelated:\n  - { link: \"[[root]]\", label: sequel, directed: true }\n---\n# Q\n",
    );
    write(r, "B/s.md", "# S\n");
    write(r, "C/t.md", "# T\n");
    write(r, "root.md", "---\nrelated:\n  - \"[[t]]\"\n---\n# Root\n");
    dir
}

fn visible(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn edge<'a>(edges: &'a [GvEdge], a: &str, b: &str, kind: EdgeKind) -> &'a GvEdge {
    edges
        .iter()
        .find(|e| e.kind == kind && ((e.from == a && e.to == b) || (e.from == b && e.to == a)))
        .unwrap_or_else(|| panic!("no {kind:?} edge {a}–{b} in {edges:?}"))
}

#[test]
fn gv_25_links_inside_folders_aggregate_to_one_edge_per_card_pair() {
    let dir = linked_vault();
    let (_c, s) = open(dir.path());
    let edges = s.gv_edges(&visible(&["A", "B", "C", "root.md"])).unwrap();
    // p→q, p→s and r→q: three links from A into B, one aggregated edge.
    let ab = edge(&edges, "A", "B", EdgeKind::Link);
    assert_eq!((ab.count, ab.aggregated, ab.directed), (3, true, false));
    // The link inside A (r→p) and the image embed draw nothing.
    assert!(!edges.iter().any(|e| e.from == e.to));
    // Relationships: B/q.md → root (directed, labelled), root → C/t.md.
    let manual = edge(&edges, "B", "root.md", EdgeKind::Manual);
    assert_eq!(
        (manual.from.as_str(), manual.to.as_str()),
        ("B", "root.md"),
        "directed edges keep their orientation"
    );
    assert!(manual.directed && manual.aggregated);
    assert_eq!(manual.label.as_deref(), Some("sequel"));
    let rc = edge(&edges, "root.md", "C", EdgeKind::Manual);
    assert!(!rc.directed && rc.label.is_none());
    assert_eq!(edges.len(), 3, "{edges:?}");
}

#[test]
fn gv_20_visible_pages_connect_directly_and_folders_take_the_rest() {
    let dir = linked_vault();
    let (_c, s) = open(dir.path());
    // Expand-like canvas: folder A expanded to show p.md; B stays a card.
    let edges = s
        .gv_edges(&visible(&[
            "A", "A/p.md", "B", "B/q.md", "B/s.md", "root.md",
        ]))
        .unwrap();
    let pq = edge(&edges, "A/p.md", "B/q.md", EdgeKind::Link);
    assert_eq!((pq.count, pq.aggregated), (1, false));
    edge(&edges, "A/p.md", "B/s.md", EdgeKind::Link);
    // r.md isn't visible: its links count for A (r→q → A–q; r→p → A–p).
    let aq = edge(&edges, "A", "B/q.md", EdgeKind::Link);
    assert!(aq.aggregated);
    let ap = edge(&edges, "A", "A/p.md", EdgeKind::Link);
    assert!(ap.aggregated);
    let qr = edge(&edges, "B/q.md", "root.md", EdgeKind::Manual);
    assert!(!qr.aggregated && qr.directed);
}

#[test]
fn m3a_no_visible_cards_no_edges() {
    let dir = linked_vault();
    let (_c, s) = open(dir.path());
    assert!(s.gv_edges(&[]).unwrap().is_empty());
    assert!(s.gv_edges(&visible(&["Nope"])).unwrap().is_empty());
}

/// NFR-03 (M3a §10): on a 10,000-note vault, a 200-card folder level and its
/// edges take < 100 ms. Release only:
/// `cargo test --release -p nimw-session --test global_view -- --ignored`.
#[test]
#[ignore = "perf: run in release with --ignored"]
fn nfr_03_a_200_card_level_and_its_edges_in_under_100_ms() {
    use nimw_testkit::{VaultShape, generate_vault};
    let dir = tempfile::tempdir().unwrap();
    generate_vault(dir.path(), VaultShape::TEN_K, 42);
    for i in 0..200 {
        write(
            dir.path(),
            &format!("Big/Page {i}.md"),
            &format!(
                "# Page {i}\n\n[[Page {}]] [[hub]] [[Note {i}]]\n",
                (i + 1) % 200
            ),
        );
    }
    let (_c, s) = open(dir.path());
    let started = std::time::Instant::now();
    let level = s.gv_children(&GvLevel::Folder(vp("Big"))).unwrap();
    let shown: Vec<String> = level.cards.iter().map(|c| c.path.clone()).collect();
    let edges = s.gv_edges(&shown).unwrap();
    let took = started.elapsed();
    assert_eq!(level.cards.len(), 200);
    assert_eq!(edges.len(), 200, "one ring of links");
    eprintln!("200-card level + edges: {took:?}");
    assert!(took < std::time::Duration::from_millis(100), "{took:?}");

    // Level 0 reads every link in the vault (each project is a subtree):
    // ~90 ms here, inside the 300 ms render budget with room for the UI.
    let started = std::time::Instant::now();
    let level = s.gv_children(&GvLevel::Vault).unwrap();
    let shown: Vec<String> = level.cards.iter().map(|c| c.path.clone()).collect();
    s.gv_edges(&shown).unwrap();
    let took = started.elapsed();
    eprintln!("level 0 ({} cards) + edges: {took:?}", level.cards.len());
    assert!(took < std::time::Duration::from_millis(150), "{took:?}");
}
