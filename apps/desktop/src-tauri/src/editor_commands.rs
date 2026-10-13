//! Editor commands (M2a spec §3.1): full-text read, compare-and-swap write,
//! conflict copies, link resolution, and opening things outside the app.
//! Every command runs off the UI thread (see `vault_commands::blocking`).

use crate::error::{CmdResult, CommandError, ConflictInfo, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_markdown::LinkKind;
use nimw_session::SessionError;
use nimw_vault::{Hash, VaultError, VaultPath};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageText {
    pub text: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WriteResult {
    pub hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LinkTarget {
    pub kind: String,
    pub target: String,
}

fn text_of(bytes: Vec<u8>, path: &VaultPath) -> CmdResult<String> {
    String::from_utf8(bytes)
        .map_err(|_| CommandError::new(ErrorKind::Binary, format!("not UTF-8 text: {path}")))
}

pub(crate) fn page_read_impl(state: &AppState, path: String) -> CmdResult<PageText> {
    let session = state.session()?;
    let vp = VaultPath::new(&path)?;
    let (bytes, hash) = session.vault().read(&vp)?;
    Ok(PageText {
        text: text_of(bytes, &vp)?,
        hash: hash.to_hex(),
    })
}

pub(crate) fn page_write_impl(
    state: &AppState,
    path: String,
    text: String,
    expected_hash: String,
) -> CmdResult<WriteResult> {
    let session = state.session()?;
    let vp = VaultPath::new(&path)?;
    let expected = Hash::from_hex(&expected_hash)
        .ok_or_else(|| CommandError::new(ErrorKind::Io, "invalid content hash"))?;
    match session.write_page(&vp, &text, expected) {
        Ok(hash) => Ok(WriteResult {
            hash: hash.to_hex(),
        }),
        Err(SessionError::Vault(VaultError::Conflict { .. })) => {
            let (bytes, current) = session.vault().read(&vp)?;
            let mut err = CommandError::new(
                ErrorKind::Conflict,
                format!("{path} changed on disk since it was opened"),
            );
            err.conflict = Some(ConflictInfo {
                current_text: String::from_utf8_lossy(&bytes).into_owned(),
                current_hash: current.to_hex(),
            });
            Err(err)
        }
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn page_create_conflict_copy_impl(
    state: &AppState,
    path: String,
    text: String,
) -> CmdResult<String> {
    let session = state.session()?;
    Ok(session
        .create_conflict_copy(&VaultPath::new(&path)?, &text)?
        .to_string())
}

pub(crate) fn links_resolve_impl(
    state: &AppState,
    source: String,
    targets: Vec<LinkTarget>,
) -> CmdResult<Vec<Option<String>>> {
    let session = state.session()?;
    let parsed = targets
        .into_iter()
        .map(|t| {
            LinkKind::parse(&t.kind)
                .map(|k| (k, t.target))
                .ok_or_else(|| {
                    CommandError::new(
                        ErrorKind::InvalidUrl,
                        format!("unknown link kind: {}", t.kind),
                    )
                })
        })
        .collect::<CmdResult<Vec<_>>>()?;
    Ok(session.resolve_links(&VaultPath::new(&source)?, &parsed)?)
}

/// Only web and mail links leave the app (M2a §3.4, P1: the OS browser, never the webview).
fn checked_url(url: &str) -> CmdResult<&str> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
    {
        Ok(url.trim())
    } else {
        Err(CommandError::new(
            ErrorKind::InvalidUrl,
            format!("refusing to open {url}"),
        ))
    }
}

pub(crate) fn url_open_impl<R: Runtime>(app: &AppHandle<R>, url: String) -> CmdResult<()> {
    let url = checked_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

pub(crate) fn file_open_external_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: String,
) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let session = state.session()?;
    let vp = VaultPath::new(&path)?;
    if session.vault().stat(&vp)?.is_none() {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("not found: {path}"),
        ));
    }
    let full = session.vault().fs_path(&vp)?;
    app.opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

// ---- command wrappers: run off the UI thread ----

#[tauri::command]
pub async fn page_read<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<PageText> {
    blocking(app, move |app| {
        page_read_impl(&app.state::<AppState>(), path)
    })
    .await
}

#[tauri::command]
pub async fn page_write<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    text: String,
    expected_hash: String,
) -> CmdResult<WriteResult> {
    blocking(app, move |app| {
        page_write_impl(&app.state::<AppState>(), path, text, expected_hash)
    })
    .await
}

#[tauri::command]
pub async fn page_create_conflict_copy<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    text: String,
) -> CmdResult<String> {
    blocking(app, move |app| {
        page_create_conflict_copy_impl(&app.state::<AppState>(), path, text)
    })
    .await
}

#[tauri::command]
pub async fn links_resolve<R: Runtime>(
    app: AppHandle<R>,
    source: String,
    targets: Vec<LinkTarget>,
) -> CmdResult<Vec<Option<String>>> {
    blocking(app, move |app| {
        links_resolve_impl(&app.state::<AppState>(), source, targets)
    })
    .await
}

#[tauri::command]
pub async fn url_open<R: Runtime>(app: AppHandle<R>, url: String) -> CmdResult<()> {
    blocking(app, move |app| url_open_impl(&app, url)).await
}

#[tauri::command]
pub async fn file_open_external<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<()> {
    blocking(app, move |app| file_open_external_impl(&app, path)).await
}
