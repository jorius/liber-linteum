use nimw_markdown::{LinkKind, parse_page};

#[test]
fn pg_02_03_04_frontmatter_through_parse_page() {
    let src = "---\nsubtitle: Hero\ncover: assets/c.png\ncover-y: 40\ntags: [a, b]\nrelated:\n  - \"[[Sparda]]\"\n---\n# Rex\n";
    let m = parse_page(src, "rex-draft");
    assert_eq!(m.title, "Rex");
    assert_eq!(m.subtitle.as_deref(), Some("Hero"));
    assert_eq!(m.cover.as_deref(), Some("assets/c.png"));
    assert_eq!(m.cover_y, Some(40));
    assert_eq!(
        m.tags.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(
        m.links.iter().map(|l| l.kind).collect::<Vec<_>>(),
        vec![LinkKind::FrontmatterCover, LinkKind::FrontmatterRelated]
    );
    assert_eq!(&src[m.links[1].range.clone()], "Sparda");
    assert!(
        parse_page("---\ntags: [x\n---\n", "bad")
            .frontmatter_error
            .is_some()
    );
}
