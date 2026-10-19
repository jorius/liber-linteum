//! M2c page extras (spec §7): pasted and dropped attachments, cover upload,
//! `[[` suggestions and the vault's attachment setting. Thin wrappers over
//! `nimw-session`; outside paths only come from native drops (`drops`) or a
//! dialog Rust opens itself (spec §8).

use crate::dto::{
    AttachedDto, AttachmentsDto, CoverDto, ImportResultDto, LinkSuggestionDto, VaultSettingsDto,
    VaultSettingsPatch,
};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_session::{VaultSession, cover_reference};
use nimw_vault::{EntryKind, VaultPath};
use percent_encoding::percent_decode_str;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Largest pasted image (spec §7.3).
pub const MAX_PASTE_BYTES: usize = 64 * 1024 * 1024;
/// Image types a paste may save.
pub const PASTE_EXTENSIONS: &[&str] = &["png", "jpg", "gif", "webp"];
/// Image types the cover dialog offers.
pub const COVER_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"];
/// Most suggestions per `[[` query.
pub const SUGGEST_LIMIT: usize = 50;

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::InvalidName, message)
}

/// The page an attachment is placed for (final review M7): a visible file on
/// disk that the index knows as a page. A hidden or excluded path
/// (`.obsidian/x.md`, `.git/hooks/x.md`) would steer the attachment folder
/// policy into that folder, so it is refused like a missing page.
fn visible_page(session: &VaultSession, page: &str) -> CmdResult<VaultPath> {
    let path = VaultPath::new(page)?;
    let on_disk = session
        .vault()
        .stat(&path)?
        .is_some_and(|e| e.kind == EntryKind::File);
    if !on_disk || session.page(&path)?.is_none() {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("not a page in the vault: {page}"),
        ));
    }
    Ok(path)
}

/// The page path, file name and bytes of a paste: a raw body with
/// percent-encoded `x-nimw-page` / `x-nimw-name` headers.
fn paste_parts(request: &Request<'_>) -> CmdResult<(String, String, Vec<u8>)> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(invalid("expected the image bytes as a raw body"));
    };
    if bytes.len() > MAX_PASTE_BYTES {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("pasted images are limited to {} MiB", MAX_PASTE_BYTES >> 20),
        ));
    }
    let header = |name: &str| -> CmdResult<String> {
        let raw = request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| invalid(format!("missing {name}")))?;
        percent_decode_str(raw)
            .decode_utf8()
            .map(|s| s.into_owned())
            .map_err(|_| invalid(format!("{name} is not UTF-8")))
    };
    Ok((
        header("x-nimw-page")?,
        header("x-nimw-name")?,
        bytes.clone(),
    ))
}

pub(crate) fn attachment_paste_impl(
    state: &AppState,
    page: String,
    name: String,
    bytes: Vec<u8>,
) -> CmdResult<AttachedDto> {
    let session = state.session()?;
    let page = visible_page(&session, &page)?;
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !PASTE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(invalid("only png, jpg, gif and webp images can be pasted"));
    }
    if bytes.is_empty() {
        return Err(invalid("the pasted image is empty"));
    }
    Ok(session.save_attachment(&page, &name, &bytes)?.into())
}

pub(crate) fn attachment_import_impl(
    state: &AppState,
    page: String,
    paths: Vec<String>,
) -> CmdResult<Vec<ImportResultDto>> {
    let session = state.session()?;
    let page = visible_page(&session, &page)?;
    Ok(paths
        .into_iter()
        .map(|source| {
            let path = PathBuf::from(&source);
            let result = if state.take_drop_grant(&path) {
                session
                    .import_attachment(&page, &path)
                    .map(AttachedDto::from)
                    .map_err(CommandError::from)
            } else {
                Err(CommandError::new(
                    ErrorKind::NotPermitted,
                    format!("{source} was not dropped onto the window"),
                ))
            };
            match result {
                Ok(attached) => ImportResultDto {
                    source,
                    ok: Some(attached),
                    err: None,
                },
                Err(e) => ImportResultDto {
                    source,
                    ok: None,
                    err: Some(e),
                },
            }
        })
        .collect())
}

pub(crate) fn cover_pick_impl<R: Runtime>(
    app: &AppHandle<R>,
    page: String,
) -> CmdResult<Option<CoverDto>> {
    let state = app.state::<AppState>();
    let session = state.session()?;
    let page = visible_page(&session, &page)?;
    let picked = match state.cover_picker() {
        Some(pick) => pick(),
        None => app
            .dialog()
            .file()
            .add_filter("Images", COVER_EXTENSIONS)
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok()),
    };
    let Some(path) = picked else {
        return Ok(None);
    };
    let attached = session.import_attachment(&page, &path)?;
    Ok(Some(CoverDto {
        reference: cover_reference(&page, &attached.path),
        path: attached.path.to_string(),
    }))
}

pub(crate) fn link_suggest_impl(
    state: &AppState,
    source: String,
    query: String,
    embed: bool,
) -> CmdResult<Vec<LinkSuggestionDto>> {
    let session = state.session()?;
    let source = VaultPath::new(&source)?;
    Ok(session
        .link_suggest(&source, &query, embed, SUGGEST_LIMIT)?
        .into_iter()
        .map(|s| LinkSuggestionDto {
            path: s.path,
            kind: s.kind.as_str(),
            title: s.title,
            target: s.target,
        })
        .collect())
}

pub(crate) fn vault_settings_get_impl(state: &AppState) -> CmdResult<VaultSettingsDto> {
    let config = state.session()?.attachment_settings();
    Ok(VaultSettingsDto {
        attachments: AttachmentsDto {
            mode: config.mode,
            path: config.path,
        },
        obsidian: config.obsidian,
    })
}

pub(crate) fn vault_settings_set_impl(
    state: &AppState,
    patch: VaultSettingsPatch,
) -> CmdResult<VaultSettingsDto> {
    let session = state.session()?;
    if let Some(a) = patch.attachments {
        session.set_attachment_settings(&a.mode, &a.path)?;
    }
    vault_settings_get_impl(state)
}

#[tauri::command]
pub async fn attachment_paste<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> CmdResult<AttachedDto> {
    let (page, name, bytes) = paste_parts(&request)?;
    blocking(app, move |app| {
        attachment_paste_impl(&app.state::<AppState>(), page, name, bytes)
    })
    .await
}

#[tauri::command]
pub async fn attachment_import<R: Runtime>(
    app: AppHandle<R>,
    page: String,
    paths: Vec<String>,
) -> CmdResult<Vec<ImportResultDto>> {
    blocking(app, move |app| {
        attachment_import_impl(&app.state::<AppState>(), page, paths)
    })
    .await
}

#[tauri::command]
pub async fn cover_pick<R: Runtime>(
    app: AppHandle<R>,
    page: String,
) -> CmdResult<Option<CoverDto>> {
    blocking(app, move |app| cover_pick_impl(&app, page)).await
}

#[tauri::command]
pub async fn link_suggest<R: Runtime>(
    app: AppHandle<R>,
    source: String,
    query: String,
    embed: bool,
) -> CmdResult<Vec<LinkSuggestionDto>> {
    blocking(app, move |app| {
        link_suggest_impl(&app.state::<AppState>(), source, query, embed)
    })
    .await
}

#[tauri::command]
pub async fn vault_settings_get<R: Runtime>(app: AppHandle<R>) -> CmdResult<VaultSettingsDto> {
    blocking(app, move |app| {
        vault_settings_get_impl(&app.state::<AppState>())
    })
    .await
}

#[tauri::command]
pub async fn vault_settings_set<R: Runtime>(
    app: AppHandle<R>,
    patch: VaultSettingsPatch,
) -> CmdResult<VaultSettingsDto> {
    blocking(app, move |app| {
        vault_settings_set_impl(&app.state::<AppState>(), patch)
    })
    .await
}
