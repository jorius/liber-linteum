//! Encrypted vault commands (E3 Task 5), the contract the encryption UI (E4)
//! calls: create, unlock and lock a vault, change its passphrase or recovery
//! code, list what can't be read, and open an attachment as a decrypted copy.
//!
//! Passphrases and recovery codes go into `Zeroizing<String>` as they arrive.
//! The webview's own copies, and the IPC buffers, are a documented residual
//! (spec §5).

use crate::dto::VaultInfo;
use crate::epochs;
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::{blocking, install_session, session_events};
use liber_crypto::{Argon2Params, RecoveryCode, Unlock, Zeroizing};
use liber_session::VaultSession;
use liber_vault::{EncryptedStorage, VaultPath, is_hidden_path};
use serde::{Deserialize, Serialize, Serializer};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Shortest passphrase accepted (spec §7, NIST 800-63B): no composition rules.
pub const MIN_PASSPHRASE_CHARS: usize = 12;

/// Sent to the main window once the vault has locked.
pub const LOCKED_EVENT: &str = "vault:locked";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    Passphrase,
    Recovery,
}

/// What the Unlock screen offers.
#[derive(Deserialize)]
pub struct SecretArg {
    pub kind: SecretKind,
    pub value: String,
}

/// A recovery code for the UI to show once; wiped here after sending.
pub struct RecoveryText(Zeroizing<String>);

impl Serialize for RecoveryText {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

#[derive(Serialize)]
pub struct CreatedVault {
    pub info: VaultInfo,
    pub recovery: RecoveryText,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadableDto {
    pub os_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
struct LockedPayload {
    path: String,
}

fn check_passphrase(p: &str) -> CmdResult<()> {
    if p.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            format!("a passphrase has at least {MIN_PASSPHRASE_CHARS} characters"),
        ));
    }
    Ok(())
}

fn not_encrypted() -> CommandError {
    CommandError::new(ErrorKind::NotPermitted, "the open vault isn't encrypted")
}

/// Argon2 parameters for a new passphrase slot: calibrated on this machine
/// (0.5–2 s, never below the floor). Test builds use the floor itself.
fn slot_params() -> Argon2Params {
    #[cfg(feature = "test-params")]
    return Argon2Params::FLOOR;
    #[cfg(not(feature = "test-params"))]
    Argon2Params::calibrate()
}

/// A new vault at `root`: calibrated parameters that must pass the floor
/// (`VaultHeader::create` checks). Test builds use tiny ones.
fn create_storage(root: &Path, passphrase: &str) -> CmdResult<(EncryptedStorage, RecoveryCode)> {
    #[cfg(feature = "test-params")]
    let made = EncryptedStorage::create_insecure(
        root,
        passphrase,
        Argon2Params {
            m_kib: 64,
            t: 1,
            p: 1,
        },
    );
    #[cfg(not(feature = "test-params"))]
    let made = EncryptedStorage::create(root, passphrase, slot_params());
    Ok(made?)
}

/// An unlocked vault becomes the open one, its index in memory only.
fn open_unlocked<R: Runtime>(
    app: &AppHandle<R>,
    storage: EncryptedStorage,
    recovery_void: bool,
    warning: Option<String>,
) -> CmdResult<VaultInfo> {
    let (session, mut report) = VaultSession::open_encrypted(storage, session_events(app))?;
    report.warnings.extend(warning);
    install_session(app, session, &report, recovery_void)
}

pub(crate) fn vault_create_encrypted_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: PathBuf,
    passphrase: Zeroizing<String>,
) -> CmdResult<CreatedVault> {
    check_passphrase(&passphrase)?;
    if !path.exists() {
        std::fs::create_dir_all(&path)?; // seam: outside (the folder about to become a vault)
    }
    let (storage, code) = create_storage(&path, &passphrase)?;
    let state = app.state::<AppState>();
    epochs::check_and_record(state.settings.dir(), &storage.vault_id(), storage.epoch())?;
    let info = open_unlocked(app, storage, false, None)?;
    Ok(CreatedVault {
        info,
        recovery: RecoveryText(code.to_display()),
    })
}

pub(crate) fn vault_unlock_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: PathBuf,
    kind: SecretKind,
    value: Zeroizing<String>,
) -> CmdResult<VaultInfo> {
    let code;
    let with = match kind {
        SecretKind::Passphrase => Unlock::Passphrase(&value),
        SecretKind::Recovery => {
            code = RecoveryCode::parse(&value).map_err(|_| {
                CommandError::new(ErrorKind::InvalidInput, "that isn't a recovery code")
            })?;
            Unlock::Recovery(&code)
        }
    };
    let (storage, report) = EncryptedStorage::unlock(&path, with)?;
    let state = app.state::<AppState>();
    // Before anything is written (the merge writes the header): a rolled-back
    // vault is neither opened nor written (spec §16 #18).
    epochs::check_and_record(state.settings.dir(), &report.vault_id, report.epoch)?;
    // A merge that fails leaves the copies for next time; the vault still opens.
    let (merged, warning) = match storage.merge_header_copies(state.discard_header_copy) {
        Ok(merged) => (merged, None),
        Err(e) => (None, Some(format!("header copies weren't merged: {e}"))),
    };
    let void = merged.is_some_and(|m| m.local_recovery_dropped);
    open_unlocked(app, storage, void, warning)
}

pub(crate) fn vault_lock_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let session = state.session()?;
    if session.vault().encrypted().is_none() {
        return Err(not_encrypted());
    }
    // Spec §6.2: a take in progress is stopped and kept first.
    crate::audio_commands::stop_orphaned(app);
    session.lock();
    let path = session.vault().root().to_string_lossy().into_owned();
    // Clearing the session also wipes the decrypted copies (`set_session`).
    crate::vault_commands::close_session(app);
    let _ = app.emit_to("main", LOCKED_EVENT, LockedPayload { path });
    Ok(())
}

fn encrypted_session(state: &AppState) -> CmdResult<std::sync::Arc<VaultSession>> {
    let session = state.session()?;
    if session.vault().encrypted().is_none() {
        return Err(not_encrypted());
    }
    Ok(session)
}

pub(crate) fn security_change_passphrase_impl(
    state: &AppState,
    current: Zeroizing<String>,
    next: Zeroizing<String>,
) -> CmdResult<()> {
    let session = encrypted_session(state)?;
    check_passphrase(&next)?;
    let storage = session.vault().encrypted().ok_or_else(not_encrypted)?;
    Ok(storage.change_passphrase(&current, &next, slot_params)?)
}

pub(crate) fn security_new_recovery_impl(
    state: &AppState,
    passphrase: Zeroizing<String>,
) -> CmdResult<RecoveryText> {
    let session = encrypted_session(state)?;
    let storage = session.vault().encrypted().ok_or_else(not_encrypted)?;
    Ok(RecoveryText(
        storage.new_recovery(&passphrase)?.to_display(),
    ))
}

/// Entries whose names couldn't be read (spec §4.3): never deleted. Empty
/// for a plain vault.
pub(crate) fn vault_unreadable_impl(state: &AppState) -> CmdResult<Vec<UnreadableDto>> {
    let session = state.session()?;
    Ok(session
        .vault()
        .encrypted()
        .map(|s| s.unreadable())
        .unwrap_or_default()
        .into_iter()
        .map(|(p, reason)| UnreadableDto {
            os_path: p.to_string_lossy().into_owned(),
            reason,
        })
        .collect())
}

/// Shows an unreadable entry in Finder or Explorer: only one on the list.
pub(crate) fn vault_reveal_unreadable_impl<R: Runtime>(
    app: &AppHandle<R>,
    os_path: String,
) -> CmdResult<()> {
    let listed = vault_unreadable_impl(&app.state::<AppState>())?
        .iter()
        .any(|u| u.os_path == os_path);
    if !listed {
        return Err(CommandError::new(
            ErrorKind::NotPermitted,
            "only an entry on the unreadable list can be revealed",
        ));
    }
    app.opener()
        .reveal_item_in_dir(&os_path)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

/// Opens an attachment in its default app through a decrypted copy, which
/// lives until the vault locks or the app quits (spec §5.5). E4 asks first.
pub(crate) fn attachment_open_decrypted_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: String,
) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let session = state.session()?;
    let vp = VaultPath::new(&path)?;
    if vp.is_root() || is_hidden_path(vp.as_str()) {
        return Err(CommandError::new(
            ErrorKind::NotPermitted,
            format!("{path} can't be opened"),
        ));
    }
    let (bytes, _) = session.vault().read(&vp)?;
    let copy = state.copies.write(vp.file_name(), &bytes)?;
    if let Err(e) = crate::editor_commands::check_openable(&copy) {
        let _ = std::fs::remove_file(&copy); // seam: outside (a decrypted copy, spec §5.5)
        return Err(e);
    }
    match state.opener() {
        Some(open) => open(&copy)?,
        None => app
            .opener()
            .open_path(copy.to_string_lossy(), None::<&str>)
            .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?,
    }
    Ok(())
}

// ---- command wrappers: off the UI thread (Argon2 and disk) ----

#[tauri::command]
pub async fn vault_create_encrypted<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    passphrase: String,
) -> CmdResult<CreatedVault> {
    let passphrase = Zeroizing::new(passphrase);
    blocking(app, move |app| {
        vault_create_encrypted_impl(&app, path, passphrase)
    })
    .await
}

#[tauri::command]
pub async fn vault_unlock<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    secret: SecretArg,
) -> CmdResult<VaultInfo> {
    let (kind, value) = (secret.kind, Zeroizing::new(secret.value));
    blocking(app, move |app| vault_unlock_impl(&app, path, kind, value)).await
}

#[tauri::command]
pub async fn vault_lock<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| vault_lock_impl(&app)).await
}

#[tauri::command]
pub async fn security_change_passphrase<R: Runtime>(
    app: AppHandle<R>,
    current: String,
    next: String,
) -> CmdResult<()> {
    let (current, next) = (Zeroizing::new(current), Zeroizing::new(next));
    blocking(app, move |app| {
        security_change_passphrase_impl(&app.state::<AppState>(), current, next)
    })
    .await
}

#[tauri::command]
pub async fn security_new_recovery<R: Runtime>(
    app: AppHandle<R>,
    passphrase: String,
) -> CmdResult<RecoveryText> {
    let passphrase = Zeroizing::new(passphrase);
    blocking(app, move |app| {
        security_new_recovery_impl(&app.state::<AppState>(), passphrase)
    })
    .await
}

#[tauri::command]
pub async fn vault_unreadable<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<UnreadableDto>> {
    blocking(app, move |app| {
        vault_unreadable_impl(&app.state::<AppState>())
    })
    .await
}

#[tauri::command]
pub async fn vault_reveal_unreadable<R: Runtime>(
    app: AppHandle<R>,
    os_path: String,
) -> CmdResult<()> {
    blocking(app, move |app| vault_reveal_unreadable_impl(&app, os_path)).await
}

#[tauri::command]
pub async fn attachment_open_decrypted<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> CmdResult<()> {
    blocking(app, move |app| attachment_open_decrypted_impl(&app, path)).await
}
