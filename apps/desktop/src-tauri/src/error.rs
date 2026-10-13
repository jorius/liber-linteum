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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
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
        }
    }
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> CommandError {
        CommandError::new(ErrorKind::Io, e.to_string())
    }
}

pub type CmdResult<T> = Result<T, CommandError>;
