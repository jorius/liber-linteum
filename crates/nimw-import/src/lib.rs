//! Notion export importer (M7): a Notion "Markdown & CSV" export zip
//! becomes a new vault. See `docs/superpowers/specs/2026-10-18-m7-notion-import-design.md`.

mod archive;
mod database;
mod import;
mod markdown;
mod names;

pub use archive::{Entry, Export, Limits};
pub use database::{Table, parse_csv};
pub use import::{PREVIEW_WARNINGS, Plan, Preview, Report, plan, suggested_name, write};
pub use markdown::{Resolver, Target, convert, strip_properties};
pub use names::{NameMap, clean_component};

/// Why an import couldn't go on.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("not a readable zip: {0}")]
    Zip(String),
    /// A limit or a safety rule refused the export.
    #[error("{0}")]
    Limit(String),
    #[error("{0} already exists")]
    Exists(String),
    /// Stopped by the user before anything was written.
    #[error("the import was cancelled")]
    Cancelled,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Vault(#[from] nimw_vault::VaultError),
}

const NOTION_ID_LEN: usize = 32;

/// IMP-02: remove the ` <32 lowercase hex>` id Notion appends to exported
/// file and folder names, keeping any extension or `_all` suffix.
pub fn strip_notion_id(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut found = None;
    for (i, &b) in bytes.iter().enumerate() {
        if b != b' ' {
            continue;
        }
        let id_end = i + 1 + NOTION_ID_LEN;
        if id_end > bytes.len() {
            break;
        }
        let is_id = bytes[i + 1..id_end]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c));
        let at_boundary = matches!(bytes.get(id_end), None | Some(b'.') | Some(b'_'));
        if is_id && at_boundary {
            found = Some(i);
        }
    }
    match found {
        // ' ' and hex digits are ASCII, so these byte indices are char boundaries.
        Some(i) => format!("{}{}", &name[..i], &name[i + 1 + NOTION_ID_LEN..]),
        None => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::strip_notion_id;

    const ID: &str = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

    #[test]
    fn imp_02_strips_id_from_page_file() {
        assert_eq!(
            strip_notion_id(&format!("Generator Rex {ID}.md")),
            "Generator Rex.md"
        );
    }

    #[test]
    fn imp_02_strips_id_from_folder() {
        assert_eq!(strip_notion_id(&format!("Projects {ID}")), "Projects");
    }

    #[test]
    fn imp_02_keeps_database_csv_suffix() {
        assert_eq!(
            strip_notion_id(&format!("Tasks {ID}_all.csv")),
            "Tasks_all.csv"
        );
    }

    #[test]
    fn imp_02_handles_dots_and_non_ascii_in_name() {
        assert_eq!(
            strip_notion_id(&format!("v1.2 canción {ID}.md")),
            "v1.2 canción.md"
        );
    }

    #[test]
    fn imp_02_leaves_non_ids_untouched() {
        for name in [
            "Plain.md",
            "Short abc123.md",
            "Upper 1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D.md",
            "Glued1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md",
            "Trailing 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6dx.md",
            "",
        ] {
            assert_eq!(strip_notion_id(name), name);
        }
    }
}
