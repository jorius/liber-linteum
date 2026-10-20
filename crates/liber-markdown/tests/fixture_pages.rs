use liber_markdown::{LinkKind, parse_page};
use std::path::Path;

fn fixture(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/vaults")
        .join(rel);
    std::fs::read_to_string(path).unwrap()
}

#[test]
fn pg_04_05_rex_draft_fixture() {
    let src = fixture("obsidian-basic/Character Design/rex-draft.md");
    let m = parse_page(&src, "rex-draft");
    let links: Vec<_> = m
        .links
        .iter()
        .map(|l| (l.kind, l.target.as_str()))
        .collect();
    assert_eq!(
        links,
        vec![
            (LinkKind::FrontmatterCover, "assets/rex-cover.png"),
            (LinkKind::FrontmatterRelated, "Sparda"),
            (LinkKind::FrontmatterRelated, "Game 1"),
            (LinkKind::Embed, "rex-turnaround.png"),
            (LinkKind::Embed, "voice-reference.mp3"),
            (LinkKind::Markdown, "DMC/Sparda.md"),
            (LinkKind::Markdown, "/Game Design/Game 1.md"),
            (LinkKind::Markdown, "../Game Design/Game 1.md"),
        ]
    );
    assert_eq!(
        m.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        vec!["character", "redesign"]
    );
    assert!(m.has_image && m.has_audio);
    assert!(
        m.excerpt.starts_with("Teen agent who builds machines."),
        "{}",
        m.excerpt
    );
}

#[test]
fn pg_05_edge_case_code_fixture_has_one_real_link() {
    let src = fixture("edge-cases/code.md");
    let m = parse_page(&src, "code");
    assert_eq!(
        m.links
            .iter()
            .map(|l| l.target.as_str())
            .collect::<Vec<_>>(),
        vec!["target"]
    );
    assert_eq!(
        m.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        vec!["real-tag"]
    );
}
