//! M3a §3, §4, §8: Global View levels (vault, folder, page neighbourhood),
//! cards (index notes, folder summaries, covers), edges and layouts.

use liber_session::{
    CardKind, EdgeKind, GvCard, GvEdge, GvLevel, IndexFrom, Relation, SessionError, SessionEvent,
    VaultSession,
};
use liber_vault::{CoverSide, VaultPath};
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
        "---\ncover: attachments/w.png\ncover-y: 30\ncover-x: 70\n---\n# Welcome\n\nStart at [[note]] or [[zeta]]. ![[w.png]]\n",
    );
    write(
        r,
        "zeta.md",
        "---\ncover: https://example.com/x.png\n---\n# Zeta\n\nBack to [[Welcome]].\n",
    );
    write(
        r,
        ".liber/vault.json",
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
    // 3. The page picked in .liber/vault.json.
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
    assert_eq!(welcome.cover_x, Some(70));
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

/// M4b part 3 §3: cards carry their page's cover placement (`coverSides`),
/// a folder card its index note's; pages without an entry sit on top.
#[test]
fn cards_carry_the_cover_side_of_their_page() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    s.vault()
        .set_cover_side("Welcome.md", CoverSide::Left)
        .unwrap();
    s.vault()
        .set_cover_side("Alpha/Alpha.md", CoverSide::Right)
        .unwrap();
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;
    assert_eq!(card(&cards, "Welcome.md").cover_side, CoverSide::Left);
    assert_eq!(card(&cards, "zeta.md").cover_side, CoverSide::Top);
    assert_eq!(card(&cards, "Alpha").cover_side, CoverSide::Right);
    assert_eq!(card(&cards, "Beta").cover_side, CoverSide::Top);
    let page = s.gv_children(&GvLevel::Page(vp("Welcome.md"))).unwrap();
    assert_eq!(card(&page.cards, "Welcome.md").cover_side, CoverSide::Left);
    s.vault()
        .set_cover_side("Delta/x.md", CoverSide::Right)
        .unwrap();
    let picked = s
        .index_pick_set(&vp("Delta"), Some(&vp("Delta/x.md")))
        .unwrap();
    assert_eq!(picked.cover_side, CoverSide::Right);
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

/// Final review m14: a hub page's neighbourhood is capped at
/// `MAX_NEIGHBOURS` cards around the centre — the pages it links to and its
/// relationships first, then the most recently modified backlinks — and the
/// rest are counted, so the edges of what is shown stay within the
/// `gv_edges` limit.
#[test]
fn m3a_a_hub_page_neighbourhood_is_capped_and_counts_the_rest() {
    use liber_session::{MAX_NEIGHBOURS, MAX_VISIBLE};
    const BACKLINKS: usize = 300;
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    // The hub also links to its oldest backlink: a page linked both ways
    // counts as linked to.
    write(
        r,
        "hub.md",
        "# Hub\n\n[[out0]] [[out1]] [[out2]] [[b000]]\n",
    );
    for i in 0..3 {
        write(r, &format!("out{i}.md"), "# Out\n");
    }
    write(
        r,
        "rel.md",
        "---\nrelated:\n  - { link: \"[[hub]]\", directed: true }\n---\n# Rel\n",
    );
    let start = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    for i in 0..BACKLINKS {
        let path = r.join(format!("back/b{i:03}.md"));
        write(r, &format!("back/b{i:03}.md"), "# Back\n\n[[hub]]\n");
        // Older first: b299 is the most recently modified.
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(start + std::time::Duration::from_secs(i as u64))
            .unwrap();
    }
    let (_c, s) = open(r);

    let level = s.gv_children(&GvLevel::Page(vp("hub.md"))).unwrap();
    assert_eq!(MAX_NEIGHBOURS, 200);
    assert_eq!(level.cards.len(), 1 + MAX_NEIGHBOURS);
    assert_eq!(level.omitted as usize, 3 + 1 + BACKLINKS - MAX_NEIGHBOURS);
    assert_eq!(level.cards[0].path, "hub.md", "the centre is always shown");
    let shown = paths(&level.cards);
    for kept in ["out0.md", "out1.md", "out2.md", "rel.md", "back/b000.md"] {
        assert!(shown.contains(&kept), "{kept} kept");
    }
    // 195 backlinks are left for the cap: the newest, b105..=b299.
    assert!(shown.contains(&"back/b299.md") && shown.contains(&"back/b105.md"));
    assert!(!shown.contains(&"back/b104.md") && !shown.contains(&"back/b001.md"));
    let visible: Vec<String> = shown.iter().map(|p| p.to_string()).collect();
    assert!(visible.len() <= MAX_VISIBLE);
    assert!(!s.gv_edges(&visible).unwrap().is_empty());

    let small = s.gv_children(&GvLevel::Page(vp("rel.md"))).unwrap();
    assert_eq!((small.cards.len(), small.omitted), (2, 0));
    assert_eq!(s.gv_children(&GvLevel::Vault).unwrap().omitted, 0);
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
/// `cargo test --release -p liber-session --test global_view -- --ignored`.
#[test]
#[ignore = "perf: run in release with --ignored"]
fn nfr_03_a_200_card_level_and_its_edges_in_under_100_ms() {
    use liber_testkit::{VaultShape, generate_vault};
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

#[test]
fn m3a_pinned_positions_follow_in_app_and_external_renames() {
    use liber_vault::{CardPosition, WatchEvent};
    use std::collections::BTreeMap;
    let dir = vault();
    let (_c, s) = open(dir.path());
    let pin = |path: &str| -> BTreeMap<String, CardPosition> {
        [(path.to_string(), CardPosition { x: 1.0, y: 2.0 })].into()
    };
    s.vault().set_layout_level("", &pin("Alpha")).unwrap();
    s.vault()
        .set_layout_level("Alpha", &pin("Alpha/note.md"))
        .unwrap();
    s.vault()
        .set_layout_level("", &{
            let mut m = pin("Alpha");
            m.extend(pin("zeta.md"));
            m
        })
        .unwrap();

    // In-app: the folder moves, its level key and card entries follow.
    s.rename(&vp("Alpha"), &vp("Projects A"), false).unwrap();
    assert!(s.vault().layout_level("").contains_key("Projects A"));
    assert!(
        s.vault()
            .layout_level("Projects A")
            .contains_key("Projects A/note.md")
    );

    // Another program renames a page (delete + create with the same content).
    std::fs::rename(dir.path().join("zeta.md"), dir.path().join("omega.md")).unwrap();
    s.apply(vec![
        WatchEvent::Removed(vp("zeta.md")),
        WatchEvent::Changed(vp("omega.md")),
    ])
    .unwrap();
    let root = s.vault().layout_level("");
    assert!(
        root.contains_key("omega.md") && !root.contains_key("zeta.md"),
        "{root:?}"
    );
}

/// Final review I3: a rename that matches no pinned position leaves
/// `layout.json` alone — no rewrite, no fsync (a hand-written compact file
/// would come back pretty-printed after any write).
#[test]
fn m3a_layout_is_not_rewritten_when_a_rename_matches_nothing() {
    use liber_vault::WatchEvent;
    let dir = vault();
    let compact = r#"{"version":1,"levels":{"":{"Alpha":{"x":1,"y":2}}}}"#;
    write(dir.path(), ".liber/layout.json", compact);
    let (_c, s) = open(dir.path());
    let layout = || std::fs::read_to_string(dir.path().join(".liber/layout.json")).unwrap();

    s.rename(&vp("zeta.md"), &vp("omega.md"), false).unwrap();
    assert_eq!(layout(), compact, "in-app rename");

    std::fs::rename(
        dir.path().join("Beta/only.md"),
        dir.path().join("Beta/solo.md"),
    )
    .unwrap();
    s.apply(vec![
        WatchEvent::Removed(vp("Beta/only.md")),
        WatchEvent::Changed(vp("Beta/solo.md")),
    ])
    .unwrap();
    assert_eq!(layout(), compact, "external rename");
}

/// Final review I3: another program moving 1,000 pinned notes (FSEvents
/// reports them as per-file renames) costs one layout write, not 1,000
/// fsynced rewrites. Release only:
/// `cargo test --release -p liber-session --test global_view -- --ignored`.
#[test]
#[ignore = "perf: run in release with --ignored"]
fn m3a_an_external_move_of_1000_pinned_notes_writes_the_layout_once() {
    use liber_vault::WatchEvent;
    const N: usize = 1000;
    let dir = tempfile::tempdir().unwrap();
    for i in 0..N {
        write(dir.path(), &format!("A/n{i}.md"), &format!("# Note {i}\n"));
    }
    // 50 other levels × 100 entries, plus an Expand canvas pinning every note.
    let mut levels: Vec<String> = (0..50)
        .map(|l| {
            let cards: Vec<String> = (0..100)
                .map(|e| format!(r#""L{l}/e{e}.md":{{"x":{e},"y":{l}}}"#))
                .collect();
            format!(r#""L{l}":{{{}}}"#, cards.join(","))
        })
        .collect();
    let pins: Vec<String> = (0..N)
        .map(|i| format!(r#""A/n{i}.md":{{"x":{i},"y":0}}"#))
        .collect();
    levels.push(format!(r#""expand:":{{{}}}"#, pins.join(",")));
    write(
        dir.path(),
        ".liber/layout.json",
        &format!(r#"{{"version":1,"levels":{{{}}}}}"#, levels.join(",")),
    );
    let (_c, s) = open(dir.path());

    std::fs::rename(dir.path().join("A"), dir.path().join("B")).unwrap();
    let mut events = vec![WatchEvent::Removed(vp("A")), WatchEvent::Changed(vp("B"))];
    for i in 0..N {
        events.push(WatchEvent::Removed(vp(&format!("A/n{i}.md"))));
        events.push(WatchEvent::Changed(vp(&format!("B/n{i}.md"))));
    }
    let started = std::time::Instant::now();
    s.apply(events).unwrap();
    let took = started.elapsed();
    let pinned = s.vault().layout_level("expand:");
    assert_eq!(pinned.len(), N);
    assert!(pinned.keys().all(|k| k.starts_with("B/")), "{pinned:?}");
    eprintln!("external move of {N} pinned notes, watcher batch: {took:?}");
    assert!(took < std::time::Duration::from_secs(1), "{took:?}");
}

/// M3b §4: which GV-02 rule chose a folder's index note — a pick is offered
/// only where rules 1–2 (named like the folder, `index.md`) give nothing.
#[test]
fn m3b_index_from_tells_which_rule_chose_the_index_note() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    let level = s.gv_children(&GvLevel::Vault).unwrap();
    assert_eq!(
        card(&level.cards, "Alpha").index_from,
        Some(IndexFrom::Named)
    );
    assert_eq!(card(&level.cards, "Beta").index_from, Some(IndexFrom::Only));
    assert_eq!(
        card(&level.cards, "Gamma").index_from,
        Some(IndexFrom::Picked)
    );
    assert_eq!(card(&level.cards, "Delta").index_from, None);
    assert_eq!(card(&level.cards, "Welcome.md").index_from, None);
    let alpha = s.gv_children(&GvLevel::Folder(vp("Alpha"))).unwrap();
    assert_eq!(
        card(&alpha.cards, "Alpha/Sub").index_from,
        Some(IndexFrom::Index)
    );
}

/// M3b §4, §6: picking a folder's index note writes `.liber/vault.json`
/// (other keys kept) and answers the folder's new card; clearing removes it.
#[test]
fn m3b_index_pick_set_writes_the_pick_and_answers_the_card() {
    let dir = vault();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{"version":1,"exclude":["Private/**"],"indexPicks":{"Gamma":"Gamma/b.md"},"future":{"x":1}}"#,
    )
    .unwrap();
    let (_c, s) = open(dir.path());
    let card = s
        .index_pick_set(&vp("Delta"), Some(&vp("Delta/x.md")))
        .unwrap();
    assert_eq!(card.path, "Delta");
    assert_eq!(card.kind, CardKind::Project);
    assert_eq!(card.index_page.as_deref(), Some("Delta/x.md"));
    assert_eq!(card.index_from, Some(IndexFrom::Picked));
    let json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join(".liber/vault.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(json["indexPicks"]["Delta"], "Delta/x.md");
    assert_eq!(json["indexPicks"]["Gamma"], "Gamma/b.md");
    assert_eq!(json["exclude"][0], "Private/**");
    assert_eq!(json["future"]["x"], 1);

    let cleared = s.index_pick_set(&vp("Delta"), None).unwrap();
    assert_eq!(cleared.index_page, None);
    let json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join(".liber/vault.json")).unwrap(),
    )
    .unwrap();
    assert!(json["indexPicks"].get("Delta").is_none());

    // Only a visible folder, and a page directly inside it.
    for (folder, page) in [
        ("Delta", "Delta/Inner/i.md"),
        ("Delta", "Alpha/note.md"),
        ("Delta", "Delta/attachments/pic.png"),
        ("Nope", "Nope/a.md"),
        ("Welcome.md", "Welcome.md"),
    ] {
        assert!(
            s.index_pick_set(&vp(folder), Some(&vp(page))).is_err(),
            "{folder} ← {page}"
        );
    }
}

/// A vault with no `.liber/` gets one only when something is picked (VLT-02).
#[test]
fn m3b_a_pick_creates_vault_json_lazily() {
    let dir = vault();
    std::fs::remove_dir_all(dir.path().join(".liber")).unwrap();
    let (_c, s) = open(dir.path());
    s.index_pick_set(&vp("Delta"), None).unwrap();
    assert!(
        !dir.path().join(".liber").exists(),
        "clearing nothing writes nothing"
    );
    s.index_pick_set(&vp("Delta"), Some(&vp("Delta/y.md")))
        .unwrap();
    assert!(dir.path().join(".liber/vault.json").exists());
}

/// M3b §4: picks follow renames of the folder and of the page.
#[test]
fn m3b_index_picks_follow_renames() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    s.rename(&vp("Gamma"), &vp("Gamma 2"), false).unwrap();
    assert_eq!(
        s.vault().index_picks().get("Gamma 2").map(String::as_str),
        Some("Gamma 2/b.md")
    );
    s.rename(&vp("Gamma 2/b.md"), &vp("Gamma 2/home.md"), false)
        .unwrap();
    assert_eq!(
        s.vault().index_picks().get("Gamma 2").map(String::as_str),
        Some("Gamma 2/home.md")
    );
    let level = s.gv_children(&GvLevel::Vault).unwrap();
    assert_eq!(
        card(&level.cards, "Gamma 2").index_page.as_deref(),
        Some("Gamma 2/home.md")
    );
}

/// Final review I4: a pick holds only while its page sits directly in its
/// folder. Moved out in the app, the pick is dropped (not carried along to
/// the page's new folder), and the folder falls back to the other rules.
#[test]
fn m3b_a_pick_is_dropped_when_its_page_moves_out_of_the_folder_in_app() {
    let dir = vault();
    let (_c, s) = open(dir.path());
    s.rename(&vp("Gamma/b.md"), &vp("Alpha/b.md"), false)
        .unwrap();
    assert_eq!(s.vault().index_picks().get("Gamma"), None, "dropped");
    let gamma = s.gv_children(&GvLevel::Vault).unwrap().cards;
    let gamma = card(&gamma, "Gamma");
    // Gamma/a.md is now its only page (rule 4).
    assert_eq!(gamma.index_page.as_deref(), Some("Gamma/a.md"));
    assert_eq!(gamma.index_from, Some(IndexFrom::Only));
}

/// Final review I4: the same when another program moves the page (the
/// watcher reports a delete and a create with the same content).
#[test]
fn m3b_a_pick_is_dropped_when_its_page_moves_out_of_the_folder_externally() {
    use liber_vault::WatchEvent;
    let dir = vault();
    write(dir.path(), "Gamma/c.md", "# Gamma C\n");
    let (_c, s) = open(dir.path());
    std::fs::rename(dir.path().join("Gamma/b.md"), dir.path().join("Delta/b.md")).unwrap();
    s.apply(vec![
        WatchEvent::Removed(vp("Gamma/b.md")),
        WatchEvent::Changed(vp("Delta/b.md")),
    ])
    .unwrap();
    assert_eq!(s.vault().index_picks().get("Gamma"), None, "dropped");
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;
    let gamma = card(&cards, "Gamma");
    assert_eq!(
        (gamma.index_page.as_deref(), gamma.index_from),
        (None, None)
    );
    // A move within the folder still follows.
    s.vault()
        .set_index_pick("Gamma", Some("Gamma/c.md"))
        .unwrap();
    s.rename(&vp("Gamma/c.md"), &vp("Gamma/home.md"), false)
        .unwrap();
    assert_eq!(
        s.vault().index_picks().get("Gamma").map(String::as_str),
        Some("Gamma/home.md")
    );
}

/// Final review I4: a hand-edited pick naming a page outside its folder is
/// ignored when read, and dropped by the next write of the picks.
#[test]
fn m3b_a_hand_written_pick_outside_its_folder_is_ignored() {
    let dir = vault();
    write(
        dir.path(),
        ".liber/vault.json",
        r#"{"version":1,"indexPicks":{"Gamma":"Gamma/b.md","Delta":"Welcome.md","Alpha/Sub":"Alpha/Sub/deep.md"}}"#,
    );
    let (_c, s) = open(dir.path());
    let cards = s.gv_children(&GvLevel::Vault).unwrap().cards;
    let delta = card(&cards, "Delta");
    assert_eq!(
        (delta.index_page.as_deref(), delta.index_from),
        (None, None)
    );
    assert_eq!(
        card(&cards, "Gamma").index_page.as_deref(),
        Some("Gamma/b.md")
    );
    // A pick of a page in a subfolder isn't one either.
    s.vault()
        .set_index_pick("Delta/Inner", Some("Delta/x.md"))
        .unwrap();
    let delta = s.gv_children(&GvLevel::Folder(vp("Delta"))).unwrap().cards;
    assert_eq!(
        card(&delta, "Delta/Inner").index_from,
        Some(IndexFrom::Only)
    );
    assert_eq!(
        card(&delta, "Delta/Inner").index_page.as_deref(),
        Some("Delta/Inner/i.md")
    );
    // The next write of the picks drops the invalid ones.
    s.index_pick_set(&vp("Delta"), Some(&vp("Delta/y.md")))
        .unwrap();
    let picks = s.vault().index_picks();
    assert_eq!(picks.get("Delta").map(String::as_str), Some("Delta/y.md"));
    assert_eq!(picks.get("Delta/Inner"), None);
    assert_eq!(picks.get("Gamma").map(String::as_str), Some("Gamma/b.md"));
    assert_eq!(
        picks.get("Alpha/Sub").map(String::as_str),
        Some("Alpha/Sub/deep.md")
    );
}

/// Final review I3: a folder card stands for its index note in a
/// relationship (M3b §2), so a relationship whose two ends are the visible
/// cards' own pages or index notes is a direct manual edge between those
/// cards (clickable, never hidden or capped as "from inside folders"). One
/// from any other page inside a folder stays aggregated; text links keep
/// their rules.
#[test]
fn m3b_relationships_of_folder_cards_index_notes_are_direct_edges() {
    let dir = vault();
    let r = dir.path();
    // Gamma's index note (picked) → a root page and Alpha's index note.
    write(
        r,
        "Gamma/b.md",
        "---\nrelated:\n  - \"[[zeta]]\"\n  - { link: \"[[Alpha]]\", label: sibling, directed: true }\n---\n# Gamma B\n",
    );
    // A root page → Beta's index note (its only page).
    write(
        r,
        "zeta.md",
        "---\nrelated:\n  - \"[[only]]\"\n---\n# Zeta\n\nBack to [[Welcome]].\n",
    );
    // Inside Alpha, the index note and another page both relate to zeta.
    write(
        r,
        "Alpha/Alpha.md",
        "---\nrelated:\n  - { link: \"[[zeta]]\", label: direct }\n---\n# Alpha home\n",
    );
    write(
        r,
        "Alpha/note.md",
        "---\nrelated:\n  - { link: \"[[zeta]]\", label: inside }\n---\n# A note\n",
    );
    let (_c, s) = open(r);
    let shown: Vec<String> = s
        .gv_children(&GvLevel::Vault)
        .unwrap()
        .cards
        .iter()
        .map(|c| c.path.clone())
        .collect();
    let edges = s.gv_edges(&shown).unwrap();

    let gz = edge(&edges, "Gamma", "zeta.md", EdgeKind::Manual);
    assert_eq!((gz.count, gz.aggregated), (1, false));
    let ga = edge(&edges, "Gamma", "Alpha", EdgeKind::Manual);
    assert_eq!((ga.from.as_str(), ga.to.as_str()), ("Gamma", "Alpha"));
    assert!(!ga.aggregated && ga.directed);
    assert_eq!(ga.label.as_deref(), Some("sibling"));
    let zb = edge(&edges, "zeta.md", "Beta", EdgeKind::Manual);
    assert_eq!((zb.count, zb.aggregated), (1, false));
    // Alpha's index note and a page inside it: one direct edge, counting
    // both, labelled from the direct relationship.
    let az = edge(&edges, "Alpha", "zeta.md", EdgeKind::Manual);
    assert_eq!((az.count, az.aggregated), (2, false));
    assert_eq!(az.label.as_deref(), Some("direct"));
    // Pages inside folders that aren't their index notes: aggregated.
    assert!(edge(&edges, "Gamma", "Welcome.md", EdgeKind::Manual).aggregated);
    assert!(edge(&edges, "Delta", "Welcome.md", EdgeKind::Manual).aggregated);
    // A text link from an index note is still a link from inside a folder.
    assert!(edge(&edges, "Beta", "Welcome.md", EdgeKind::Link).aggregated);

    // Only the inside page relates to zeta: aggregated, its own label.
    write(r, "Alpha/Alpha.md", "# Alpha home\n");
    s.apply(vec![liber_vault::WatchEvent::Changed(vp("Alpha/Alpha.md"))])
        .unwrap();
    let edges = s.gv_edges(&shown).unwrap();
    let az = edge(&edges, "Alpha", "zeta.md", EdgeKind::Manual);
    assert_eq!((az.count, az.aggregated), (1, true));
    assert_eq!(az.label.as_deref(), Some("inside"));
}

/// Final review m4: a page name holding `"` is linked single-quoted
/// (`'[[say "hi"]]'`, as the app writes it); liber-markdown indexes it, and
/// the relationship resolves to the page: a direct manual edge.
#[test]
fn m3b_a_single_quoted_link_with_double_quotes_is_indexed_and_resolves() {
    let dir = tempfile::tempdir().unwrap();
    let r = dir.path();
    write(r, "say \"hi\".md", "# Hi\n");
    write(
        r,
        "A.md",
        "---\nrelated:\n  - '[[say \"hi\"]]'\n  - { link: '[[say \"hi\"]]', label: x, directed: true }\n---\n# A\n",
    );
    let (_c, s) = open(r);
    assert_eq!(
        s.link_target(&vp("A.md"), &vp("say \"hi\".md")).unwrap(),
        "say \"hi\""
    );
    let edges = s.gv_edges(&visible(&["A.md", "say \"hi\".md"])).unwrap();
    let e = edge(&edges, "A.md", "say \"hi\".md", EdgeKind::Manual);
    assert_eq!((e.count, e.aggregated, e.directed), (2, false, true));
    assert_eq!(e.label.as_deref(), Some("x"));
}

/// M3b §6: the wiki target a relationship writes — the shortest unique one.
#[test]
fn m3b_link_target_is_the_shortest_unique_wiki_target() {
    let dir = vault();
    write(dir.path(), "Beta/note.md", "# Another note\n");
    let (_c, s) = open(dir.path());
    assert_eq!(
        s.link_target(&vp("Welcome.md"), &vp("zeta.md")).unwrap(),
        "zeta"
    );
    // Two `note` pages: `[[note]]` resolves to the first by path order, so
    // the other one needs its folder (as `link_suggest` writes it).
    assert_eq!(
        s.link_target(&vp("Welcome.md"), &vp("Alpha/note.md"))
            .unwrap(),
        "note"
    );
    assert_eq!(
        s.link_target(&vp("Welcome.md"), &vp("Beta/note.md"))
            .unwrap(),
        "Beta/note"
    );
    assert!(matches!(
        s.link_target(&vp("Welcome.md"), &vp("missing.md")),
        Err(SessionError::NotIndexed(_))
    ));
}
