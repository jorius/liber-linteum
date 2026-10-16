//! `nimw-asset:` — serves the open vault's files to the webview (M2a spec §2.5).
//!
//! Tauri's built-in asset protocol can only *add* allowed directories, so a
//! vault that was open earlier would stay readable after switching vaults.
//! This protocol instead resolves every request through the current session:
//! `VaultPath` validation (no `..`, no absolute paths, no symlink escapes),
//! hidden files refused, nothing served when no vault is open.

use crate::file_windows::{FileWindows, is_file_window};
use crate::state::AppState;
use nimw_vault::{Vault, VaultPath, is_hidden_path};
use percent_encoding::percent_decode_str;

pub const SCHEME: &str = "nimw-asset";

/// Policy for every `nimw-asset:` response (M2a review m2).
pub const CSP: &str = "default-src 'none'; sandbox";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetResponse {
    pub status: u16,
    pub mime: &'static str,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}

impl AssetResponse {
    fn status(status: u16) -> AssetResponse {
        AssetResponse {
            status,
            mime: "text/plain",
            body: Vec::new(),
            headers: Vec::new(),
        }
    }

    pub fn into_response(self) -> tauri::http::Response<Vec<u8>> {
        let mut builder = tauri::http::Response::builder()
            .status(self.status)
            .header("Content-Type", self.mime)
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            // Opened as a document (an SVG navigated to), a vault file runs no
            // script and gets no IPC. Embedding is unaffected: a response's CSP
            // applies only when it is rendered as a document.
            .header("Content-Security-Policy", CSP);
        for (k, v) in &self.headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        builder.body(self.body).expect("valid response")
    }
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` → inclusive range, or `Err(())` when unsatisfiable.
fn parse_range(header: &str, len: usize) -> Option<Result<(usize, usize), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return Some(Err(()));
    }
    let range = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: usize = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<usize>().ok()?.min(len - 1)),
    };
    Some(if range.0 >= len || range.0 > range.1 {
        Err(())
    } else {
        Ok(range)
    })
}

/// Files outside the vault (M4b part 3 §9) are asked for as
/// `/.external/<absolute path, one %-encoded segment>`. A vault path with a
/// hidden component is never served, so the prefix can't shadow a vault file.
pub const EXTERNAL_PREFIX: &str = ".external/";

/// An outside file, through the session's allow-list and checks
/// (`VaultSession::external_file`): 403 when it may not be shown, 404 when
/// it isn't there.
fn serve_external(
    session: &nimw_session::VaultSession,
    encoded: &str,
    range: Option<&str>,
) -> AssetResponse {
    use nimw_session::SessionError;
    if encoded.contains('/') {
        return AssetResponse::status(403);
    }
    let Ok(path) = percent_decode_str(encoded).decode_utf8() else {
        return AssetResponse::status(403);
    };
    let real = match session.external_file(&path) {
        Ok(real) => real,
        Err(SessionError::NotPermitted(_) | SessionError::NotAFile(_)) => {
            return AssetResponse::status(403);
        }
        Err(_) => return AssetResponse::status(404),
    };
    let Ok(bytes) = std::fs::read(&real) else {
        return AssetResponse::status(404);
    };
    respond(bytes, mime_for(&path), range)
}

/// Serves `uri_path` (the request path, percent-encoded, starting with `/`).
pub fn serve(state: &AppState, uri_path: &str, range: Option<&str>) -> AssetResponse {
    let Ok(session) = state.session() else {
        return AssetResponse::status(404);
    };
    if let Some(encoded) = uri_path
        .trim_start_matches('/')
        .strip_prefix(EXTERNAL_PREFIX)
    {
        return serve_external(&session, encoded, range);
    }
    if let Some(name) = uri_path.trim_start_matches('/').strip_prefix(".trash/") {
        return serve_trashed_image(session.vault(), name, range);
    }
    serve_from(session.vault(), uri_path, range)
}

/// A trashed image, for its thumbnail in the Trash view (M5b round 2): only
/// images directly in a real `.trash` folder, never through a link.
fn serve_trashed_image(vault: &Vault, encoded: &str, range: Option<&str>) -> AssetResponse {
    let Ok(name) = percent_decode_str(encoded).decode_utf8() else {
        return AssetResponse::status(403);
    };
    let mime = mime_for(&name);
    if name.contains(['/', '\\'])
        || nimw_vault::is_hidden_name(&name)
        || !mime.starts_with("image/")
    {
        return AssetResponse::status(403);
    }
    let dir = vault.root().join(".trash");
    let file = dir.join(name.as_ref());
    let real_dir = std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir());
    let real_file = std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file());
    if !real_dir || !real_file {
        return AssetResponse::status(404);
    }
    match std::fs::read(&file) {
        Ok(bytes) => respond(bytes, mime, range),
        Err(_) => AssetResponse::status(404),
    }
}

/// Serves a request from the webview labelled `label`: a single-file window
/// (M4c §4) gets its own file's folder only — never the open vault, never
/// outside files — and any other window the open vault.
pub fn serve_window(
    state: &AppState,
    files: &FileWindows,
    label: &str,
    uri_path: &str,
    range: Option<&str>,
) -> AssetResponse {
    if !is_file_window(label) {
        return serve(state, uri_path, range);
    }
    match files.get(label) {
        // Media and documents only: never a key or a config file that sits
        // beside the note (M4c review I4). `.external/…` is a hidden path
        // there: refused like any other.
        Some(_) if mime_for(uri_path) == "application/octet-stream" => AssetResponse::status(403),
        Some(grant) => serve_from(grant.vault(), uri_path, range),
        None => AssetResponse::status(404),
    }
}

/// A file of `vault` (the open vault, or a single file's folder).
fn serve_from(vault: &Vault, uri_path: &str, range: Option<&str>) -> AssetResponse {
    let decoded = percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8_lossy();
    let Ok(path) = VaultPath::new(&decoded) else {
        return AssetResponse::status(403);
    };
    if path.is_root() || is_hidden_path(path.as_str()) {
        return AssetResponse::status(403);
    }
    // A symlink resolving outside the vault, or into a hidden file (or an 8.3
    // name doing so, M4c review I4) is, for the webview, a file that doesn't
    // exist (403 stays for requests that are malformed on their face).
    if vault.visible_fs_path(&path).is_err() {
        return AssetResponse::status(404);
    }
    let Ok((bytes, _)) = vault.read(&path) else {
        return AssetResponse::status(404);
    };
    respond(bytes, mime_for(path.as_str()), range)
}

/// A file's bytes as a full (200) or partial (206/416) response.
fn respond(bytes: Vec<u8>, mime: &'static str, range: Option<&str>) -> AssetResponse {
    let len = bytes.len();
    match range.and_then(|r| parse_range(r, len)) {
        Some(Ok((start, end))) => AssetResponse {
            status: 206,
            mime,
            body: bytes[start..=end].to_vec(),
            headers: vec![
                ("Accept-Ranges".into(), "bytes".into()),
                ("Content-Range".into(), format!("bytes {start}-{end}/{len}")),
            ],
        },
        Some(Err(())) => AssetResponse {
            headers: vec![("Content-Range".into(), format!("bytes */{len}"))],
            ..AssetResponse::status(416)
        },
        None => AssetResponse {
            status: 200,
            mime,
            body: bytes,
            headers: vec![("Accept-Ranges".into(), "bytes".into())],
        },
    }
}
