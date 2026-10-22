//! Decrypt in place (encryption UX spec §10): the commands the decrypt
//! dialog calls, and recovery of an unfinished decryption when a vault opens.
//! The engine is `liber_vault::decrypt`; the state is the encrypt in place's
//! [`ConvertState`], so one conversion runs at a time, either way.
//!
//! preflight (the open encrypted vault) → begin (the passphrase and the
//! recovery key, each checked on its own; the session closes) → run
//! (progress, stage, commit, finish: the keys and the ciphertext deleted, the
//! vault id forgotten; then the folder opens as a plain vault). Cancel works
//! between begin and run and during the copy.

use crate::convert_commands::{
    Active, ConvertState, active_error, canonical, lock, not_scratchpad, refused_folders,
};
use crate::dto::{ProgressPayload, VaultInfo, WarningPayload};
use crate::epochs;
use crate::error::{CmdResult, CommandError, ErrorKind, decrypt_error};
use crate::state::AppState;
use crate::vault_commands::{blocking, install_session, session_events};
use liber_crypto::{RecoveryCode, Zeroizing};
use liber_session::VaultSession;
use liber_vault::convert::{Blocked, ConvertError};
use liber_vault::decrypt::{self, Phase, RecoverOutcome};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// `{ done, total }` to main after each file written and checked.
pub const PROGRESS_EVENT: &str = "vault:decrypt-progress";
/// `{ path, outcome: "rolledBack" | "finished" }` to main when an open
/// recovered an interrupted decryption, for the UI's toast.
pub const RECOVERED_EVENT: &str = "vault:decrypt-recovered";

#[derive(Debug, Clone, Serialize)]
pub struct DecryptPreflightDto {
    pub files: u64,
    pub bytes: u64,
    pub blocked: Vec<Blocked>,
}

#[derive(Debug, Clone, Serialize)]
struct RecoveredPayload {
    path: String,
    outcome: &'static str,
}

fn not_permitted(msg: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::NotPermitted, msg)
}

/// Forgets the vault id in this device's rollback memory; a failure is a
/// warning (the vault is plain already, and no header carries that id).
fn forget_or_warn<R: Runtime>(app: &AppHandle<R>, id: &str) -> std::io::Result<()> {
    let state = app.state::<AppState>();
    if let Err(e) = epochs::forget(state.settings.dir(), id) {
        let message = format!(
            "The vault is decrypted, but this device's rollback memory couldn't forget it ({}).",
            e.message
        );
        let _ = app.emit_to("main", "vault:warning", WarningPayload { message });
    }
    Ok(())
}

/// Before any open of `root`: this device's unfinished decryption is rolled
/// back or finished, and the UI told; another device's is refused, touching
/// nothing.
pub(crate) fn recover_decrypt_on_open<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
) -> CmdResult<()> {
    if decrypt::read_journal(root)?.is_none() {
        return Ok(());
    }
    let root = canonical(root)?;
    let cs = app.state::<ConvertState>();
    if lock(&cs.active).as_deref() == Some(root.as_path()) {
        return Err(active_error(&cs, &root));
    }
    let state = app.state::<AppState>();
    let id = epochs::install_id(state.settings.dir())?;
    let forget = |vault: &str| forget_or_warn(app, vault);
    let outcome = decrypt::recover(&root, &id, &forget).map_err(decrypt_error)?;
    let told = match outcome {
        RecoverOutcome::OtherDevice => {
            let copying = decrypt::read_journal(&root)?.is_some_and(|j| j.phase == Phase::Copying);
            let kind = if copying {
                ErrorKind::DecryptingElsewhere
            } else {
                ErrorKind::DecryptingElsewhereFinishing
            };
            return Err(CommandError::new(kind, root.display().to_string()));
        }
        RecoverOutcome::RolledBack => Some("rolledBack"),
        RecoverOutcome::Finished => Some("finished"),
        RecoverOutcome::Nothing | RecoverOutcome::FinishingElsewhere => None,
    };
    if let Some(outcome) = told {
        let path = root.to_string_lossy().into_owned();
        let _ = app.emit_to("main", RECOVERED_EVENT, RecoveredPayload { path, outcome });
    }
    Ok(())
}

/// The open vault, encrypted and not the Scratchpad, and its root.
fn open_encrypted<R: Runtime>(
    app: &AppHandle<R>,
) -> CmdResult<(std::sync::Arc<VaultSession>, PathBuf)> {
    let state = app.state::<AppState>();
    let session = state.session()?;
    if session.vault().encrypted().is_none() {
        return Err(not_permitted("the open vault isn't encrypted"));
    }
    let root = canonical(session.vault().root())?;
    not_scratchpad(&state, &root)?;
    Ok((session, root))
}

pub(crate) fn vault_decrypt_preflight_impl<R: Runtime>(
    app: &AppHandle<R>,
) -> CmdResult<DecryptPreflightDto> {
    let (session, _) = open_encrypted(app)?;
    let storage = session
        .vault()
        .encrypted()
        .ok_or_else(|| not_permitted("the open vault isn't encrypted"))?;
    let pre = decrypt::preflight(storage, &refused_folders(app)).map_err(decrypt_error)?;
    Ok(DecryptPreflightDto {
        files: pre.files,
        bytes: pre.bytes,
        blocked: pre.blocked,
    })
}

/// Undoes a begin that never ran (a new begin, or Cancel).
fn abandon_decrypt(cs: &ConvertState) -> CmdResult<()> {
    let Some(job) = lock(&cs.decrypt_job).take() else {
        return Ok(());
    };
    let root = job.root().to_path_buf();
    drop(job);
    *lock(&cs.active) = None;
    cs.decrypting.store(false, Ordering::Relaxed);
    decrypt::rollback(&root).map_err(decrypt_error)
}

pub(crate) fn vault_decrypt_begin_impl<R: Runtime>(
    app: &AppHandle<R>,
    passphrase: Zeroizing<String>,
    recovery: Zeroizing<String>,
) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let cs = app.state::<ConvertState>();
    // A begin that never ran is undone first (it closed this vault's session,
    // so there is nothing open to decrypt until it is).
    abandon_decrypt(&cs)?;
    // One at a time, either way: a run, or an encrypt begun, is never replaced.
    if lock(&cs.active).is_some() {
        return Err(CommandError::new(
            ErrorKind::ConvertBusy,
            "another folder is being encrypted or decrypted right now",
        ));
    }
    let (session, root) = open_encrypted(app)?;
    if app
        .try_state::<crate::file_windows::FileWindows>()
        .is_some_and(|w| w.any_under(&root))
    {
        return Err(CommandError::new(
            ErrorKind::ConvertWindowsOpen,
            root.display().to_string(),
        ));
    }
    epochs::check_readable(state.settings.dir())?;
    // Each secret on its own: a code that doesn't parse is a wrong one.
    let code = RecoveryCode::parse(&recovery).ok();
    let fresh = decrypt::open_with_both(&root, &passphrase, code.as_ref())?;
    // The header on disk is the open vault's, and not an older one put back.
    let open_id = session.vault().encrypted().map(|s| s.vault_id());
    if open_id != Some(fresh.vault_id()) {
        return Err(CommandError::new(
            ErrorKind::Conflict,
            "this vault's key file changed on disk: lock the vault, unlock it again, then try",
        ));
    }
    epochs::check_and_record(state.settings.dir(), &fresh.vault_id(), fresh.epoch())?;
    let refused = refused_folders(app);
    let pre = decrypt::preflight(&fresh, &refused).map_err(decrypt_error)?;
    if !pre.blocked.is_empty() {
        return Err(ConvertError::Blocked(pre.blocked).into());
    }
    // Nothing else reads or edits the vault meanwhile: its session closes
    // (a take in progress is kept first), and its decrypted copies go.
    drop(session);
    crate::audio_commands::stop_for_lock(app);
    crate::vault_commands::close_session(app);
    state.copies.wipe();
    let id = epochs::install_id(state.settings.dir())?;
    *lock(&cs.active) = Some(root.clone());
    cs.decrypting.store(true, Ordering::Relaxed);
    match decrypt::begin(fresh, &refused, &id) {
        Ok(job) => {
            cs.cancel.store(false, Ordering::Relaxed);
            *lock(&cs.decrypt_job) = Some(job);
            Ok(())
        }
        Err(e) => {
            *lock(&cs.active) = None;
            cs.decrypting.store(false, Ordering::Relaxed);
            // A journal this begin wrote is undone (`copying` rolls back).
            if !matches!(e, ConvertError::Blocked(_) | ConvertError::Refused(_)) {
                let _ = decrypt::rollback(&root);
            }
            Err(decrypt_error(e))
        }
    }
}

#[doc(hidden)] // public for the cancel-mid-run test
pub fn vault_decrypt_run_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<VaultInfo> {
    let cs = app.state::<ConvertState>();
    let Some(mut job) = lock(&cs.decrypt_job).take() else {
        return Err(not_permitted("nothing to decrypt: begin first"));
    };
    let active = Active(&cs);
    let state = app.state::<AppState>();
    let root = job.root().to_path_buf();
    let emitter = app.clone();
    let progress = move |done: u64, total: u64| {
        let (done, total) = (done as usize, total as usize);
        let _ = emitter.emit_to("main", PROGRESS_EVENT, ProgressPayload { done, total });
    };
    let forget = |vault: &str| forget_or_warn(app, vault);
    let copied = decrypt::copy(&mut job, progress, &cs.cancel)
        .and_then(|()| decrypt::stage_and_commit(job));
    let done: CmdResult<()> = match copied {
        // Committed: a cleanup that fails is a warning; the next open finishes it.
        Ok(()) => {
            if let Err(e) = decrypt::finish(&root, &forget) {
                let message = format!(
                    "{} is decrypted, but cleaning up didn't finish ({e}). Opening the vault again \
                     finishes it.",
                    root.display()
                );
                let _ = app.emit_to("main", "vault:warning", WarningPayload { message });
            }
            Ok(())
        }
        // Before `staged` this undoes it all; from `staged` on it finishes.
        Err(e) => {
            let id = epochs::install_id(state.settings.dir())?;
            match decrypt::recover(&root, &id, &forget) {
                Ok(RecoverOutcome::Finished) => Ok(()),
                Ok(_) => Err(decrypt_error(e)),
                Err(_) => {
                    let forward = decrypt::read_journal(&root)
                        .ok()
                        .flatten()
                        .is_some_and(|j| j.phase != Phase::Copying);
                    let kind = if forward {
                        ErrorKind::DecryptFinishFailed
                    } else {
                        ErrorKind::DecryptUndoFailed
                    };
                    Err(CommandError::new(kind, root.display().to_string()))
                }
            }
        }
    };
    drop(active);
    done?;
    // Nothing decrypted of this vault stays in the app's temp folder.
    state.copies.wipe();
    // As an open, without running the recovery again: a cleanup that just
    // failed would fail the open (the next open retries it).
    let (session, report) = VaultSession::open(&root, &state.cache_dir, session_events(app))?;
    install_session(app, session, &report, false)
}

/// Stop and undo: during the copy, the run stops and undoes it
/// (`cancelled`); between begin and run, the begin is undone here.
#[doc(hidden)] // public for the cancel-mid-run test
pub fn vault_decrypt_cancel_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<()> {
    let cs = app.state::<ConvertState>();
    if cs.decrypting.load(Ordering::Relaxed) {
        cs.cancel.store(true, Ordering::Relaxed);
    }
    abandon_decrypt(&cs)
}

// ---- command wrappers: off the UI thread (Argon2 and disk) ----

#[tauri::command]
pub async fn vault_decrypt_preflight<R: Runtime>(
    app: AppHandle<R>,
) -> CmdResult<DecryptPreflightDto> {
    blocking(app, move |app| vault_decrypt_preflight_impl(&app)).await
}

#[tauri::command]
pub async fn vault_decrypt_begin<R: Runtime>(
    app: AppHandle<R>,
    passphrase: String,
    recovery: String,
) -> CmdResult<()> {
    let (passphrase, recovery) = (Zeroizing::new(passphrase), Zeroizing::new(recovery));
    blocking(app, move |app| {
        vault_decrypt_begin_impl(&app, passphrase, recovery)
    })
    .await
}

#[tauri::command]
pub async fn vault_decrypt_run<R: Runtime>(app: AppHandle<R>) -> CmdResult<VaultInfo> {
    blocking(app, move |app| vault_decrypt_run_impl(&app)).await
}

#[tauri::command]
pub async fn vault_decrypt_cancel<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| vault_decrypt_cancel_impl(&app)).await
}
