use liber_markdown::{FileSet, LinkKind, link_key, resolve, shortest_unique_target};

#[test]
fn pg_05_resolve_public_api() {
    let files = FileSet::new(["Ideas.md", "Projects/Ideas.md", "img/a.png"].map(String::from));
    assert_eq!(
        resolve(LinkKind::Wiki, "Ideas", "Projects/x.md", &files).as_deref(),
        Some("Projects/Ideas.md")
    );
    assert_eq!(
        resolve(LinkKind::Embed, "a.png", "x.md", &files).as_deref(),
        Some("img/a.png")
    );
    assert_eq!(
        resolve(LinkKind::Markdown, "../Ideas.md", "Projects/x.md", &files).as_deref(),
        Some("Ideas.md")
    );
    assert_eq!(
        shortest_unique_target("Projects/Ideas.md", "x.md", &files, LinkKind::Wiki, false),
        "Projects/Ideas"
    );
    assert_eq!(link_key("Projects/Ideas.md"), link_key("IDEAS"));
}
