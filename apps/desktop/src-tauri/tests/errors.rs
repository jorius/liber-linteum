//! IPC error mapping (M1b spec §2.6).

use liber_desktop::error::{CommandError, ErrorKind};
use liber_session::SessionError;
use liber_vault::{Hash, VaultError};

#[test]
fn errors_serialize_as_kind_and_message() {
    let e = CommandError::new(ErrorKind::NotEmpty, "folder is not empty");
    assert_eq!(
        serde_json::to_value(&e).unwrap(),
        serde_json::json!({ "kind": "notEmpty", "message": "folder is not empty" })
    );
    assert_eq!(
        serde_json::to_value(CommandError::no_vault()).unwrap()["kind"],
        "noVault"
    );
}

#[test]
fn session_and_vault_errors_map_to_kinds() {
    let kind = |e: SessionError| CommandError::from(e).kind;
    assert_eq!(
        kind(SessionError::Vault(VaultError::NotFound("a".into()))),
        ErrorKind::NotFound
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::AlreadyExists("a".into()))),
        ErrorKind::AlreadyExists
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::Conflict {
            path: "a".into(),
            current: Hash::of(b"x")
        })),
        ErrorKind::Conflict
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::OutsideVault("../x".into()))),
        ErrorKind::OutsideVault
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::Watch("w".into()))),
        ErrorKind::Watch
    );
    assert_eq!(
        kind(SessionError::NotIndexed("a".into())),
        ErrorKind::NotFound
    );
    assert_eq!(
        kind(SessionError::InvalidName("a#b".into())),
        ErrorKind::InvalidName
    );
    assert_eq!(
        kind(SessionError::UnsafeRewrite("x".into())),
        ErrorKind::UnsafeRewrite
    );
    // M2c: rules of the vault (attachments set by Obsidian) and dropped folders.
    assert_eq!(
        kind(SessionError::NotPermitted("x".into())),
        ErrorKind::NotPermitted
    );
    assert_eq!(
        kind(SessionError::NotAFile("/tmp/dir".into())),
        ErrorKind::NotAFile
    );
    assert_eq!(
        serde_json::to_value(CommandError::new(ErrorKind::TooLarge, "x")).unwrap()["kind"],
        "tooLarge"
    );
    // E3: encrypted vaults' own kinds.
    assert_eq!(
        kind(SessionError::Vault(VaultError::Locked)),
        ErrorKind::Locked
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::WrongSecret)),
        ErrorKind::WrongSecret
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::Damaged("x".into()))),
        ErrorKind::Damaged
    );
    assert_eq!(
        kind(SessionError::Vault(VaultError::Crypto(
            "a.md: damaged".into()
        ))),
        ErrorKind::Damaged
    );
    for (k, name) in [
        (ErrorKind::Locked, "locked"),
        (ErrorKind::WrongSecret, "wrongSecret"),
        (ErrorKind::Rollback, "rollback"),
        (ErrorKind::Damaged, "damaged"),
    ] {
        assert_eq!(
            serde_json::to_value(CommandError::new(k, "x")).unwrap()["kind"],
            name
        );
    }
    let io = std::io::Error::other("disk");
    assert_eq!(
        kind(SessionError::Vault(VaultError::Io {
            path: "a".into(),
            source: io
        })),
        ErrorKind::Io
    );
    assert!(
        CommandError::from(SessionError::InvalidName("a#b".into()))
            .message
            .contains("a#b")
    );
}
