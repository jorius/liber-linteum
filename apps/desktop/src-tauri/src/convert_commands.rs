//! Encrypt in place (encryption UX spec §4.3, §8): the commands the convert
//! dialog calls, and recovery of an unfinished conversion when a vault opens.
//! The engine is `liber_vault::convert`.
//!
//! preflight → begin (the recovery code, shown and confirmed before any file
//! is copied, §8.1) → backup (only when a readable copy was asked for, §9:
//! written and verified before the key shows) → run (progress, stage, commit,
//! finish, then the vault opens unlocked). Cancel works during the backup, at
//! the recovery-key step and during the copy.
//!
//! Decrypt in place (§10) shares [`ConvertState`]: one conversion at a time,
//! either way (`decrypt_commands`).

use crate::dto::{ProgressPayload, VaultInfo, WarningPayload};
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
use tauri_plugin_dialog::DialogExt;
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
    pub(crate) cancel: AtomicBool,
    /// The folder being converted, from begin to the end of run: an open of
    /// it meanwhile must not "recover" it under the running copy.
    pub(crate) active: Mutex<Option<PathBuf>>,
    /// The active conversion decrypts (§10): its refusals say so.
    pub(crate) decrypting: AtomicBool,
    /// A decrypt in place between its begin and its run.
    pub(crate) decrypt_job: Mutex<Option<liber_vault::decrypt::Decrypting>>,
    /// Replaces the backup folder dialog (tests).
    backup_picker: Mutex<Option<crate::notion_commands::Pick>>,
    /// The folder last picked for the readable backup, checked (§9.1): the
    /// page never names it.
    backup_pick: Mutex<Option<PathBuf>>,
    /// Where the last backup went, for Show in Finder on the done screen.
    last_backup: Mutex<Option<PathBuf>>,
}

impl ConvertState {
    /// Replaces the backup folder dialog (tests); `None` restores it.
    pub fn set_backup_picker(&self, pick: Option<crate::notion_commands::Pick>) {
        *lock(&self.backup_picker) = pick;
    }
}

struct Job {
    conv: Converting,
    /// The run unlocks the converted vault with it.
    passphrase: Zeroizing<String>,
    /// The readable backup's folder (§9), when one was asked for.
    backup: Option<PathBuf>,
    /// The backup is written and verified: only then may the run copy.
    backed_up: bool,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightDto {
    pub files: u64,
    pub bytes: u64,
    pub blocked: Vec<Blocked>,
    /// Begin will close the open vault (this folder, inside it or around
    /// it), so the UI leaves it first.
    #[serde(rename = "closesOpen")]
    pub closes_open: bool,
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

pub(crate) fn canonical(path: &Path) -> CmdResult<PathBuf> {
    dunce::canonicalize(path) // seam: outside (the folder about to be encrypted)
        .map_err(|e| CommandError::new(ErrorKind::NotFound, format!("{}: {e}", path.display())))
}

/// Folders never encrypted in place (§8.10); the engine adds volume roots.
pub(crate) fn refused_folders<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
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

pub(crate) fn not_scratchpad(state: &AppState, root: &Path) -> CmdResult<()> {
    if state.settings.is_scratchpad(root) || state.opened_as_scratchpad(root) {
        return Err(convert::ConvertError::Folder(root.display().to_string()).into());
    }
    Ok(())
}

/// The folder being encrypted right now, if `path` is in it (final review M6).
pub(crate) fn refuse_under_active<R: Runtime>(app: &AppHandle<R>, path: &Path) -> CmdResult<()> {
    let cs = app.state::<ConvertState>();
    let active = lock(&cs.active).clone();
    let path = canonical(path).unwrap_or_else(|_| path.to_path_buf());
    match active {
        Some(root) if path.starts_with(&root) => Err(active_error(&cs, &root)),
        _ => Ok(()),
    }
}

/// `convertActive`, or `decryptActive` while the active conversion decrypts.
pub(crate) fn active_error(cs: &ConvertState, root: &Path) -> CommandError {
    let kind = if cs.decrypting.load(Ordering::Relaxed) {
        ErrorKind::DecryptActive
    } else {
        ErrorKind::ConvertActive
    };
    CommandError::new(kind, root.display().to_string())
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

/// [`drop_index`], a failure told as a warning (review M7): the conversion
/// itself is done, but the leftover index holds page text.
pub(crate) fn drop_index_or_warn<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
) -> std::io::Result<()> {
    let state = app.state::<AppState>();
    if let Err(e) = drop_index(&state.cache_dir, root) {
        let dir = liber_session::index_db_path(&state.cache_dir, root);
        let message = format!(
            "The old search index of {} couldn't be deleted ({e}). It holds page text: delete {} \
             by hand.",
            root.display(),
            dir.parent().unwrap_or(&dir).display()
        );
        let _ = app.emit_to("main", "vault:warning", WarningPayload { message });
    }
    Ok(())
}

/// Clears the running conversion's folder however the run ends (review I4).
pub(crate) struct Active<'a>(pub(crate) &'a ConvertState);

impl Drop for Active<'_> {
    fn drop(&mut self) {
        *lock(&self.0.active) = None;
        self.0.decrypting.store(false, Ordering::Relaxed);
    }
}

/// Before any open of `root` (§4.3, §8.2): this device's unfinished
/// conversion is rolled back or finished, and the UI told; another device's
/// is refused with `convertingElsewhere`, touching nothing. `true` when the
/// readable originals are still in the folder (§8.8).
pub(crate) fn recover_on_open<R: Runtime>(app: &AppHandle<R>, root: &Path) -> CmdResult<bool> {
    // A decrypt in place this device left unfinished (§10.3) comes first.
    crate::decrypt_commands::recover_decrypt_on_open(app, root)?;
    if convert::read_journal(root)?.is_none() {
        return Ok(false);
    }
    let root = canonical(root)?;
    let cs = app.state::<ConvertState>();
    if lock(&cs.active).as_deref() == Some(root.as_path()) {
        return Err(active_error(&cs, &root));
    }
    let state = app.state::<AppState>();
    let id = epochs::install_id(state.settings.dir())?;
    let trash = state.trasher();
    let outcome = convert::recover(&root, &id, &*trash, &|| drop_index_or_warn(app, &root))?;
    let told = match outcome {
        // Still copying there: undoable here on request (§8.11); past it, not.
        RecoverOutcome::OtherDevice => {
            let copying = convert::read_journal(&root)?.is_some_and(|j| j.phase == Phase::Copying);
            let kind = if copying {
                ErrorKind::ConvertingElsewhere
            } else {
                ErrorKind::ConvertingElsewhereFinishing
            };
            return Err(CommandError::new(kind, root.display().to_string()));
        }
        RecoverOutcome::RolledBack => Some("rolledBack"),
        RecoverOutcome::Finished => Some("finished"),
        RecoverOutcome::Nothing
        | RecoverOutcome::TrashPending
        | RecoverOutcome::FinishingElsewhere => None,
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
        closes_open: open_overlapping(&app.state::<AppState>(), &root).is_some(),
    })
}

/// `a` is `b`, inside it or holds it.
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// The open vault's root when it is the folder `root`, inside it or holds it.
fn open_overlapping(state: &AppState, root: &Path) -> Option<PathBuf> {
    let open = state.session().ok()?.vault().root().to_path_buf();
    overlaps(&open, root).then_some(open)
}

/// Any plaintext index left for the encrypted vault at `root` (another device
/// converted a folder this one had open as plain): gone at unlock.
pub(crate) fn drop_plain_index<R: Runtime>(app: &AppHandle<R>, root: &Path) {
    let _ = drop_index_or_warn(app, root);
    if let Ok(canon) = canonical(root)
        && canon != root
    {
        let _ = drop_index_or_warn(app, &canon);
    }
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
    backup: bool,
) -> CmdResult<BegunDto> {
    crate::encryption_commands::check_passphrase(&passphrase)?;
    let state = app.state::<AppState>();
    let cs = app.state::<ConvertState>();
    // One at a time: a run in progress is never replaced (review M4).
    if lock(&cs.active).is_some() && lock(&cs.job).is_none() {
        return Err(CommandError::new(
            ErrorKind::ConvertBusy,
            "another folder is being encrypted right now",
        ));
    }
    // Checked first: the converted vault's epoch is recorded at the end.
    epochs::check_readable(state.settings.dir())?;
    let root = canonical(&path)?;
    not_scratchpad(&state, &root)?;
    // A begin that never ran is undone first, this folder's too (review M5).
    abandon(&cs)?;
    // Refused, not closed: the window may hold unsaved edits (review I1).
    if app
        .try_state::<crate::file_windows::FileWindows>()
        .is_some_and(|w| w.any_under(&root))
    {
        return Err(CommandError::new(
            ErrorKind::ConvertWindowsOpen,
            root.display().to_string(),
        ));
    }
    let refused = refused_folders(app);
    // Read-only, before the open vault is closed for it.
    let pre = convert::preflight(&root, &refused)?;
    if !pre.blocked.is_empty() {
        return Err(convert::ConvertError::Blocked(pre.blocked).into());
    }
    // The folder picked for the readable copy, checked again (§9.1).
    let backup = match backup {
        false => None,
        true => {
            let picked = lock(&cs.backup_pick)
                .clone()
                .ok_or_else(|| not_permitted("choose a folder for the readable copy first"))?;
            Some(check_backup_folder(app, &root, &picked)?)
        }
    };
    // Nothing else edits the vault meanwhile (§4.2 step 4): the open vault
    // closes when it is this folder, inside it or holds it (review I3).
    if open_overlapping(&state, &root).is_some() {
        // A take in progress is stopped and kept in the vault first (review I2).
        crate::audio_commands::stop_for_lock(app);
        crate::vault_commands::close_session(app);
    }
    // Every known vault inside the folder or holding it: its plaintext index
    // goes now (final round; this folder's own goes when the run finishes).
    for known in state.settings.recent() {
        if let Ok(known) = canonical(Path::new(&known.path))
            && known != root
            && overlaps(&known, &root)
        {
            drop_index_or_warn(app, &known)?;
        }
    }
    let id = epochs::install_id(state.settings.dir())?;
    *lock(&cs.active) = Some(root.clone());
    let begun = convert::begin(&root, &refused, &id, |staging| {
        crate::encryption_commands::create_storage(staging, &passphrase)
    });
    match begun {
        Ok((conv, code)) => {
            cs.cancel.store(false, Ordering::Relaxed);
            *lock(&cs.job) = Some(Job {
                conv,
                passphrase,
                backup,
                backed_up: false,
            });
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

#[doc(hidden)] // public for the review I4 test (crash points are per thread)
pub fn vault_encrypt_run_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<VaultInfo> {
    let cs = app.state::<ConvertState>();
    let mut job = lock(&cs.job);
    // Nothing is encrypted before the readable copy asked for is verified (§9).
    if job
        .as_ref()
        .is_some_and(|j| j.backup.is_some() && !j.backed_up)
    {
        return Err(not_permitted("the readable copy isn't made yet"));
    }
    let Some(Job {
        mut conv,
        passphrase,
        ..
    }) = job.take()
    else {
        return Err(not_permitted("nothing to encrypt: begin first"));
    };
    drop(job);
    let active = Active(&cs);
    let state = app.state::<AppState>();
    let root = conv.root().to_path_buf();
    let emitter = app.clone();
    let progress = move |done: u64, total: u64| {
        let (done, total) = (done as usize, total as usize);
        let _ = emitter.emit_to("main", PROGRESS_EVENT, ProgressPayload { done, total });
    };
    let trash = state.trasher();
    let drop_idx = || drop_index_or_warn(app, &root);
    let copied = convert::copy(&mut conv, progress, &cs.cancel)
        .and_then(|()| convert::stage_and_commit(conv));
    let done: CmdResult<()> = match copied {
        // Committed: a cleanup that fails is a warning, and the next open
        // finishes it (final review M4).
        Ok(()) => {
            if let Err(e) = convert::finish(&root, &*trash, &drop_idx) {
                let message = format!(
                    "{} is encrypted, but cleaning up didn't finish ({e}). Opening the vault \
                     again finishes it.",
                    root.display()
                );
                let _ = app.emit_to("main", "vault:warning", WarningPayload { message });
            }
            Ok(())
        }
        // Before `staged` this undoes it all; from `staged` on it finishes.
        Err(e) => {
            let id = epochs::install_id(state.settings.dir())?;
            match convert::recover(&root, &id, &*trash, &drop_idx) {
                Ok(RecoverOutcome::Finished) => Ok(()),
                Ok(_) => Err(e.into()),
                // Never "back as it was" while that failed too (review I4): past
                // `staged` the next open finishes it, before it undoes it (M5).
                Err(_) => {
                    let forward = convert::read_journal(&root)
                        .ok()
                        .flatten()
                        .is_some_and(|j| j.phase != Phase::Copying);
                    let kind = if forward {
                        ErrorKind::ConvertFinishFailed
                    } else {
                        ErrorKind::ConvertUndoFailed
                    };
                    Err(CommandError::new(kind, root.display().to_string()))
                }
            }
        }
    };
    drop(active);
    done?;
    // As an unlock (the epoch recorded, the session opened), without running
    // the recovery again: a cleanup that just failed would fail the open.
    let pending = convert::read_journal(&root)?.is_some_and(|j| j.phase == Phase::TrashPending);
    crate::encryption_commands::unlock_recovered(
        app,
        root,
        SecretKind::Passphrase,
        passphrase,
        pending,
    )
}

/// Final review I4 (spec §8.11): another device's conversion still in
/// `copying` is undone here, on the user's confirmed request. From `staged`
/// on it isn't (that device, or the manual steps, finish it).
pub(crate) fn vault_encrypt_undo_elsewhere_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: PathBuf,
) -> CmdResult<()> {
    let root = canonical(&path)?;
    refuse_under_active(app, &root)?;
    // Another device's decrypt in place, still copying, undoes the same way.
    if let Some(journal) = liber_vault::decrypt::read_journal(&root)? {
        if journal.phase != liber_vault::decrypt::Phase::Copying {
            return Err(CommandError::new(
                ErrorKind::DecryptingElsewhereFinishing,
                root.display().to_string(),
            ));
        }
        return liber_vault::decrypt::rollback(&root).map_err(crate::error::decrypt_error);
    }
    let Some(journal) = convert::read_journal(&root)? else {
        return Err(not_permitted(
            "nothing to undo: this folder isn't being encrypted",
        ));
    };
    if journal.phase != Phase::Copying {
        return Err(CommandError::new(
            ErrorKind::ConvertingElsewhereFinishing,
            root.display().to_string(),
        ));
    }
    // Rollback keeps every check of its own (exact names, created by that run).
    Ok(convert::rollback(&root)?)
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
    // Only originals the Trash refused: a conversion still finishing (here or
    // on another device, final round N3) is that run's to finish.
    if convert::read_journal(&root)?.is_none_or(|j| j.phase != Phase::TrashPending) {
        return Err(not_permitted(
            "no unencrypted originals are waiting for the Trash",
        ));
    }
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

// ---- the readable backup (encryption UX §9) ----

/// [`convert::check_backup`], and not inside a vault this app knows: a
/// recent one or the Scratchpad.
fn check_backup_folder<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    picked: &Path,
) -> CmdResult<PathBuf> {
    let dest = convert::check_backup(root, picked)?;
    let state = app.state::<AppState>();
    let known = state
        .settings
        .recent()
        .into_iter()
        .filter_map(|r| canonical(Path::new(&r.path)).ok())
        .find(|v| dest.starts_with(v));
    let scratchpad = dest
        .ancestors()
        .find(|a| state.settings.is_scratchpad(a))
        .map(Path::to_path_buf);
    match known.or(scratchpad) {
        Some(vault) => Err(CommandError::new(
            ErrorKind::BackupInOtherVault,
            vault.display().to_string(),
        )),
        None => Ok(dest),
    }
}

/// Choose… on the backup step: the folder dialog (tests replace it), then
/// the checks. `None` when cancelled (the folder picked before stays).
pub(crate) fn vault_encrypt_pick_backup_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: PathBuf,
) -> CmdResult<Option<String>> {
    let root = canonical(&path)?;
    let cs = app.state::<ConvertState>();
    let picker = lock(&cs.backup_picker).clone();
    let picked = match picker {
        Some(pick) => pick(),
        None => app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok()),
    };
    let Some(picked) = picked else {
        return Ok(None);
    };
    *lock(&cs.backup_pick) = None;
    let dest = check_backup_folder(app, &root, &picked)?;
    *lock(&cs.backup_pick) = Some(dest.clone());
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// Writes and verifies the readable copy, between begin and the recovery
/// key (§9.1). On failure (Stop and undo too) its own files are gone and the
/// conversion is undone: nothing was encrypted.
#[doc(hidden)] // public for the cancel-mid-backup test
pub fn vault_encrypt_backup_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<()> {
    let cs = app.state::<ConvertState>();
    let Some(mut job) = lock(&cs.job).take() else {
        return Err(not_permitted("nothing to back up: begin first"));
    };
    let Some(dest) = job.backup.clone().filter(|_| !job.backed_up) else {
        *lock(&cs.job) = Some(job);
        return Err(not_permitted("no readable copy is waiting to be made"));
    };
    let emitter = app.clone();
    let progress = move |done: u64, total: u64| {
        let (done, total) = (done as usize, total as usize);
        let _ = emitter.emit_to("main", PROGRESS_EVENT, ProgressPayload { done, total });
    };
    match convert::backup(&mut job.conv, &dest, progress, &cs.cancel) {
        Ok(()) => {
            job.backed_up = true;
            *lock(&cs.last_backup) = Some(dest);
            *lock(&cs.job) = Some(job);
            Ok(())
        }
        Err(e) => {
            let root = job.conv.root().to_path_buf();
            drop(job);
            *lock(&cs.active) = None;
            if convert::rollback(&root).is_err() {
                return Err(CommandError::new(
                    ErrorKind::ConvertUndoFailed,
                    root.display().to_string(),
                ));
            }
            Err(e.into())
        }
    }
}

/// Show in Finder on the done screen: the folder this app last backed up to.
pub(crate) fn vault_reveal_backup_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<()> {
    let Some(dest) = lock(&app.state::<ConvertState>().last_backup).clone() else {
        return Err(not_permitted("no readable copy was made"));
    };
    app.opener()
        .reveal_item_in_dir(&dest)
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
    backup: Option<bool>,
) -> CmdResult<BegunDto> {
    let passphrase = Zeroizing::new(passphrase);
    blocking(app, move |app| {
        vault_encrypt_begin_impl(&app, path, passphrase, backup.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn vault_encrypt_pick_backup<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
) -> CmdResult<Option<String>> {
    blocking(app, move |app| vault_encrypt_pick_backup_impl(&app, path)).await
}

#[tauri::command]
pub async fn vault_encrypt_backup<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| vault_encrypt_backup_impl(&app)).await
}

#[tauri::command]
pub async fn vault_reveal_backup<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    blocking(app, move |app| vault_reveal_backup_impl(&app)).await
}

#[tauri::command]
pub async fn vault_encrypt_run<R: Runtime>(app: AppHandle<R>) -> CmdResult<VaultInfo> {
    blocking(app, move |app| vault_encrypt_run_impl(&app)).await
}

#[tauri::command]
pub async fn vault_encrypt_undo_elsewhere<R: Runtime>(
    app: AppHandle<R>,
    path: PathBuf,
) -> CmdResult<()> {
    blocking(app, move |app| {
        vault_encrypt_undo_elsewhere_impl(&app, path)
    })
    .await
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
