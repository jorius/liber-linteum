//! Vault encryption core (encryption phase E1).

mod error;
mod header;
mod kdf;
mod keyring;
mod keys;
mod names;
mod recovery;
mod slots;
mod stream;

pub use error::{CryptoError, Result};
pub use header::{Unlocked, VaultHeader};
pub use kdf::{Argon2Params, passphrase_kek};
pub use keyring::{KeyringFile, KeyringPublic, KeyringSecret};
pub use keys::{Secret, Subkeys, VaultId, VaultKey};
pub use names::{
    ConflictName, FolderId, LONG_NAME_LIMIT, NameCodec, ShortName, shorten, strip_conflict,
};
pub use recovery::RecoveryCode;
pub use slots::{NewSlot, Slot, SlotKind, Unlock};
pub use stream::{
    CHUNK_LEN, HEADER_LEN, Salvaged, StreamReader, StreamWriter, TAG_LEN, header_epoch, salvage,
};
