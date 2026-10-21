//! Vault encryption core (encryption phase E1).

mod error;
#[doc(hidden)]
pub mod fuzzing;
mod header;
mod kdf;
mod keyring;
mod keys;
mod names;
mod recovery;
mod slots;
mod stream;
#[cfg(test)]
mod vectors;

pub use error::{CryptoError, Result};
pub use header::{MAX_HEADER_BYTES, MergeOutcome, Unlocked, VaultHeader};
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
    salvage_to,
};
/// Wipes a passphrase or recovery code on drop: what callers hold them in
/// (`RecoveryCode::to_display` returns one), so they need no `zeroize` edge.
pub use zeroize::Zeroizing;
