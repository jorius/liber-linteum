//! Quick notes (M4c §2, §4, §7): the global Scratchpad and every vault's
//! scratch folder.
//!
//! No Scratchpad path ever comes from the page: `scratchpad_set` accepts the
//! default location or the folder the user just picked in a dialog Rust
//! opened, `scratchpadPath` can't be patched through `settings_set`, and
//! `scratchpad_open` takes no path. Quick notes go where Rust says: the
//! global Scratchpad's root when that is the open vault, else the vault's
//! scratch folder.

use crate::dto::{RenameOutcomeDto, VaultInfo};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::settings::Settings;
use crate::state::AppState;
use crate::vault_commands::{blocking, open_session};
use liber_session::VaultSession;
use liber_vault::VaultPath;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Chooses a folder (the Scratchpad's). Tests replace the native dialog.
pub type FolderPicker = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// The default Scratchpad, under the user's Documents folder.
const DEFAULT_PARENT: &str = "Liber Linteum";
const DEFAULT_NAME: &str = "Scratchpad";

/// Scratchpad state kept beside `AppState`.
#[derive(Default)]
pub struct ScratchpadState {
    folder_picker: Mutex<Option<FolderPicker>>,
    /// Stands in for the OS Documents folder (tests).
    documents_dir: Mutex<Option<PathBuf>>,
    /// The folder last picked in the dialog: `scratchpad_set` may use it.
    granted: Mutex<Option<PathBuf>>,
}

impl ScratchpadState {
    /// Replaces the native folder dialog (tests); `None` restores it.
    pub fn set_folder_picker(&self, picker: Option<FolderPicker>) {
        *lock(&self.folder_picker) = picker;
    }

    /// Replaces the OS Documents folder (tests); `None` restores it.
    pub fn set_documents_dir(&self, dir: Option<PathBuf>) {
        *lock(&self.documents_dir) = dir;
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What `quick_note_autoname` did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoNameDto {
    pub path: String,
    pub auto_named: bool,
    pub outcome: Option<RenameOutcomeDto>,
}

/// The open vault's quick notes: its scratch folder (`None` in the global
/// Scratchpad, whose root is the scratch place) and the notes still named
/// after their first line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickNotesStateDto {
    pub folder: Option<String>,
    pub auto_named: Vec<String>,
}

/// What `scratch_folder_set` did: the folder's name now, and the rename on
/// disk when the folder existed (`from` → `folder`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchFolderDto {
    pub folder: String,
    pub from: Option<String>,
    pub outcome: Option<RenameOutcomeDto>,
}

fn not_permitted(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::NotPermitted, message)
}

fn io(e: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Io, e.to_string())
}

/// `<Documents>/Liber Linteum/Scratchpad`.
fn default_location<R: Runtime>(app: &AppHandle<R>) -> CmdResult<PathBuf> {
    let docs = match lock(&app.state::<ScratchpadState>().documents_dir).clone() {
        Some(dir) => dir,
        None => app.path().document_dir().map_err(io)?,
    };
    Ok(docs.join(DEFAULT_PARENT).join(DEFAULT_NAME))
}

/// Where a new quick note goes in the open vault.
fn scratch_place(state: &AppState, session: &VaultSession) -> CmdResult<Option<VaultPath>> {
    if state.opened_as_scratchpad(session.vault().root()) {
        return Ok(None);
    }
    Ok(Some(VaultPath::new(&session.vault().scratch_folder())?))
}

pub(crate) fn scratchpad_choose_impl<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let scratch = app.state::<ScratchpadState>();
    let picker = lock(&scratch.folder_picker).clone();
    let picked = match picker {
        Some(pick) => pick(),
        None => app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok()),
    };
    *lock(&scratch.granted) = picked.clone();
    picked.map(|p| p.to_string_lossy().into_owned())
}

pub(crate) fn scratchpad_set_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: String,
) -> CmdResult<Settings> {
    let wanted = PathBuf::from(&path);
    let scratch = app.state::<ScratchpadState>();
    let picked = lock(&scratch.granted).as_ref() == Some(&wanted);
    if !picked && wanted != default_location(app)? {
        return Err(not_permitted(format!(
            "{path} wasn't picked for quick notes"
        )));
    }
    std::fs::create_dir_all(&wanted)?; // seam: outside (creates the global Scratchpad folder in app data)
    let canonical = dunce::canonicalize(&wanted)?; // seam: outside (creates the global Scratchpad folder in app data)
    let settings = app
        .state::<AppState>()
        .settings
        .set_scratchpad_path(Some(canonical.to_string_lossy().into_owned()))?;
    *lock(&scratch.granted) = None;
    Ok(settings)
}

pub(crate) fn scratchpad_open_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<VaultInfo> {
    let path = app.state::<AppState>().settings.get().0.scratchpad_path;
    let Some(path) = path else {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            "no folder chosen for quick notes yet",
        ));
    };
    // Deleted since (or its drive was away): made again (spec §7.18).
    std::fs::create_dir_all(&path)?; // seam: outside (creates the global Scratchpad folder in app data)
    open_session(app, std::path::Path::new(&path))
}

pub(crate) fn quick_note_create_impl(state: &AppState, name: String) -> CmdResult<String> {
    let session = state.session()?;
    let dir = scratch_place(state, &session)?.unwrap_or_else(VaultPath::root);
    Ok(session.create_quick_note(&dir, &name)?.to_string())
}

pub(crate) fn quick_note_autoname_impl(state: &AppState, path: String) -> CmdResult<AutoNameDto> {
    let session = state.session()?;
    let rewrite = state.settings.get().0.rewrite_links;
    let out = session.auto_name(&VaultPath::new(&path)?, rewrite)?;
    Ok(AutoNameDto {
        path: out.path.to_string(),
        auto_named: out.auto_named,
        outcome: out.renamed.map(Into::into),
    })
}

pub(crate) fn quick_notes_state_impl(state: &AppState) -> CmdResult<QuickNotesStateDto> {
    let session = state.session()?;
    Ok(QuickNotesStateDto {
        folder: scratch_place(state, &session)?.map(|p| p.to_string()),
        auto_named: session.vault().auto_named().into_iter().collect(),
    })
}

pub(crate) fn scratch_folder_set_impl(
    state: &AppState,
    name: String,
) -> CmdResult<ScratchFolderDto> {
    let session = state.session()?;
    if state.opened_as_scratchpad(session.vault().root()) {
        return Err(not_permitted(
            "the Scratchpad's quick notes live at its root",
        ));
    }
    let from = session.vault().scratch_folder();
    let rewrite = state.settings.get().0.rewrite_links;
    let outcome = session.set_scratch_folder(&name, rewrite)?;
    Ok(ScratchFolderDto {
        folder: session.vault().scratch_folder(),
        from: outcome.is_some().then_some(from),
        outcome: outcome.map(Into::into),
    })
}

// ---- command wrappers: run off the UI thread ----

/// The default Scratchpad location, shown in the first-use dialog.
#[tauri::command]
pub async fn scratchpad_default<R: Runtime>(app: AppHandle<R>) -> CmdResult<String> {
    blocking(app, move |app| {
        Ok(default_location(&app)?.to_string_lossy().into_owned())
    })
    .await
}

/// A folder dialog Rust opens; the pick may then be passed to
/// `scratchpad_set`. `null` when cancelled.
#[tauri::command]
pub async fn scratchpad_choose<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<String>> {
    blocking(app, move |app| Ok(scratchpad_choose_impl(&app))).await
}

/// Makes `path` (the default, or the folder just picked) the Scratchpad,
/// creating it and its parents.
#[tauri::command]
pub async fn scratchpad_set<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<Settings> {
    blocking(app, move |app| scratchpad_set_impl(&app, path)).await
}

/// Opens the global Scratchpad as the vault.
#[tauri::command]
pub async fn scratchpad_open<R: Runtime>(app: AppHandle<R>) -> CmdResult<VaultInfo> {
    blocking(app, move |app| scratchpad_open_impl(&app)).await
}

/// A new quick note named `name` (deduplicated) in the open vault's scratch
/// place; its vault path.
#[tauri::command]
pub async fn quick_note_create<R: Runtime>(app: AppHandle<R>, name: String) -> CmdResult<String> {
    blocking(app, move |app| {
        quick_note_create_impl(&app.state::<AppState>(), name)
    })
    .await
}

/// Renames a quick note after its saved first line while it is still
/// named that way.
#[tauri::command]
pub async fn quick_note_autoname<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> CmdResult<AutoNameDto> {
    blocking(app, move |app| {
        quick_note_autoname_impl(&app.state::<AppState>(), path)
    })
    .await
}

#[tauri::command]
pub async fn quick_notes_state<R: Runtime>(app: AppHandle<R>) -> CmdResult<QuickNotesStateDto> {
    blocking(app, move |app| {
        quick_notes_state_impl(&app.state::<AppState>())
    })
    .await
}

/// Names the open vault's scratch folder (Settings → This vault).
#[tauri::command]
pub async fn scratch_folder_set<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> CmdResult<ScratchFolderDto> {
    blocking(app, move |app| {
        scratch_folder_set_impl(&app.state::<AppState>(), name)
    })
    .await
}
