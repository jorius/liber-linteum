//! The single error type every command returns (M1b spec §2.6), serialized as
//! `{ "kind": "...", "message": "..." }` for the UI to translate.

use liber_session::SessionError;
use liber_vault::VaultError;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NoVault,
    NotFound,
    AlreadyExists,
    NotEmpty,
    InvalidName,
    Conflict,
    OutsideVault,
    UnsafeRewrite,
    Watch,
    Io,
    /// The file is not valid UTF-8 text.
    Binary,
    /// A URL or link kind the app refuses to open.
    InvalidUrl,
    /// Refused by a rule: attachments set by Obsidian, a path no native drop
    /// granted (M2c §8).
    NotPermitted,
    /// A dropped path that isn't a regular file (a folder).
    NotAFile,
    /// A pasted file over the size cap (M2c §7.3).
    TooLarge,
    /// Not a text file the app opens (M4b part 2 §6).
    NotAText,
    /// A value the command refuses: a word or dictionary id (spell checking).
    InvalidInput,
    /// The vault is encrypted and locked: unlock it first (E3).
    Locked,
    /// The passphrase or recovery code opens no slot, or the header's MAC
    /// failed (E3 Task 1 ruling: the UI says both).
    WrongSecret,
    /// The vault's header is at a lower epoch than this device has seen: an
    /// old header put back (spec §16 #18). Never opened.
    Rollback,
    /// An encrypted vault that can't be read: a damaged or unparseable
    /// header, a missing `d/`, or ciphertext that fails to decrypt.
    Damaged,
    /// Encrypt in place (encryption UX §8.2): another device's conversion
    /// of this folder is under way. Nothing was touched.
    ConvertingElsewhere,
    /// Encrypt in place (§8.3): files changed while encrypting, so it was
    /// undone.
    ChangedDuringConvert,
    /// Encrypt in place: Stop and undo.
    Cancelled,
    /// Encrypt in place (final review): another device's conversion is past
    /// the point where it can be undone here; the message is the folder.
    ConvertingElsewhereFinishing,
    /// Encrypt in place: a window shows a file from the folder.
    ConvertWindowsOpen,
    /// Encrypt in place: another folder is being encrypted.
    ConvertBusy,
    /// Encrypt in place: this folder is being encrypted right now.
    ConvertActive,
    /// Encrypt in place: the folder is part-way through a conversion.
    ConvertPending,
    /// Encrypt in place: a folder never encrypted in place; the message is it.
    ConvertRefusedFolder,
    /// Encrypt in place: the folder is inside the encrypted vault in the message.
    ConvertInsideVault,
    /// Encrypt in place: recovery stopped rather than overwrite the path in the message.
    ConvertCollision,
    /// Encrypt in place: a file didn't read back the same; it was undone.
    ConvertMismatch,
    /// Encrypt in place: the undo of a failed run failed too; the message is
    /// the folder, whose originals are safe in `.liber-plain`.
    ConvertUndoFailed,
    /// Encrypt in place: a failed run past `staged` couldn't finish yet; the
    /// next open of the folder (the message) does.
    ConvertFinishFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
    /// Present on `conflict` from `page_write`: what is on disk now.
    #[serde(flatten)]
    pub conflict: Option<ConflictInfo>,
}

/// The file's current content when a compare-and-swap write was refused (M2a §3.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub current_text: String,
    pub current_hash: String,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
            conflict: None,
        }
    }

    pub fn no_vault() -> CommandError {
        CommandError::new(ErrorKind::NoVault, "no vault is open")
    }
}

impl From<VaultError> for CommandError {
    fn from(e: VaultError) -> CommandError {
        let kind = match &e {
            VaultError::NotFound(_) => ErrorKind::NotFound,
            VaultError::AlreadyExists(_) => ErrorKind::AlreadyExists,
            VaultError::Conflict { .. } => ErrorKind::Conflict,
            VaultError::OutsideVault(_) => ErrorKind::OutsideVault,
            VaultError::Watch(_) => ErrorKind::Watch,
            VaultError::NotEmpty(_) => ErrorKind::NotEmpty,
            VaultError::NotPermitted(_) => ErrorKind::NotPermitted,
            VaultError::Locked => ErrorKind::Locked,
            VaultError::WrongSecret => ErrorKind::WrongSecret,
            // `Crypto` is data that doesn't decrypt or parse (a damaged or
            // modified file or header), never a disk failure: `damaged`.
            VaultError::Crypto(_) | VaultError::Damaged(_) => ErrorKind::Damaged,
            VaultError::NotUtf8(_) | VaultError::InvalidConfig { .. } | VaultError::Io { .. } => {
                ErrorKind::Io
            }
        };
        CommandError::new(kind, e.to_string())
    }
}

impl From<SessionError> for CommandError {
    fn from(e: SessionError) -> CommandError {
        match e {
            SessionError::Vault(v) => v.into(),
            SessionError::Index(i) => CommandError::new(ErrorKind::Io, i.to_string()),
            SessionError::NotIndexed(p) => {
                CommandError::new(ErrorKind::NotFound, format!("not in the vault: {p}"))
            }
            SessionError::InvalidName(n) => {
                CommandError::new(ErrorKind::InvalidName, format!("invalid name: {n}"))
            }
            SessionError::UnsafeRewrite(m) => CommandError::new(ErrorKind::UnsafeRewrite, m),
            SessionError::NotPermitted(m) => CommandError::new(ErrorKind::NotPermitted, m),
            SessionError::NotAFile(p) => {
                CommandError::new(ErrorKind::NotAFile, format!("not a file: {p}"))
            }
            SessionError::NotAText(p) => {
                CommandError::new(ErrorKind::NotAText, format!("not a text file: {p}"))
            }
        }
    }
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> CommandError {
        // A stream read from an encrypted vault fails with why: the vault
        // locked, or the file is damaged (a decrypted copy, review M5).
        let inner = e.get_ref();
        let kind = if inner
            .and_then(|i| i.downcast_ref::<VaultError>())
            .is_some_and(|v| matches!(v, VaultError::Locked))
        {
            ErrorKind::Locked
        } else if inner.is_some_and(|i| i.is::<liber_crypto::CryptoError>()) {
            ErrorKind::Damaged
        } else {
            ErrorKind::Io
        };
        CommandError::new(kind, e.to_string())
    }
}

impl From<liber_vault::convert::ConvertError> for CommandError {
    fn from(e: liber_vault::convert::ConvertError) -> CommandError {
        use liber_vault::convert::ConvertError as C;
        // The UI's copy names what the path-carrying kinds hold.
        let (kind, message) = match e {
            C::Vault(v) => return v.into(),
            C::Blocked(_) | C::Refused(_) => (ErrorKind::NotPermitted, e.to_string()),
            C::Cancelled => (ErrorKind::Cancelled, e.to_string()),
            C::Changed(_) => (ErrorKind::ChangedDuringConvert, e.to_string()),
            C::Pending => (ErrorKind::ConvertPending, e.to_string()),
            C::Folder(p) => (ErrorKind::ConvertRefusedFolder, p),
            C::InsideVault(p) => (ErrorKind::ConvertInsideVault, p),
            C::Collision(p) => (ErrorKind::ConvertCollision, p),
            C::Mismatch(p) => (ErrorKind::ConvertMismatch, p),
        };
        CommandError::new(kind, message)
    }
}

pub type CmdResult<T> = Result<T, CommandError>;
