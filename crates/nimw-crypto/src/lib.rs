//! Vault encryption core (encryption phase E1).

mod error;
mod header;
mod kdf;
mod keyring;
mod keys;
mod recovery;
mod slots;

pub use error::{CryptoError, Result};
pub use header::{Unlocked, VaultHeader};
pub use kdf::{Argon2Params, passphrase_kek};
pub use keyring::{KeyringFile, KeyringPublic, KeyringSecret};
pub use keys::{Secret, Subkeys, VaultId, VaultKey};
pub use recovery::RecoveryCode;
pub use slots::{NewSlot, Slot, SlotKind, Unlock};
