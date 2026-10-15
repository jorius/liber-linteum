//! Commands of single-file windows (M4c §3, §4). None takes the path of the
//! file to read or write: each acts on the calling window's grant
//! (`file_windows`). Paths the page does send (a link it follows, a note it
//! embeds) are relative to the file's folder and checked like vault paths;
//! they are only ever read, or opened in a window of their own.

use crate::editor_commands::{
    LinkTarget, PageText, WriteResult, check_openable, conflict_reply, parse_targets,
};
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::file_windows::{
    FileGrant, FileKind, FileWindows, file_kind, grant_for, open_file_window,
};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_markdown::resolve;
use nimw_session::{is_text_content, opens_from_notes};
use nimw_vault::{Hash, VaultError, VaultPath, is_hidden_name};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Sent to the main window: open `root` and show `page` (M4c §3 "Open in its
/// vault").
pub const OPEN_IN_VAULT_EVENT: &str = "file:open-in-vault";

/// Characters a renamed file can't have (as for names made in a vault).
const FORBIDDEN_NAME_CHARS: &[char] = &[
    '/', '\\', '#', '|', '^', '[', ']', ':', '*', '"', '<', '>', '?',
];

/// `file_info`: what the window shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoDto {
    pub name: String,
    pub kind: FileKind,
    /// The file's folder, absolute (shown, never sent back).
    pub folder: String,
    /// A recent vault holding the file, for "Open in its vault".
    pub vault: Option<HomeVault>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeVault {
    pub root: String,
    pub name: String,
    /// The file's path in that vault.
    pub page: String,
}

/// The deepest recent vault whose folder holds `file` through visible
/// folders (a file under `.obsidian/` is in no vault's tree).
fn home_vault(state: &AppState, file: &Path) -> Option<HomeVault> {
    state
        .settings
        .recent()
        .into_iter()
        .filter(|r| !r.missing)
        .filter_map(|r| {
            let root = dunce::canonicalize(&r.path).ok()?;
            let page = VaultPath::from_fs_path(&root, file).ok()?;
            if page.is_root() || page.as_str().split('/').any(is_hidden_name) {
                return None;
            }
            Some((root, r.name, page))
        })
        .max_by_key(|(root, _, _)| root.components().count())
        .and_then(|(root, name, page)| {
            Some(HomeVault {
                root: root.to_str()?.to_string(),
                name,
                page: page.to_string(),
            })
        })
}

fn not_permitted(what: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::NotPermitted, what)
}

/// The file's text: a note must be UTF-8 (`binary`), a text file eligible
/// text (`notAText`, M4b part 2 §6).
fn text_for(kind: FileKind, path: &VaultPath, bytes: Vec<u8>) -> CmdResult<String> {
    if kind == FileKind::Text && !is_text_content(&bytes) {
        return Err(CommandError::new(
            ErrorKind::NotAText,
            format!("not a text file: {path}"),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| CommandError::new(ErrorKind::Binary, format!("not UTF-8 text: {path}")))
}

/// A folder-relative path the page names: valid, below the folder, visible.
fn folder_path(path: &str) -> CmdResult<VaultPath> {
    let vp = VaultPath::new(path)?;
    if vp.as_str().split('/').any(is_hidden_name) {
        return Err(not_permitted(format!("hidden: {path}")));
    }
    Ok(vp)
}

pub(crate) fn file_info_impl(state: &AppState, grant: &FileGrant) -> CmdResult<FileInfoDto> {
    let folder = grant
        .folder()
        .to_str()
        .ok_or_else(|| CommandError::new(ErrorKind::InvalidName, "folder name"))?;
    Ok(FileInfoDto {
        name: grant.name().to_string(),
        kind: grant.kind(),
        folder: folder.to_string(),
        vault: home_vault(state, &grant.real_path()),
    })
}

pub(crate) fn file_read_impl(grant: &FileGrant) -> CmdResult<PageText> {
    let name = grant.name();
    let (bytes, hash) = grant.vault().read(&name)?;
    Ok(PageText {
        text: text_for(grant.kind(), &name, bytes)?,
        hash: hash.to_hex(),
    })
}

/// Compare-and-swap, as `page_write` / `text_write`.
pub(crate) fn file_write_impl(
    grant: &FileGrant,
    text: String,
    expected_hash: String,
) -> CmdResult<WriteResult> {
    let name = grant.name();
    let expected = Hash::from_hex(&expected_hash)
        .ok_or_else(|| CommandError::new(ErrorKind::Io, "invalid content hash"))?;
    let refused = |what: &str| CommandError::new(ErrorKind::NotAText, format!("{what}: {name}"));
    if grant.kind() == FileKind::Text && !is_text_content(text.as_bytes()) {
        return Err(refused("not text the file can take"));
    }
    match grant
        .vault()
        .write_cas(&name, text.as_bytes(), Some(expected))
    {
        Ok(hash) => Ok(WriteResult {
            hash: hash.to_hex(),
        }),
        Err(VaultError::Conflict { .. }) => {
            let (bytes, current) = grant.vault().read(&name)?;
            let not_text = match grant.kind() {
                FileKind::Text => refused("not a text file"),
                FileKind::Page => {
                    CommandError::new(ErrorKind::Binary, format!("not UTF-8 text: {name}"))
                }
            };
            if grant.kind() == FileKind::Text && !is_text_content(&bytes) {
                return Err(not_text);
            }
            Err(conflict_reply(name.as_str(), bytes, current, not_text))
        }
        Err(e) => Err(e.into()),
    }
}

/// `<stem> (conflict).<ext>` next to the file (then ` (conflict 2)`…),
/// never over an existing file.
pub(crate) fn file_conflict_copy_impl(grant: &FileGrant, text: String) -> CmdResult<String> {
    let name = grant.name();
    let ext = name
        .extension()
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let stem = name.stem().to_string();
    for n in 1.. {
        let copy = if n == 1 {
            format!("{stem} (conflict){ext}")
        } else {
            format!("{stem} (conflict {n}){ext}")
        };
        match grant
            .vault()
            .write_cas(&VaultPath::new(&copy)?, text.as_bytes(), None)
        {
            Ok(_) => return Ok(copy),
            Err(VaultError::AlreadyExists(_)) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!("the loop only ends by returning")
}

/// The file again, empty, where it was (deleted outside with unsaved text:
/// "Save again"). Only while it is gone.
pub(crate) fn file_recreate_impl(grant: &FileGrant) -> CmdResult<String> {
    let name = grant.name();
    grant.vault().write_cas(&name, b"", None)?;
    Ok(name.to_string())
}

/// Same folder, same extension; the window's title follows.
pub(crate) fn file_rename_impl<R: Runtime>(
    window: &Window<R>,
    grant: &FileGrant,
    new_name: String,
) -> CmdResult<String> {
    let invalid = || CommandError::new(ErrorKind::InvalidName, format!("invalid name: {new_name}"));
    let name = new_name.trim();
    if name.is_empty()
        || name.contains(FORBIDDEN_NAME_CHARS)
        || name.chars().any(char::is_control)
        || is_hidden_name(name)
    {
        return Err(invalid());
    }
    let old = grant.name();
    let to = VaultPath::new(name)?;
    let same_ext = match (old.extension(), to.extension()) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b) && !to.stem().is_empty(),
        (None, None) => true,
        _ => false,
    };
    if !same_ext {
        return Err(invalid());
    }
    if to != old {
        grant.vault().rename(&old, &to)?;
        grant.set_name(to.clone());
        let _ = window.set_title(to.file_name());
    }
    Ok(to.to_string())
}

pub(crate) fn file_links_resolve_impl(
    grant: &FileGrant,
    targets: Vec<LinkTarget>,
) -> CmdResult<Vec<Option<String>>> {
    let parsed = parse_targets(targets)?;
    let files = grant.files();
    let source = grant.name();
    Ok(parsed
        .iter()
        .map(|(kind, target)| resolve(*kind, target, source.as_str(), &files))
        .collect())
}

/// Another note or text file in the folder, read only (an embed, a heading
/// to complete).
pub(crate) fn file_note_read_impl(grant: &FileGrant, path: String) -> CmdResult<PageText> {
    let vp = folder_path(&path)?;
    let kind = file_kind(vp.file_name()).ok_or_else(|| {
        CommandError::new(
            ErrorKind::NotAText,
            format!("not a note or text file: {path}"),
        )
    })?;
    let (bytes, hash) = grant.vault().read(&vp)?;
    Ok(PageText {
        text: text_for(kind, &vp, bytes)?,
        hash: hash.to_hex(),
    })
}

/// What following a link did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Followed {
    /// A note or text file: in a window of its own.
    Window,
    /// A document or media file: in its default app.
    Opened,
}

/// A link the user clicked, to a file in the folder.
pub(crate) fn file_follow_impl<R: Runtime>(
    app: &AppHandle<R>,
    grant: &FileGrant,
    path: String,
) -> CmdResult<Followed> {
    let vp = folder_path(&path)?;
    match grant.vault().stat(&vp)? {
        Some(entry) if entry.kind == nimw_vault::EntryKind::File => {}
        Some(_) => return Err(CommandError::new(ErrorKind::NotAFile, path)),
        None => return Err(CommandError::new(ErrorKind::NotFound, path)),
    }
    let full = grant.vault().fs_path(&vp)?;
    if file_kind(vp.file_name()).is_some() {
        open_file_window(app, &full)?;
        return Ok(Followed::Window);
    }
    if !opens_from_notes(vp.as_str()) {
        return Err(not_permitted(format!(
            "{path}: only notes, documents and media open from a note"
        )));
    }
    check_openable(&full)?;
    app.opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?;
    Ok(Followed::Opened)
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenInVault {
    pub root: String,
    pub page: String,
}

/// The main window opens the vault holding the file, at its page (a fresh
/// main window gets them in its address).
pub(crate) fn file_open_in_vault_impl<R: Runtime>(
    app: &AppHandle<R>,
    grant: &FileGrant,
) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let home = home_vault(&state, &grant.real_path())
        .ok_or_else(|| CommandError::new(ErrorKind::NotFound, "no recent vault holds this file"))?;
    let payload = OpenInVault {
        root: home.root,
        page: home.page,
    };
    if let Some(main) = app.get_webview_window("main") {
        app.emit_to("main", OPEN_IN_VAULT_EVENT, payload)
            .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?;
        let _ = main.unminimize();
        let _ = main.set_focus();
        return Ok(());
    }
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| CommandError::new(ErrorKind::Io, "no main window configured"))?;
    let query = |s: &str| {
        percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
    };
    config.url = WebviewUrl::App(PathBuf::from(format!(
        "index.html?vault={}&page={}",
        query(&payload.root),
        query(&payload.page)
    )));
    WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build())
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?;
    Ok(())
}

/// Dialog filters (M4c §3): notes and plain text first, then everything (a
/// code file); macOS joins filters into one list of types, so none there.
fn open_filters(macos: bool) -> &'static [(&'static str, &'static [&'static str])] {
    if macos {
        &[]
    } else {
        &[
            ("Notes and text", &["md", "markdown", "txt"]),
            ("All files", &["*"]),
        ]
    }
}

/// File → Open File…: a dialog Rust opens itself; every pick it can show
/// opens in a window. Answers the names it can't open.
pub(crate) fn file_open_dialog_impl<R: Runtime>(app: &AppHandle<R>) -> CmdResult<Vec<String>> {
    let picked: Vec<PathBuf> = match app.state::<FileWindows>().picker() {
        Some(pick) => pick(),
        None => {
            let mut dialog = app.dialog().file();
            for (name, extensions) in open_filters(cfg!(target_os = "macos")) {
                dialog = dialog.add_filter(*name, extensions);
            }
            dialog
                .blocking_pick_files()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|f| f.into_path().ok())
                .collect()
        }
    };
    Ok(open_paths(app, &picked))
}

/// Opens each path in a window; answers the names it couldn't open.
pub fn open_paths<R: Runtime>(app: &AppHandle<R>, paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|p| open_file_window(app, p).is_err())
        .map(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.display().to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_open_dialog_starts_on_notes_and_offers_everything() {
        let windows = open_filters(false);
        assert_eq!(windows[0].0, "Notes and text");
        assert!(windows[0].1.contains(&"md"));
        assert_eq!(windows[1], ("All files", &["*"][..]));
        assert!(open_filters(true).is_empty());
    }
}

// ---- command wrappers: off the UI thread, each on the caller's grant ----

#[tauri::command]
pub async fn file_info<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> CmdResult<FileInfoDto> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_info_impl(&app.state::<AppState>(), grant_for(&app, &label)?.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn file_read<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> CmdResult<PageText> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_read_impl(grant_for(&app, &label)?.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn file_write<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    text: String,
    expected_hash: String,
) -> CmdResult<WriteResult> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_write_impl(grant_for(&app, &label)?.as_ref(), text, expected_hash)
    })
    .await
}

#[tauri::command]
pub async fn file_conflict_copy<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    text: String,
) -> CmdResult<String> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_conflict_copy_impl(grant_for(&app, &label)?.as_ref(), text)
    })
    .await
}

#[tauri::command]
pub async fn file_recreate<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> CmdResult<String> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_recreate_impl(grant_for(&app, &label)?.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn file_rename<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    new_name: String,
) -> CmdResult<String> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_rename_impl(&window, grant_for(&app, &label)?.as_ref(), new_name)
    })
    .await
}

#[tauri::command]
pub async fn file_links_resolve<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    targets: Vec<LinkTarget>,
) -> CmdResult<Vec<Option<String>>> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_links_resolve_impl(grant_for(&app, &label)?.as_ref(), targets)
    })
    .await
}

#[tauri::command]
pub async fn file_note_read<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    path: String,
) -> CmdResult<PageText> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_note_read_impl(grant_for(&app, &label)?.as_ref(), path)
    })
    .await
}

#[tauri::command]
pub async fn file_follow<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    path: String,
) -> CmdResult<Followed> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_follow_impl(&app, grant_for(&app, &label)?.as_ref(), path)
    })
    .await
}

#[tauri::command]
pub async fn file_open_in_vault<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> CmdResult<()> {
    let label = window.label().to_string();
    blocking(app, move |app| {
        file_open_in_vault_impl(&app, grant_for(&app, &label)?.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn file_open_dialog<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<String>> {
    blocking(app, move |app| file_open_dialog_impl(&app)).await
}
