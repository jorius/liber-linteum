//! M7 Notion import (spec §3, §9): a Notion export zip becomes a new vault.
//!
//! The page never names a path: the zip and the new vault's parent folder
//! are whatever the user last picked in dialogs Rust opened; the page only
//! types the new vault's name.

use crate::dto::VaultInfo;
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::vault_commands::{blocking, open_session};
use nimw_import::{Export, ImportError, Limits, PREVIEW_WARNINGS, clean_component};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Import progress, to the main window: `{ done, total }`.
pub const PROGRESS_EVENT: &str = "notion:progress";

/// Chooses a file or folder. Tests replace the native dialogs.
pub type Pick = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// The import's picks and its cancel flag, kept beside `AppState`.
#[derive(Default)]
pub struct NotionState {
    zip_picker: Mutex<Option<Pick>>,
    folder_picker: Mutex<Option<Pick>>,
    zip: Mutex<Option<PathBuf>>,
    parent: Mutex<Option<PathBuf>>,
    cancel: AtomicBool,
}

impl NotionState {
    /// Replaces the zip dialog (tests); `None` restores it.
    pub fn set_zip_picker(&self, pick: Option<Pick>) {
        *lock(&self.zip_picker) = pick;
    }

    /// Replaces the folder dialog (tests); `None` restores it.
    pub fn set_folder_picker(&self, pick: Option<Pick>) {
        *lock(&self.folder_picker) = pick;
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl From<ImportError> for CommandError {
    fn from(e: ImportError) -> CommandError {
        match e {
            ImportError::Vault(v) => v.into(),
            ImportError::Io(io) => io.into(),
            ImportError::Exists(p) => {
                CommandError::new(ErrorKind::AlreadyExists, format!("{p} already exists"))
            }
            ImportError::Limit(m) => CommandError::new(ErrorKind::NotPermitted, m),
            ImportError::Cancelled => {
                CommandError::new(ErrorKind::NotPermitted, "the import was cancelled")
            }
            ImportError::Zip(m) => {
                CommandError::new(ErrorKind::Io, format!("not a readable zip: {m}"))
            }
        }
    }
}

/// The export just picked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionZipDto {
    pub name: String,
    pub suggested_name: String,
}

/// The dry run (spec §3 step 3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPreviewDto {
    pub pages: usize,
    pub databases: usize,
    pub rows: usize,
    pub attachments: usize,
    pub folders: usize,
    pub bytes: u64,
    /// The first warnings; `more_warnings` counts the rest.
    pub warnings: Vec<String>,
    pub more_warnings: usize,
}

/// What the import did: the new vault, open, and its report page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDoneDto {
    pub vault: VaultInfo,
    pub report: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

fn not_permitted(message: &str) -> CommandError {
    CommandError::new(ErrorKind::NotPermitted, message)
}

fn picked_zip<R: Runtime>(app: &AppHandle<R>) -> CmdResult<PathBuf> {
    lock(&app.state::<NotionState>().zip)
        .clone()
        .ok_or_else(|| not_permitted("choose a Notion export first"))
}

pub(crate) fn notion_pick_zip_impl<R: Runtime>(app: &AppHandle<R>) -> Option<NotionZipDto> {
    let state = app.state::<NotionState>();
    let pick = lock(&state.zip_picker).clone();
    let picked = match pick {
        Some(pick) => pick(),
        None => app
            .dialog()
            .file()
            .add_filter("Notion export", &["zip"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok()),
    };
    *lock(&state.zip) = picked.clone();
    picked.map(|p| NotionZipDto {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        suggested_name: nimw_import::suggested_name(&p),
    })
}

pub(crate) fn notion_pick_parent_impl<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let state = app.state::<NotionState>();
    let pick = lock(&state.folder_picker).clone();
    let picked = match pick {
        Some(pick) => pick(),
        None => app
            .dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok()),
    };
    *lock(&state.parent) = picked.clone();
    picked.map(|p| p.to_string_lossy().into_owned())
}

pub(crate) fn notion_preview_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<NotionPreviewDto> {
    let state = app.state::<NotionState>();
    let export = Export::open(&picked_zip(app)?, &Limits::default())?;
    let plan = nimw_import::plan(&export, &state.cancel)?;
    let p = plan.preview();
    Ok(NotionPreviewDto {
        pages: p.pages,
        databases: p.databases,
        rows: p.rows,
        attachments: p.attachments,
        folders: p.folders,
        bytes: p.bytes,
        warnings: p.warnings.iter().take(PREVIEW_WARNINGS).cloned().collect(),
        more_warnings: p.warnings.len().saturating_sub(PREVIEW_WARNINGS),
    })
}

/// One plain folder name, as the vault's name rules would leave it.
fn vault_name(name: &str) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || clean_component(name, false) != name {
        return Err(CommandError::new(
            ErrorKind::InvalidName,
            format!("invalid name: {name}"),
        ));
    }
    Ok(name.to_string())
}

pub(crate) fn notion_import_impl<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
) -> CmdResult<NotionDoneDto> {
    let state = app.state::<NotionState>();
    let zip = picked_zip(app)?;
    let parent = lock(&state.parent)
        .clone()
        .ok_or_else(|| not_permitted("choose where the new vault goes first"))?;
    let target = parent.join(vault_name(&name)?);
    state.cancel.store(false, Ordering::Relaxed);
    let export = Export::open(&zip, &Limits::default())?;
    let plan = nimw_import::plan(&export, &state.cancel)?;
    let source = zip
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut progress = |done: usize, total: usize| {
        if done == total || last.elapsed() >= Duration::from_millis(100) {
            last = Instant::now();
            let _ = app.emit_to("main", PROGRESS_EVENT, Progress { done, total });
        }
    };
    let report = nimw_import::write(
        &export,
        &plan,
        &source,
        &target,
        &mut progress,
        &state.cancel,
    )?;
    *lock(&state.zip) = None;
    *lock(&state.parent) = None;
    let vault = open_session(app, &report.root)?;
    Ok(NotionDoneDto {
        vault,
        report: report.report,
        cancelled: report.cancelled,
    })
}

// ---- command wrappers: run off the UI thread ----

/// A Rust file dialog for the Notion export zip; `null` when cancelled.
#[tauri::command]
pub async fn notion_pick_zip<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<NotionZipDto>> {
    blocking(app, move |app| Ok(notion_pick_zip_impl(&app))).await
}

/// A Rust folder dialog for where the new vault goes; `null` when cancelled.
#[tauri::command]
pub async fn notion_pick_parent<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<String>> {
    blocking(app, move |app| Ok(notion_pick_parent_impl(&app))).await
}

/// The dry run: counts and warnings; nothing is written.
#[tauri::command]
pub async fn notion_preview<R: Runtime>(app: AppHandle<R>) -> CmdResult<NotionPreviewDto> {
    blocking(app, move |app| notion_preview_impl(&app)).await
}

/// Imports into a new folder `name` in the picked parent, then opens it.
#[tauri::command]
pub async fn notion_import<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> CmdResult<NotionDoneDto> {
    blocking(app, move |app| notion_import_impl(&app, name)).await
}

/// Asks a running import to stop after the file it is writing.
#[tauri::command]
pub async fn notion_cancel<R: Runtime>(app: AppHandle<R>) -> CmdResult<()> {
    app.state::<NotionState>()
        .cancel
        .store(true, Ordering::Relaxed);
    Ok(())
}
