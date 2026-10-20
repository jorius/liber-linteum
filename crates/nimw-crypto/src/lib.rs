//! Vault encryption core (encryption phase E1).

mod error;
mod keys;

pub use error::{CryptoError, Result};
pub use keys::{Secret, Subkeys, VaultId, VaultKey};
