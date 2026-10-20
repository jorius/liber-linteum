use liber_index::IndexError;
use liber_vault::VaultError;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error("not in the index: {0}")]
    NotIndexed(String),
    #[error("invalid name: {0}")]
    InvalidName(String),
    /// A link rewrite was refused because it would corrupt the file or change
    /// where a link points; the file was left unchanged.
    #[error("not rewritten: {0}")]
    UnsafeRewrite(String),
    /// Refused by a rule of the vault (e.g. attachments set by Obsidian).
    #[error("not permitted: {0}")]
    NotPermitted(String),
    /// A dropped path that isn't a regular file (e.g. a folder).
    #[error("not a file: {0}")]
    NotAFile(String),
    /// Not a text file the app opens (M4b part 2 §6): another kind of name,
    /// or content that isn't UTF-8, holds NUL bytes or is over 2 MB.
    #[error("not a text file: {0}")]
    NotAText(String),
}

pub type Result<T> = std::result::Result<T, SessionError>;
