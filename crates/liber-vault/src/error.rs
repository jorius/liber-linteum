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
    #[error("folder is not empty: {0}")]
    NotEmpty(String),
    #[error("the vault is locked")]
    Locked,
    #[error("wrong passphrase or recovery code")]
    WrongSecret,
    #[error("encryption error: {0}")]
    Crypto(String),
    /// Signs of an encrypted vault that can't be one (header or `d/` missing or
    /// unreadable): never opened as plain.
    #[error("damaged encrypted vault: {0}")]
    Damaged(String),
    /// Refused by design: an encrypted vault has no plaintext OS path.
    #[error("not permitted: {0}")]
    NotPermitted(String),
}

pub type Result<T> = std::result::Result<T, VaultError>;

pub(crate) fn io_err(path: impl Into<String>, source: std::io::Error) -> VaultError {
    let path = path.into();
    if carries_locked(&source) {
        return VaultError::Locked;
    }
    match source.kind() {
        std::io::ErrorKind::NotFound => VaultError::NotFound(path),
        std::io::ErrorKind::AlreadyExists => VaultError::AlreadyExists(path),
        _ => VaultError::Io { path, source },
    }
}

/// Whether `e` failed because the vault locked: a `Locked` inside it, however
/// deeply wrapped as an I/O error (a lock during a streamed copy, review M6).
fn carries_locked(e: &std::io::Error) -> bool {
    match e.get_ref().and_then(|e| e.downcast_ref::<VaultError>()) {
        Some(VaultError::Locked) => true,
        Some(VaultError::Io { source, .. }) => carries_locked(source),
        _ => false,
    }
}
