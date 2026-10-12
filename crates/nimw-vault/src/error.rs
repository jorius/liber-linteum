use crate::Hash;

/// Errors from vault filesystem operations. Paths are vault-relative strings.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("file changed on disk: {path}")]
    Conflict { path: String, current: Hash },
    #[error("path is outside the vault: {0}")]
    OutsideVault(String),
    #[error("not valid UTF-8: {0}")]
    NotUtf8(String),
    #[error("invalid config {file}: {reason}")]
    InvalidConfig { file: String, reason: String },
    #[error("I/O error on {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("file watcher error: {0}")]
    Watch(String),
}

pub type Result<T> = std::result::Result<T, VaultError>;
