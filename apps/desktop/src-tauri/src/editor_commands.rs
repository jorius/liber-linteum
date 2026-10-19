//! Editor commands (M2a spec §3.1): full-text read, compare-and-swap write,
//! conflict copies, link resolution, and opening things outside the app.
//! Every command runs off the UI thread (see `vault_commands::blocking`).

use crate::error::{CmdResult, CommandError, ConflictInfo, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_markdown::LinkKind;
use nimw_session::{SessionError, is_text_content};
use nimw_vault::{Hash, VaultError, VaultPath};
use serde::{Deserialize, Serialize};
use std::path::Path;
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

/// The reply to a compare-and-swap write that found the file changed: a
/// `conflict` carrying what is on disk now, for the editor to merge. When that
/// isn't text the editor can take, `refused` instead, with no text: a lossy
/// decoding would be merged and written back over every character it lost
/// (final review I3).
pub(crate) fn conflict_reply(
    path: &str,
    bytes: Vec<u8>,
    current: Hash,
    refused: CommandError,
) -> CommandError {
    let Ok(text) = String::from_utf8(bytes) else {
        return refused;
    };
    let mut err = CommandError::new(
        ErrorKind::Conflict,
        format!("{path} changed on disk since it was opened"),
    );
    err.conflict = Some(ConflictInfo {
        current_text: text,
        current_hash: current.to_hex(),
    });
    err
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
    crate::vault_commands::not_archived(&path)?;
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
            let not_utf8 = CommandError::new(ErrorKind::Binary, format!("not UTF-8 text: {path}"));
            Err(conflict_reply(&path, bytes, current, not_utf8))
        }
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn text_read_impl(state: &AppState, path: String) -> CmdResult<PageText> {
    let session = state.session()?;
    let (text, hash) = session.read_text(&VaultPath::new(&path)?)?;
    Ok(PageText {
        text,
        hash: hash.to_hex(),
    })
}

/// `page_write` for text files (M4b part 2 §6): the same compare-and-swap,
/// and the same conflict reply carrying what is on disk now — `notAText` when
/// that is no longer an eligible text file (final review I3).
pub(crate) fn text_write_impl(
    state: &AppState,
    path: String,
    text: String,
    expected_hash: String,
) -> CmdResult<WriteResult> {
    crate::vault_commands::not_archived(&path)?;
    let session = state.session()?;
    let vp = VaultPath::new(&path)?;
    let expected = Hash::from_hex(&expected_hash)
        .ok_or_else(|| CommandError::new(ErrorKind::Io, "invalid content hash"))?;
    match session.write_text(&vp, &text, expected) {
        Ok(hash) => Ok(WriteResult {
            hash: hash.to_hex(),
        }),
        Err(SessionError::Vault(VaultError::Conflict { .. })) => {
            let (bytes, current) = session.vault().read(&vp)?;
            let not_text = CommandError::from(SessionError::NotAText(path.clone()));
            if !is_text_content(&bytes) {
                return Err(not_text);
            }
            Err(conflict_reply(&path, bytes, current, not_text))
        }
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn page_create_conflict_copy_impl(
    state: &AppState,
    path: String,
    text: String,
) -> CmdResult<String> {
    crate::vault_commands::not_archived(&path)?;
    let session = state.session()?;
    Ok(session
        .create_conflict_copy(&VaultPath::new(&path)?, &text)?
        .to_string())
}

/// `{ kind, target }` pairs from the UI; an unknown kind is refused.
pub(crate) fn parse_targets(targets: Vec<LinkTarget>) -> CmdResult<Vec<(LinkKind, String)>> {
    targets
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
        .collect()
}

pub(crate) fn links_resolve_impl(
    state: &AppState,
    source: String,
    targets: Vec<LinkTarget>,
) -> CmdResult<Vec<Option<String>>> {
    let session = state.session()?;
    let parsed = parse_targets(targets)?;
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

/// Extensions the OS would run (or install, or follow somewhere else) instead
/// of showing: programs, installers, scripts, shortcuts, launchers. Matched
/// case-insensitively against the file and, for a symlink, its target.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    // macOS
    "app",
    "command",
    "tool",
    "terminal",
    "pkg",
    "mpkg",
    "dmg",
    "scpt",
    "scptd",
    "applescript",
    "workflow",
    "action",
    "prefpane",
    "kext",
    "webloc",
    "inetloc",
    "fileloc",
    // Windows
    "exe",
    "msi",
    "msix",
    "msp",
    "appx",
    "appxbundle",
    "bat",
    "cmd",
    "com",
    "scr",
    "pif",
    "cpl",
    "lnk",
    "url",
    "reg",
    "hta",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "gadget",
    "application",
    // Unix, cross-platform
    "sh",
    "bash",
    "zsh",
    "csh",
    "ksh",
    "fish",
    "desktop",
    "appimage",
    "run",
    "deb",
    "rpm",
    "jar",
    "py",
    "pyw",
    "pl",
    "rb",
];

fn refuse(full: &Path, why: &str) -> CommandError {
    CommandError::new(
        ErrorKind::InvalidUrl,
        format!("refusing to open {}: {why}", full.display()),
    )
}

fn executable_name(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXECUTABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Checks that `full` may be handed to the OS's default app (review m3): a
/// regular file (a folder may be an .app bundle) that is no program, script or
/// installer by name, and on Unix is not an extensionless file with an exec
/// bit (a binary or script). Exec bits on files with an extension are ignored:
/// exFAT/SMB volumes set them on everything, and the OS opens such a file by
/// its type rather than running it. Symlinks are judged by their target.
pub(crate) fn check_openable(full: &Path) -> CmdResult<()> {
    let real = std::fs::canonicalize(full)
        .map_err(|e| CommandError::new(ErrorKind::NotFound, e.to_string()))?;
    let meta = std::fs::metadata(&real)
        .map_err(|e| CommandError::new(ErrorKind::NotFound, e.to_string()))?;
    if !meta.is_file() {
        return Err(refuse(full, "not a regular file"));
    }
    if executable_name(full) || executable_name(&real) {
        return Err(refuse(full, "a program or script"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let extensionless = full.extension().is_none() || real.extension().is_none();
        if extensionless && meta.permissions().mode() & 0o111 != 0 {
            return Err(refuse(full, "marked executable"));
        }
    }
    Ok(())
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
    check_openable(&full)?;
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
pub async fn text_read<R: Runtime>(app: AppHandle<R>, path: String) -> CmdResult<PageText> {
    blocking(app, move |app| {
        text_read_impl(&app.state::<AppState>(), path)
    })
    .await
}

#[tauri::command]
pub async fn text_write<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    text: String,
    expected_hash: String,
) -> CmdResult<WriteResult> {
    blocking(app, move |app| {
        text_write_impl(&app.state::<AppState>(), path, text, expected_hash)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(full: &Path) -> bool {
        matches!(check_openable(full), Err(e) if e.kind == ErrorKind::InvalidUrl)
    }

    #[test]
    fn m3_only_plain_documents_open_in_the_default_app() {
        let dir = tempfile::tempdir().unwrap();
        let p = |name: &str| dir.path().join(name);
        std::fs::write(p("brief.pdf"), b"%PDF").unwrap();
        std::fs::write(p("Notes.MD"), b"# x").unwrap();
        std::fs::create_dir(p("Folder")).unwrap();
        std::fs::create_dir_all(p("Evil.app/Contents/MacOS")).unwrap();
        for name in [
            "run.sh",
            "Setup.EXE",
            "x.command",
            "y.app",
            "z.ps1",
            "w.jar",
            "s.scpt",
        ] {
            std::fs::write(p(name), b"x").unwrap();
        }
        assert!(check_openable(&p("brief.pdf")).is_ok());
        assert!(check_openable(&p("Notes.MD")).is_ok());
        assert!(refused(&p("Folder")), "a folder");
        assert!(refused(&p("Evil.app")), "an app bundle");
        for name in [
            "run.sh",
            "Setup.EXE",
            "x.command",
            "y.app",
            "z.ps1",
            "w.jar",
            "s.scpt",
        ] {
            assert!(refused(&p(name)), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn m3_files_with_an_exec_bit_are_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("tool");
        std::fs::write(&tool, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o744)).unwrap();
        assert!(refused(&tool));
        let pdf = dir.path().join("doc.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        std::fs::set_permissions(&pdf, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(check_openable(&pdf).is_ok());
        // exFAT/SMB volumes mark every file executable: a document with an
        // extension still opens (the OS picks the app by type, it never runs it).
        std::fs::set_permissions(&pdf, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            check_openable(&pdf).is_ok(),
            "an exec-bit document on exFAT/SMB"
        );
        // A symlink is judged by what it points to.
        let link = dir.path().join("innocent.pdf");
        std::os::unix::fs::symlink(&tool, &link).unwrap();
        assert!(refused(&link));
    }
}
