use nimw_index::IndexError;
use nimw_vault::VaultError;

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
}

pub type Result<T> = std::result::Result<T, SessionError>;
