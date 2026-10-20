//! The `liber-asset:` protocol (M2a spec §2.5): serves files of the open vault
//! only, through `VaultPath` (no traversal, no hidden files), with ranges.

use liber_desktop::AppDirs;
use liber_desktop::asset::serve;
use liber_desktop::state::AppState;
use liber_testkit::copy_fixture;
use serde_json::json;
use tauri::Manager;
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::{WebviewWindowBuilder, ipc::CallbackFn, ipc::InvokeBody, webview::InvokeRequest};

/// One `generate_context!()` per test binary (it embeds an Info.plist symbol).
fn app() -> (
    tauri::App<tauri::test::MockRuntime>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let config = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let app = liber_desktop::configure(
        mock_builder(),
        Some(AppDirs {
            config: config.path().into(),
            cache: cache.path().into(),
        }),
    )
    .build(tauri::generate_context!())
    .unwrap();
    (app, config, cache)
}

fn open(
    vault: &std::path::Path,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let (app, config, cache) = app();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let request = InvokeRequest {
        cmd: "vault_open".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(json!({ "path": vault })),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(&main, request).unwrap();
    (app, config, cache)
}

#[test]
fn serves_vault_files_with_their_media_type() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    let r = serve(&state, "/Character%20Design/assets/rex-cover.png", None);
    assert_eq!(r.status, 200);
    assert_eq!(r.mime, "image/png");
    assert_eq!(
        r.body,
        std::fs::read(vault.path().join("Character Design/assets/rex-cover.png")).unwrap()
    );
    let mp3 = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        None,
    );
    assert_eq!(mp3.mime, "audio/mpeg");
}

#[test]
fn refuses_traversal_hidden_files_and_missing_files() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    assert_eq!(serve(&state, "/../secret.png", None).status, 403);
    assert_eq!(serve(&state, "/%2E%2E/secret.png", None).status, 403);
    assert_eq!(serve(&state, "/.obsidian/app.json", None).status, 403);
    assert_eq!(serve(&state, "/nope.png", None).status, 404);
    assert_eq!(serve(&state, "/", None).status, 403);
}

#[test]
fn nothing_is_served_without_an_open_vault() {
    let (app, _c, _k) = app();
    assert_eq!(
        serve(&app.state::<AppState>(), "/Welcome.md", None).status,
        404
    );
}

#[test]
fn byte_ranges_for_audio_seeking() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    let full = std::fs::read(
        vault
            .path()
            .join("Character Design/assets/voice-reference.mp3"),
    )
    .unwrap();
    let r = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        Some("bytes=2-5"),
    );
    assert_eq!(r.status, 206);
    assert_eq!(r.body, full[2..=5]);
    assert!(
        r.headers
            .iter()
            .any(|(k, v)| k == "Content-Range" && v == &format!("bytes 2-5/{}", full.len()))
    );
    let open_end = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        Some("bytes=3-"),
    );
    assert_eq!(open_end.body, full[3..]);
    let bad = serve(
        &state,
        "/Character%20Design/assets/voice-reference.mp3",
        Some("bytes=999999-"),
    );
    assert_eq!(bad.status, 416);
}

/// Spec §7 "revoked on close": once the vault is closed nothing of it is served.
#[test]
fn closing_the_vault_stops_serving_it() {
    let vault = copy_fixture("obsidian-basic");
    let (app, _c, _k) = open(vault.path());
    let path = "/Character%20Design/assets/rex-cover.png";
    assert_eq!(serve(&app.state::<AppState>(), path, None).status, 200);
    let main = app.get_webview_window("main").unwrap();
    let request = InvokeRequest {
        cmd: "vault_close".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(json!({})),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(&main, request).unwrap();
    assert_eq!(serve(&app.state::<AppState>(), path, None).status, 404);
}

/// m2: a response opened as a document (e.g. an SVG navigated to) runs no
/// script and gets no IPC; embedding as <img>/<audio>/<video> is unaffected,
/// because a response's CSP applies only when it is rendered as a document.
#[test]
fn every_response_is_sandboxed_and_never_sniffed() {
    let vault = copy_fixture("obsidian-basic");
    std::fs::write(
        vault.path().join("evil.svg"),
        r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
    )
    .unwrap();
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    let audio = "/Character%20Design/assets/voice-reference.mp3";
    for r in [
        serve(&state, "/evil.svg", None),
        serve(&state, audio, Some("bytes=0-3")),
        serve(&state, "/nope.png", None),
        serve(&state, "/../x", None),
    ] {
        let status = r.status;
        let res = r.into_response();
        let h = res.headers();
        assert_eq!(
            h.get("Content-Security-Policy")
                .map(|v| v.to_str().unwrap()),
            Some("default-src 'none'; sandbox"),
            "status {status}"
        );
        assert_eq!(
            h.get("X-Content-Type-Options").map(|v| v.to_str().unwrap()),
            Some("nosniff")
        );
    }
    assert_eq!(serve(&state, "/evil.svg", None).mime, "image/svg+xml");
}

/// m9: a symlink inside the vault that points outside it is never served.
#[cfg(unix)]
#[test]
fn symlinks_escaping_the_vault_are_not_served() {
    let vault = copy_fixture("obsidian-basic");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.png"), b"secret").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.png"),
        vault.path().join("leak.png"),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside.path(), vault.path().join("outside")).unwrap();
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    for path in ["/leak.png", "/outside/secret.png"] {
        let r = serve(&state, path, None);
        assert_eq!(r.status, 404, "{path}");
        assert!(r.body.is_empty(), "{path}");
    }
}

// ---- M4b part 3 §9: files outside the vault ----

/// `base/Vault` (one page linking outside files) and `base/Pics`; the
/// names aren't hidden (`tempdir()` names start with `.tmp`).
fn outside_world(
    page: impl Fn(&std::path::Path) -> String,
) -> (tempfile::TempDir, std::path::PathBuf) {
    let base = tempfile::Builder::new()
        .prefix("liber-ext")
        .tempdir()
        .unwrap();
    let pics = dunce::canonicalize(base.path()).unwrap().join("Pics");
    std::fs::create_dir_all(pics.join(".secret")).unwrap();
    std::fs::write(pics.join("x.png"), b"\x89PNG-outside").unwrap();
    std::fs::write(pics.join(".secret/key.png"), b"key").unwrap();
    std::fs::create_dir_all(base.path().join("Vault")).unwrap();
    std::fs::write(base.path().join("Vault/a.md"), page(&pics)).unwrap();
    (base, pics)
}

/// `/.external/<path as one %-encoded segment>`, as the UI asks for it.
fn external_uri(path: &str) -> String {
    let encoded: String = path
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("/.external/{encoded}")
}

#[test]
fn m4b3_outside_files_are_served_once_a_page_links_them() {
    let (base, pics) =
        outside_world(|pics| format!("# A\n\n![[{}]]\n", pics.join("x.png").display()));
    let (app, _c, _k) = open(&base.path().join("Vault"));
    let state = app.state::<AppState>();
    let pic = pics.join("x.png").display().to_string();
    let r = serve(&state, &external_uri(&pic), None);
    assert_eq!(r.status, 200);
    assert_eq!(r.mime, "image/png");
    assert_eq!(r.body, b"\x89PNG-outside");
    let res = r.into_response();
    assert_eq!(
        res.headers()
            .get("Content-Security-Policy")
            .map(|v| v.to_str().unwrap()),
        Some("default-src 'none'; sandbox")
    );
    let part = serve(&state, &external_uri(&pic), Some("bytes=1-3"));
    assert_eq!((part.status, part.body.as_slice()), (206, &b"PNG"[..]));
}

#[test]
fn m4b3_unlisted_hidden_and_malformed_outside_requests_are_refused() {
    let (base, pics) = outside_world(|pics| {
        format!(
            "# A\n\n![[{}]] ![[{}]]\n",
            pics.join("x.png").display(),
            pics.join(".secret/key.png").display()
        )
    });
    std::fs::write(pics.join("other.png"), b"other").unwrap();
    let (app, _c, _k) = open(&base.path().join("Vault"));
    let state = app.state::<AppState>();
    let pic = pics.join("x.png").display().to_string();
    let other = pics.join("other.png").display().to_string();
    let key = pics.join(".secret/key.png").display().to_string();
    let roundabout = format!("{}/../x.png", pics.join(".secret").display());
    for (uri, why) in [
        (external_uri(&other), "not linked"),
        (external_uri(&key), "hidden, though linked"),
        (external_uri(&roundabout), "spelled with .."),
        // The path must be one segment: a raw `/` after the prefix is malformed.
        (format!("/.external{pic}"), "raw separators"),
        (format!("{}%FF", external_uri(&pic)), "not UTF-8"),
    ] {
        let r = serve(&state, &uri, None);
        assert_eq!(r.status, 403, "{why}: {uri}");
        assert!(r.body.is_empty(), "{why}");
    }
    // The prefix's look-alikes are hidden vault paths: refused.
    assert_eq!(serve(&state, "/.external", None).status, 403);
    assert_eq!(serve(&state, "/%2Eexternal/x.png", None).status, 403);
}

#[test]
fn m4b3_missing_outside_files_are_404() {
    let (base, pics) =
        outside_world(|pics| format!("# A\n\n![[{}]]\n", pics.join("gone.png").display()));
    let (app, _c, _k) = open(&base.path().join("Vault"));
    let gone = pics.join("gone.png").display().to_string();
    assert_eq!(
        serve(&app.state::<AppState>(), &external_uri(&gone), None).status,
        404
    );
}

/// M5b round 2: the Trash view shows trashed images as thumbnails: images
/// directly in `.trash` are served; nothing else in it, and never through a
/// link out of it.
#[test]
fn m5b_r2_trashed_images_are_served_for_their_thumbnails() {
    let vault = copy_fixture("obsidian-basic");
    let trash = vault.path().join(".trash");
    std::fs::create_dir_all(trash.join("Old")).unwrap();
    std::fs::write(trash.join("map.png"), b"png!").unwrap();
    std::fs::write(trash.join("notes.md"), "# secret").unwrap();
    std::fs::write(trash.join("Old/inner.png"), b"png!").unwrap();
    std::fs::write(trash.join(".hidden.png"), b"png!").unwrap();
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    let r = serve(&state, "/.trash/map.png", None);
    assert_eq!((r.status, r.mime), (200, "image/png"));
    assert_eq!(r.body, b"png!");
    for refused in [
        "/.trash/notes.md",
        "/.trash/Old/inner.png",
        "/.trash/.hidden.png",
        "/.trash/../x.png",
    ] {
        assert_ne!(serve(&state, refused, None).status, 200, "{refused}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            vault.path().join("Character Design/assets/rex-cover.png"),
            trash.join("link.png"),
        )
        .unwrap();
        assert_ne!(serve(&state, "/.trash/link.png", None).status, 200);
    }
}

/// Round-2 review I1: a name holding `:` is refused — on Windows
/// `D:photo.png` joined onto `.trash` would leave it for drive D.
#[test]
fn m5b_r2_review_i1_a_trashed_name_with_a_colon_is_refused() {
    let vault = copy_fixture("obsidian-basic");
    let trash = vault.path().join(".trash");
    std::fs::create_dir_all(&trash).unwrap();
    #[cfg(unix)]
    std::fs::write(trash.join("D:photo.png"), b"png!").unwrap();
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    for refused in [
        "/.trash/D%3Aphoto.png",
        "/.trash/D:photo.png",
        "/.trash/C%3A%5Cx.png",
    ] {
        assert_eq!(serve(&state, refused, None).status, 403, "{refused}");
    }
}

/// Batch 6 review I6: a long clip is served in pieces — a seek reads only
/// its range, and an open-ended range ("from here on") gets a bounded
/// piece, never the whole file per request.
#[test]
fn b6_review_i6_long_media_is_served_in_bounded_pieces() {
    let vault = copy_fixture("obsidian-basic");
    let path = vault.path().join("long.wav");
    let len: u64 = 64 * 1024 * 1024;
    {
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(len).unwrap(); // sparse: cheap to make
        use std::io::{Seek, SeekFrom, Write};
        let mut f = f;
        f.seek(SeekFrom::Start(40 * 1024 * 1024)).unwrap();
        f.write_all(b"MARK").unwrap();
    }
    let (app, _c, _k) = open(vault.path());
    let state = app.state::<AppState>();
    let seek = serve(&state, "/long.wav", Some("bytes=41943040-41943043"));
    assert_eq!(seek.status, 206);
    assert_eq!(seek.body, b"MARK");
    let rest = serve(&state, "/long.wav", Some("bytes=0-"));
    assert_eq!(rest.status, 206);
    assert!(rest.body.len() <= 8 * 1024 * 1024, "{}", rest.body.len());
    let end = rest.body.len() - 1;
    assert!(
        rest.headers
            .iter()
            .any(|(k, v)| k == "Content-Range" && v == &format!("bytes 0-{end}/{len}")),
        "{:?}",
        rest.headers
    );
}
