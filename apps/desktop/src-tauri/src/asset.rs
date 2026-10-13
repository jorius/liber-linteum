//! `nimw-asset:` — serves the open vault's files to the webview (M2a spec §2.5).
//!
//! Tauri's built-in asset protocol can only *add* allowed directories, so a
//! vault that was open earlier would stay readable after switching vaults.
//! This protocol instead resolves every request through the current session:
//! `VaultPath` validation (no `..`, no absolute paths, no symlink escapes),
//! hidden files refused, nothing served when no vault is open.

use crate::state::AppState;
use nimw_vault::{VaultPath, is_hidden_name};
use percent_encoding::percent_decode_str;

pub const SCHEME: &str = "nimw-asset";

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
            .header("X-Content-Type-Options", "nosniff");
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

/// Serves `uri_path` (the request path, percent-encoded, starting with `/`).
pub fn serve(state: &AppState, uri_path: &str, range: Option<&str>) -> AssetResponse {
    let Ok(session) = state.session() else {
        return AssetResponse::status(404);
    };
    let decoded = percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8_lossy();
    let Ok(path) = VaultPath::new(&decoded) else {
        return AssetResponse::status(403);
    };
    if path.is_root() || path.as_str().split('/').any(is_hidden_name) {
        return AssetResponse::status(403);
    }
    let bytes = match session.vault().read(&path) {
        Ok((bytes, _)) => bytes,
        Err(nimw_vault::VaultError::OutsideVault(_)) => return AssetResponse::status(403),
        Err(_) => return AssetResponse::status(404),
    };
    let mime = mime_for(path.as_str());
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
