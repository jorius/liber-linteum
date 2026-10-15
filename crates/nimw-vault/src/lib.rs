//! Vault filesystem model: scanning, watching, atomic writes, trash.
//! Every path crossing this crate's boundary is vault-relative ([`VaultPath`]).

mod config;
mod cover_height;
mod cover_side;
mod error;
mod fsops;
mod hash;
mod layout;
mod link_format;
mod page_width;
mod path;
mod scan;
mod vault;
mod watch;

pub use config::{AttachmentConfig, AttachmentPolicy};
pub use cover_height::{MAX_COVER_HEIGHT, MIN_COVER_HEIGHT};
pub use cover_side::{CoverSide, MAX_COVER_WIDTH, MIN_COVER_WIDTH};
pub use error::{Result, VaultError};
pub use fsops::TMP_MARKER;
pub use hash::Hash;
pub use layout::CardPosition;
pub use link_format::{LinkFormat, LinkFormats};
pub use page_width::{PageWidth, PageWidths};
pub use path::VaultPath;
pub use scan::{Entry, EntryKind, Scan};
pub use vault::Vault;
pub use watch::{DEBOUNCE, WatchEvent, Watcher};

/// VLT-05: dot-entries (`.obsidian`, `.git`, `.nimw`, …) are ignored everywhere.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::is_hidden_name;

    #[test]
    fn vlt_05_dot_folders_are_hidden() {
        for name in [".obsidian", ".git", ".nimw", ".trash", ".", ".."] {
            assert!(is_hidden_name(name), "{name} should be hidden");
        }
    }

    #[test]
    fn vlt_05_regular_names_are_visible() {
        for name in ["Projects", "not.hidden", "notes.md", ""] {
            assert!(!is_hidden_name(name), "{name:?} should be visible");
        }
    }
}
