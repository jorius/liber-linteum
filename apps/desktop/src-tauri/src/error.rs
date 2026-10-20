//! The single error type every command returns (M1b spec §2.6), serialized as
//! `{ "kind": "...", "message": "..." }` for the UI to translate.

use nimw_session::SessionError;
use nimw_vault::VaultError;
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
        CommandError::new(ErrorKind::Io, e.to_string())
    }
}

pub type CmdResult<T> = Result<T, CommandError>;
