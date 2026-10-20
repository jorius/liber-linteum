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
    Io(std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Unwraps a `CryptoError` that a `Read`/`Seek` impl carried inside an `io::Error`.
impl From<std::io::Error> for CryptoError {
    fn from(e: std::io::Error) -> Self {
        if e.get_ref().is_some_and(|i| i.is::<CryptoError>()) {
            let inner = e.into_inner().expect("checked above");
            return *inner.downcast::<CryptoError>().expect("checked above");
        }
        CryptoError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, CryptoError>;
