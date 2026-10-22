//! Vault filesystem model: scanning, watching, atomic writes, trash.
//! Every path crossing this crate's boundary is vault-relative ([`VaultPath`]).

mod bin;
mod config;
mod cover_height;
mod cover_side;
mod error;
mod favorite;
mod folder_sort;
mod fsops;
mod hash;
mod home;
mod icon;
mod layout;
mod link_format;
mod meta_dir;
mod page_width;
mod path;
mod scan;
mod scratch;
mod spelling;
mod storage;
mod vault;
mod watch;

pub use bin::{Bin, BinRecord};
pub use config::{AttachmentConfig, AttachmentPolicy};
pub use cover_height::{MAX_COVER_HEIGHT, MIN_COVER_HEIGHT};
pub use cover_side::{CoverSide, MAX_COVER_WIDTH, MIN_COVER_WIDTH};
pub use error::{Result, VaultError};
pub use folder_sort::FolderSort;
pub use hash::Hash;
pub use home::Home;
pub use icon::vault_icon_at;
pub use layout::CardPosition;
pub use link_format::{LinkFormat, LinkFormats};
pub use meta_dir::{LEGACY_META_DIR, META_DIR, WARN_BOTH, WARN_UNMOVED};
pub use page_width::{PageWidth, PageWidths};
pub use path::VaultPath;
pub use scan::{Entry, EntryKind, Scan};
pub use scratch::DEFAULT_SCRATCH_FOLDER;
pub use storage::plain::TMP_MARKER;
pub use storage::{
    Child, EncryptedStorage, Follow, HEADER_FILE, Kind, Meta, NewFile, OsUse, PlainStorage,
    RECORDING_DIR, RawEvent, Reach, ReadSeek, Reader, Replace, Storage, UnlockReport, VaultKind,
    WatchGuard, is_empty_for_create, is_encrypted_vault, remove_new_vault, trash_header_copy,
    vault_kind,
};
#[cfg(feature = "test-params")]
pub use storage::{TEST_PASSPHRASE, seal_in_place};
pub use storage::{convert, decrypt};
pub use vault::Vault;
pub use watch::{DEBOUNCE, WatchEvent, Watcher};

/// VLT-05: dot-entries (`.obsidian`, `.git`, `.liber`, …) are ignored everywhere.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

/// The vault's Archive (M5b §5.3): archived items keep their path below it,
/// and it is the one hidden folder the vault scans, watches and serves.
pub const ARCHIVE_DIR: &str = ".archive";
/// The vault's own Trash (M5b §5.1), as Obsidian's "Move to Obsidian trash".
pub const TRASH_DIR: &str = ".trash";

/// The Archive itself or something in it.
pub fn is_archived(path: &str) -> bool {
    path.strip_prefix(ARCHIVE_DIR)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// A vault path the app doesn't read: one with a hidden component, except a
/// leading [`ARCHIVE_DIR`].
pub fn is_hidden_path(path: &str) -> bool {
    let rest = match path.strip_prefix(ARCHIVE_DIR) {
        Some("") => return false,
        Some(rest) if rest.starts_with('/') => &rest[1..],
        _ => path,
    };
    rest.split('/').any(is_hidden_name)
}

#[cfg(test)]
mod tests {
    use super::is_hidden_name;

    #[test]
    fn vlt_05_dot_folders_are_hidden() {
        for name in [
            ".obsidian",
            ".git",
            super::META_DIR,
            super::LEGACY_META_DIR,
            ".trash",
            ".",
            "..",
        ] {
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
