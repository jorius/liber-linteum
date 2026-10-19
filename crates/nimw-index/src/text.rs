//! What search reads of a page (M5 §2): the six `page_text` columns.

use nimw_markdown::{LinkKind, PageMeta, external_target};

/// The file name without `.md`.
pub(crate) fn name_column(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.len().checked_sub(3) {
        Some(i) if i > 0 && name.is_char_boundary(i) && name[i..].eq_ignore_ascii_case(".md") => {
            name[..i].to_string()
        }
        _ => name.to_string(),
    }
}

/// The folders a page sits in, outermost (the project) first, space-separated.
pub(crate) fn folders_column(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].replace('/', " "),
        None => String::new(),
    }
}

/// The base names of the files a page links to, `.md` dropped. Covers and
/// files outside the vault (`file:` URLs, Windows and UNC paths, relative
/// paths above the root) aren't vault links (M5 §10.8); a `/`-leading
/// target is, as Obsidian reads it from the vault root first.
fn links_column(path: &str, meta: &PageMeta) -> String {
    let mut names: Vec<String> = Vec::new();
    for link in &meta.links {
        if link.kind == LinkKind::FrontmatterCover || link.target.is_empty() {
            continue;
        }
        let outside = !link.target.starts_with('/')
            && external_target(link.kind, &link.target, path).is_some();
        if outside {
            continue;
        }
        let base = link
            .target
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&link.target);
        let name = name_column(base);
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names.join(" ")
}

/// `[title, name, folders, tags, links, body]` for `page_text`.
pub(crate) fn text_columns(path: &str, meta: &PageMeta) -> [String; 6] {
    let tags: Vec<&str> = meta.tags.iter().map(|t| t.text.as_str()).collect();
    [
        meta.title.clone(),
        name_column(path),
        folders_column(path),
        tags.join(" "),
        links_column(path, meta),
        meta.body_text.clone(),
    ]
}

/// `[title, name, folders, tags, links, body]` for a text file (batch 6):
/// titled by its file name, extension kept; no tags or links.
pub(crate) fn text_file_columns(path: &str, body: &str) -> [String; 6] {
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    [
        name.clone(),
        name,
        folders_column(path),
        String::new(),
        String::new(),
        body.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use nimw_markdown::parse_page;

    #[test]
    fn columns_of_a_page() {
        let src = "---\ntags: [a, b/c]\ncover: pics/c.png\n---\n# T\n\n[[Folder/Other Page]] [x](../../../out.pdf) [y](</Docs/In Vault.md>) [z](file:///u/z.pdf) [w](D:\\w.pdf) ![[pic.png]] [[Other Page]]\n";
        let cols = text_columns("P/Q/Me.md", &parse_page(src, "Me"));
        assert_eq!(cols[0], "T");
        assert_eq!(cols[1], "Me");
        assert_eq!(cols[2], "P Q");
        assert_eq!(cols[3], "a b/c");
        assert_eq!(cols[4], "Other Page In Vault pic.png");
    }

    #[test]
    fn names_and_folders() {
        assert_eq!(name_column("a/b/Note.MD"), "Note");
        assert_eq!(name_column(".md"), ".md");
        assert_eq!(name_column("x.png"), "x.png");
        assert_eq!(name_column("ñandú.md"), "ñandú");
        assert_eq!(folders_column("Root.md"), "");
        assert_eq!(folders_column("A/B c/D.md"), "A B c");
    }
}
