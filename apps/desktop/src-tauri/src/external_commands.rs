//! Files outside the vault (M4b part 3 §9) and the Attach button's file
//! dialog (§7). Outside files are only shown or opened through the session's
//! allow-list (`VaultSession::external_file`); picked paths come from a
//! dialog Rust opens itself and are granted for `attachment_import` once, like
//! dropped ones (M2c §8).

use crate::editor_commands::{LinkTarget, check_openable, parse_targets};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_session::file_url;
use nimw_vault::VaultPath;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// `links_external`: an outside file a link names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalFileDto {
    /// Absolute, in its OS's form.
    pub path: String,
    pub exists: bool,
    /// Linked from an indexed page: the app may show or open it.
    pub listed: bool,
}

/// `file_pick`: one file chosen in the dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFileDto {
    pub path: String,
    pub name: String,
    /// Its `file:` URL, for "Link to where it is".
    pub url: String,
    /// The vault path when the file is already in the vault (it is linked,
    /// never copied or asked about).
    pub in_vault: Option<String>,
}

/// Dialog filters by kind (§7). macOS joins every filter into one list of
/// allowed types (rfd 0.16), so there a filter would hide "All files":
/// the panel shows everything instead.
const FILTERS: &[(&str, &[&str])] = &[
    (
        "Images",
        &[
            "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "tif", "tiff", "heic",
        ],
    ),
    ("Audio", &["mp3", "m4a", "wav", "ogg", "flac"]),
    ("Documents", &["pdf"]),
    ("All files", &["*"]),
];

pub(crate) fn links_external_impl(
    state: &AppState,
    source: String,
    targets: Vec<LinkTarget>,
) -> CmdResult<Vec<Option<ExternalFileDto>>> {
    let session = state.session()?;
    let parsed = parse_targets(targets)?;
    Ok(session
        .externals(&VaultPath::new(&source)?, &parsed)?
        .into_iter()
        .map(|f| {
            f.map(|f| ExternalFileDto {
                path: f.path,
                exists: f.exists,
                listed: f.listed,
            })
        })
        .collect())
}

pub(crate) fn external_open_impl<R: Runtime>(app: &AppHandle<R>, path: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let real = state.session()?.external_file(&path)?;
    check_openable(&real)?;
    app.opener()
        .open_path(real.to_string_lossy(), None::<&str>)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

pub(crate) fn external_reveal_impl<R: Runtime>(app: &AppHandle<R>, path: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let real = state.session()?.external_file(&path)?;
    app.opener()
        .reveal_item_in_dir(real)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

/// Opens the file dialog for `page` (a page must be open: the files are for
/// it). The picked paths are granted for `attachment_import`.
pub(crate) fn file_pick_impl<R: Runtime>(
    app: &AppHandle<R>,
    page: String,
) -> CmdResult<Vec<PickedFileDto>> {
    let state = app.state::<AppState>();
    let session = state.session()?;
    VaultPath::new(&page)?;
    let picked: Vec<PathBuf> = match state.file_picker() {
        Some(pick) => pick(),
        None => {
            let mut dialog = app.dialog().file();
            if !cfg!(target_os = "macos") {
                for (name, extensions) in FILTERS {
                    dialog = dialog.add_filter(*name, extensions);
                }
            }
            dialog
                .blocking_pick_files()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|f| f.into_path().ok())
                .collect()
        }
    };
    state.grant_drops(&picked);
    Ok(picked
        .into_iter()
        .filter_map(|path| {
            let shown = path.to_str()?.to_string();
            Some(PickedFileDto {
                name: path.file_name()?.to_string_lossy().into_owned(),
                url: file_url(&shown),
                in_vault: session.vault_path_of(&path).map(|p| p.to_string()),
                path: shown,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn links_external<R: Runtime>(
    app: AppHandle<R>,
    source: String,
    targets: Vec<LinkTarget>,
) -> CmdResult<Vec<Option<ExternalFileDto>>> {
    blocking(app, move |app| {
        links_external_impl(&app.state::<AppState>(), source, targets)
    })
    .await
}

#[tauri::command]
pub async fn external_open<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<()> {
    blocking(app, move |app| external_open_impl(&app, path)).await
}

#[tauri::command]
pub async fn external_reveal<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<()> {
    blocking(app, move |app| external_reveal_impl(&app, path)).await
}

#[tauri::command]
pub async fn file_pick<R: Runtime>(
    app: AppHandle<R>,
    page: String,
) -> CmdResult<Vec<PickedFileDto>> {
    blocking(app, move |app| file_pick_impl(&app, page)).await
}
