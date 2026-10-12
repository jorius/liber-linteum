//! Vault filesystem model: scanning, watching, atomic writes, trash.
//! Every path crossing this crate's boundary is vault-relative ([`VaultPath`]).

mod config;
mod error;
mod hash;
mod path;
mod scan;
mod vault;

pub use config::AttachmentPolicy;
pub use error::{Result, VaultError};
pub use hash::Hash;
pub use path::VaultPath;
pub use scan::{Entry, EntryKind, Scan};
pub use vault::Vault;

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
