/// Everything the crypto core can fail with.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("bad format: {0}")]
    BadFormat(&'static str),
    #[error("unsupported version {0}")]
    UnsupportedVersion(u32),
    #[error("authentication failed")]
    Authentication,
    #[error("truncated input")]
    Truncated,
    #[error("bad parameters: {0}")]
    Params(&'static str),
    #[error("invalid recovery code")]
    RecoveryCode,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, CryptoError>;
