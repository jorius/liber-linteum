//! The main webview may only ever show the app itself (review m2). A vault file
//! served over `liber-asset:` (an SVG, an HTML file) or a remote page must never
//! become the top-level document: Tauri treats registered schemes as local, so
//! such a document would get the app's IPC. Links are opened through
//! `url_open` / `file_open_external`, never by navigating.
use tauri::Url;

/// Whether the main webview may navigate to `url`.
pub fn allowed(url: &Url) -> bool {
    let host = url.host_str();
    match url.scheme() {
        // macOS / Linux serve the bundled UI from tauri://localhost.
        "tauri" => host == Some("localhost"),
        // Windows (WebView2) serves it from http(s)://tauri.localhost; debug
        // builds load the Vite dev server (`devUrl` in tauri.conf.json).
        "http" | "https" => {
            host == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && url.scheme() == "http"
                    && host == Some("localhost")
                    && url.port() == Some(1420))
        }
        "about" => url.path() == "blank",
        _ => false,
    }
}

/// A plugin with no commands whose only job is the navigation guard.
pub fn guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("liber-navigation")
        .on_navigation(|_, url| allowed(url))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> bool {
        allowed(&Url::parse(s).unwrap())
    }

    #[test]
    fn the_app_itself_may_load() {
        assert!(ok("tauri://localhost/"));
        assert!(ok("tauri://localhost/index.html#/page"));
        assert!(ok("http://tauri.localhost/"));
        assert!(ok("https://tauri.localhost/"));
        assert!(ok("about:blank"));
    }

    #[test]
    fn the_dev_server_only_in_debug_builds() {
        assert_eq!(ok("http://localhost:1420/"), cfg!(debug_assertions));
        assert!(!ok("http://localhost:8080/"));
    }

    #[test]
    fn vault_files_and_the_web_never_become_the_page() {
        for url in [
            "liber-asset://localhost/Notes/evil.svg",
            "http://liber-asset.localhost/Notes/evil.html",
            "https://example.com/",
            "http://example.com/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "tauri://evil.com/",
            "http://tauri.localhost.evil.com/",
        ] {
            assert!(!ok(url), "{url}");
        }
    }
}
