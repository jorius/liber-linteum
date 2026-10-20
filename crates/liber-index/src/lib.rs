//! SQLite cache of one vault (spec §5): files, pages, tags, links.
//! Never reads or writes vault files; `liber-session` feeds it.

mod fold;
mod index;
mod rows;
mod schema;
mod search;
mod text;

pub use fold::fold;
pub use index::{Index, IndexError, Result, Tx};
pub use rows::{
    CardRow, FileKind, FileRow, LinkCandidate, LinkRow, PageLink, PageRow, Stat, TreeNode,
};
pub use schema::SCHEMA_VERSION;
pub use search::{
    FacetCount, FacetPage, Facets, FtsText, MAX_LIMIT, RECENT, SearchHit, SearchPage, SearchQuery,
    SnippetPart, fts_query,
};

use sha2::{Digest, Sha256};
use std::path::Path;

/// Folder name for a vault's index cache inside the OS cache dir
/// (`liber/<name>/index.sqlite`): first 16 hex chars of SHA-256 of the
/// canonical absolute vault path. Callers must pass a canonicalized path.
pub fn cache_dir_name(vault_abs_path: &Path) -> String {
    let digest = Sha256::digest(vault_abs_path.as_os_str().as_encoded_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::cache_dir_name;
    use std::path::Path;

    #[test]
    fn cache_name_is_sha256_prefix_of_path() {
        assert_eq!(
            cache_dir_name(Path::new("/Users/ana/Notes")),
            "33055923156cea57"
        );
        assert_eq!(
            cache_dir_name(Path::new("/Users/ana/Notes2")),
            "5e2f1a1b5dd864e0"
        );
    }

    #[test]
    fn cache_name_is_16_lowercase_hex_chars() {
        let name = cache_dir_name(Path::new("/tmp/Bóveda con espacios"));
        assert_eq!(name.len(), 16);
        assert!(
            name.chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        );
    }
}
