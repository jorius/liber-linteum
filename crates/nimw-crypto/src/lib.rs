//! Vault encryption core (encryption phase E1).

mod error;
mod kdf;
mod keys;
mod recovery;

pub use error::{CryptoError, Result};
pub use kdf::{Argon2Params, passphrase_kek};
pub use keys::{Secret, Subkeys, VaultId, VaultKey};
pub use recovery::RecoveryCode;
