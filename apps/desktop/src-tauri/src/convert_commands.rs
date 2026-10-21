//! Encrypt in place (encryption UX spec §4.3, §8): the commands the convert
//! dialog calls, and recovery of an unfinished conversion when a vault opens.
//! The engine is `liber_vault::convert`.
//!
//! preflight → begin (the recovery code, shown and confirmed before any file
//! is copied, §8.1) → run (progress, stage, commit, finish, then the vault
//! opens unlocked). Cancel works at the recovery-key step and during the copy.

use crate::dto::{ProgressPayload, VaultInfo};
use crate::encryption_commands::{RecoveryText, SecretKind};
use crate::epochs;
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use liber_crypto::Zeroizing;
use liber_vault::convert::{self, Blocked, Converting, Phase, RecoverOutcome};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// `{ done, total }` to main after each file copied.
pub const PROGRESS_EVENT: &str = "vault:encrypt-progress";
/// `{ path, outcome: "rolledBack" | "finished" }` to main when an open
/// recovered an interrupted conversion, for the UI's toast.
pub const RECOVERED_EVENT: &str = "vault:encrypt-recovered";

/// A conversion between begin and run, kept beside `AppState`.
#[derive(Default)]
pub struct ConvertState {
    job: Mutex<Option<Job>>,
    cancel: AtomicBool,
    /// The folder being converted, from begin to the end of run: an open of
    /// it meanwhile must not "recover" it under the running copy.
    active: Mutex<Option<PathBuf>>,
}

struct Job {
    conv: Converting,
    /// The run unlocks the converted vault with it.
    passphrase: Zeroizing<String>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightDto {
    pub files: u64,
    pub bytes: u64,
    pub blocked: Vec<Blocked>,
}

#[derive(Serialize)]
pub struct BegunDto {
    pub recovery: RecoveryText,
}

#[derive(Debug, Clone, Serialize)]
struct RecoveredPayload {
    path: String,
    outcome: &'static str,
}

fn not_permitted(msg: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::NotPermitted, msg)
}

fn canonical(path: &Path) -> CmdResult<PathBuf> {
    dunce::canonicalize(path) // seam: outside (the folder about to be encrypted)
        .map_err(|e| CommandError::new(ErrorKind::NotFound, format!("{}: {e}", path.display())))
}

/// Folders never encrypted in place (§8.10); the engine adds volume roots.
fn refused_folders<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let p = app.path();
    [
        p.home_dir(),
        p.desktop_dir(),
        p.document_dir(),
        p.download_dir(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn not_scratchpad(state: &AppState, root: &Path) -> CmdResult<()> {
    if state.settings.is_scratchpad(root) || state.opened_as_scratchpad(root) {
        return Err(not_permitted("Encrypt a vault folder, not the Scratchpad"));
    }
    Ok(())
}

/// The vault's plaintext index in the app cache (it holds page text).
fn drop_index(cache_dir: &Path, root: &Path) -> std::io::Result<()> {
    let db = liber_session::index_db_path(cache_dir, root);
    let Some(dir) = db.parent() else {
        return Ok(());
    };
    let removed = std::fs::remove_dir_all(dir); // seam: outside (the app cache's plaintext index)
    match removed {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Before any open of `root` (§4.3, §8.2): this device's unfinished
/// conversion is rolled back or finished, and the UI told; another device's
/// is refused with `convertingElsewhere`, touching nothing. `true` when the
/// readable originals are still in the folder (§8.8).
pub(crate) fn recover_on_open<R: Runtime>(app: &AppHandle<R>, root: &Path) -> CmdResult<bool> {
    if convert::read_journal(root)?.is_none() {
        return Ok(false);
    }
    let root = canonical(root)?;
    if lock(&app.state::<ConvertState>().active).as_deref() == Some(root.as_path()) {
        return Err(not_permitted("this folder is being encrypted right now"));
    }
    let state = app.state::<AppState>();
    let id = epochs::install_id(state.settings.dir())?;
    let trash = state.trasher();
    let outcome = convert::recover(&root, &id, &*trash, &|| drop_index(&state.cache_dir, &root))?;
    let told = match outcome {
        RecoverOutcome::OtherDevice => {
            return Err(CommandError::new(
                ErrorKind::ConvertingElsewhere,
                "This vault is being encrypted on another device. Finish there, or wait for \
                 sync to finish.",
            ));
        }
        RecoverOutcome::RolledBack => Some("rolledBack"),
        RecoverOutcome::Finished => Some("finished"),
        RecoverOutcome::Nothing | RecoverOutcome::TrashPending => None,
    };
    if let Some(outcome) = told {
        let path = root.to_string_lossy().into_owned();
        let _ = app.emit_to("main", RECOVERED_EVENT, RecoveredPayload { path, outcome });
    }
    Ok(convert::read_journal(&root)?.is_some_and(|j| j.phase == Phase::TrashPending))
}

pub(crate) fn vault_encrypt_preflight_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: PathBuf,
) -> CmdResult<PreflightDto> {
    let root = canonical(&path)?;
    not_scratchpad(&app.state::<AppState>(), &root)?;
    let pre = convert::preflight(&root, &refused_folders(app))?;
    Ok(PreflightDto {
        files: pre.files,
        bytes: pre.bytes,
        blocked: pre.blocked,
    })
}

/// Undoes a begin that never ran (a new begin, or Cancel at the key step).
fn abandon(cs: &ConvertState) -> CmdResult<()> {
    let Some(job) = lock(&cs.job).take() else {
        return Ok(());
    };
    let root = job.conv.root().to_path_buf();
    drop(job);
    *lock(&cs.active) = None;
    Ok(convert::rollback(&root)?)
}

pub(crate) fn vault_encrypt_begin_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: PathBuf,
    passphrase: Zeroizing<String>,
) -> CmdResult<BegunDto> {
    crate::encryption_commands::check_passphrase(&passphrase)?;
    let state = app.state::<AppState>();
    let cs = app.state::<ConvertState>();
    // Checked first: the converted vault's epoch is recorded at the end.
    epochs::check_readable(state.settings.dir())?;
    let root = canonical(&path)?;
    not_scratchpad(&state, &root)?;
    let refused = refused_folders(app);
    // Read-only, before the open vault is closed for it.
    let pre = convert::preflight(&root, &refused)?;
    if !pre.blocked.is_empty() {
        return Err(convert::ConvertError::Blocked(pre.blocked).into());
    }
    abandon(&cs)?;
    // Nothing else edits the vault meanwhile (§4.2 step 4).
    if state
        .session()
        .is_ok_and(|s| s.vault().root() == root.as_path())
    {
        crate::vault_commands::close_session(app);
    }
    let id = epochs::install_id(state.settings.dir())?;
    *lock(&cs.active) = Some(root.clone());
    let begun = convert::begin(&root, &refused, &id, |staging| {
        crate::encryption_commands::create_storage(staging, &passphrase)
    });
    match begun {
        Ok((conv, code)) => {
            cs.cancel.store(false, Ordering::Relaxed);
            *lock(&cs.job) = Some(Job { conv, passphrase });
            Ok(BegunDto {
                recovery: RecoveryText(code.to_display()),
            })
        }
        Err(e) => {
            *lock(&cs.active) = None;
            // A journal this begin wrote is undone (`copying` rolls back).
            if !matches!(
                e,
                convert::ConvertError::Blocked(_) | convert::ConvertError::Refused(_)
            ) {
                let _ = convert::rollback(&root);
            }
            Err(e.into())
        }
    }
}

pub(crate) fn vault_encrypt_run_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<VaultInfo> {
    let cs = app.state::<ConvertState>();
    let Some(Job {
        mut conv,
        passphrase,
    }) = lock(&cs.job).take()
    else {
        return Err(not_permitted("nothing to encrypt: begin first"));
    };
    let state = app.state::<AppState>();
    let root = conv.root().to_path_buf();
    let emitter = app.clone();
    let progress = move |done: u64, total: u64| {
        let (done, total) = (done as usize, total as usize);
        let _ = emitter.emit_to("main", PROGRESS_EVENT, ProgressPayload { done, total });
    };
    let trash = state.trasher();
    let drop_idx = || drop_index(&state.cache_dir, &root);
    let copied = convert::copy(&mut conv, progress, &cs.cancel)
        .and_then(|()| convert::stage_and_commit(conv));
    let done = match copied {
        Ok(()) => convert::finish(&root, &*trash, &drop_idx).map(|_| ()),
        // Before `staged` this undoes it all; from `staged` on it finishes.
        Err(e) => {
            let id = epochs::install_id(state.settings.dir())?;
            match convert::recover(&root, &id, &*trash, &drop_idx) {
                Ok(RecoverOutcome::Finished) => Ok(()),
                _ => Err(e),
            }
        }
    };
    *lock(&cs.active) = None;
    done?;
    // As an unlock: the epoch recorded, the session opened, pending originals reported.
    crate::encryption_commands::vault_unlock_impl(app, root, SecretKind::Passphrase, passphrase)
}

/// Stop and undo: during the copy, the run stops and undoes it (`cancelled`);
/// at the recovery-key step, the begin is undone here.
#[doc(hidden)] // public for the cancel-mid-run test
pub fn vault_encrypt_cancel_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<()> {
    let cs = app.state::<ConvertState>();
    cs.cancel.store(true, Ordering::Relaxed);
    abandon(&cs)
}

fn encrypted_root(state: &AppState) -> CmdResult<PathBuf> {
    let session = state.session()?;
    if session.vault().encrypted().is_none() {
        return Err(not_permitted("the open vault isn't encrypted"));
    }
    Ok(session.vault().root().to_path_buf())
}

/// "Move to Trash" on the originals-pending banner (§8.8).
pub(crate) fn vault_trash_originals_impl(state: &AppState) -> CmdResult<()> {
    let root = encrypted_root(state)?;
    let trash = state.trasher();
    match convert::finish(&root, &*trash, &|| drop_index(&state.cache_dir, &root))? {
        convert::Finished::Done => Ok(()),
        convert::Finished::TrashPending(why) => Err(CommandError::new(
            ErrorKind::Io,
            format!("the unencrypted originals couldn't be moved to the Trash: {why}"),
        )),
    }
}

/// "Show in Finder" on the banner: the originals, under their visible name.
pub(crate) fn vault_reveal_originals_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<()> {
    let root = encrypted_root(&app.state::<AppState>())?;
    let shown = convert::show_originals(&root)?;
    app.opener()
        .reveal_item_in_dir(&shown)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

// ---- command wrappers: off the UI thread (Argon2 and disk) ----

#[tauri::command]
pub async fn vault_encrypt_preflight<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
) -> CmdResult<PreflightDto> {
    blocking(app, move |app| vault_encrypt_preflight_impl(&app, path)).await
}

#[tauri::command]
pub async fn vault_encrypt_begin<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
    passphrase: String,
) -> CmdResult<BegunDto> {
    let passphrase = Zeroizing::new(passphrase);
    blocking(app, move |app| {
        vault_encrypt_begin_impl(&app, path, passphrase)
    })
    .await
}

#[tauri::command]
pub async fn vault_encrypt_run<R: Runtime>(app: AppHandle<R>) -> CmdResult<VaultInfo> {
    blocking(app, move |app| vault_encrypt_run_impl(&app)).await
}

#[tauri::command]
pub async fn vault_encrypt_cancel<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| vault_encrypt_cancel_impl(&app)).await
}

#[tauri::command]
pub async fn vault_trash_originals<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| {
        vault_trash_originals_impl(&app.state::<AppState>())
    })
    .await
}

#[tauri::command]
pub async fn vault_reveal_originals<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| vault_reveal_originals_impl(&app)).await
}
