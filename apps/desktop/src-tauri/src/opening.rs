//! Files the OS asks the app to open (M4c §3): Finder's "Open With" and the
//! Dock (`RunEvent::Opened`, macOS), and paths on the command line
//! (Windows, Linux), including a second launch forwarded to the running app
//! (`tauri-plugin-single-instance`). Each opens in a single-file window.

use crate::file_commands::open_paths;
use crate::file_windows::file_kind;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

/// The files named on a command line (`args` without the program): flags
/// (`-x`, `--x`, macOS's `-psn_…`) are skipped, relative paths are joined
/// to `cwd`, and only names the app opens on their own are kept (whether
/// they exist is checked when they open).
pub fn paths_from_args(args: &[OsString], cwd: &Path) -> Vec<PathBuf> {
    // OS strings: a file name that isn't UTF-8 (Linux) must not crash the
    // launch (M4c review m1); the name check below skips it.
    args.iter()
        .filter(|a| !a.as_encoded_bytes().starts_with(b"-"))
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(file_kind)
                .is_some()
        })
        .collect()
}

/// The files among the URLs macOS hands over (`file:` only).
pub fn paths_from_urls(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok())
        .collect()
}

/// Opens each file in its window, off the event loop (building a window
/// from an event handler can deadlock on Windows).
pub fn open_later<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        open_paths(&app, &paths);
    });
}

// Unix paths and `file:` URLs: on Windows `/abs` isn't absolute.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn command_lines_name_notes_and_text_files() {
        let cwd = Path::new("/home/me/notes");
        let args: Vec<std::ffi::OsString> = [
            "-psn_0_12345",
            "--flag",
            "today.md",
            "/abs/list.txt",
            "photo.png",
            "sub/code.rs",
        ]
        .iter()
        .map(|s| s.into())
        .collect();
        assert_eq!(
            paths_from_args(&args, cwd),
            [
                PathBuf::from("/home/me/notes/today.md"),
                PathBuf::from("/abs/list.txt"),
                PathBuf::from("/home/me/notes/sub/code.rs"),
            ]
        );
    }

    #[test]
    fn m4c_review_m1_a_name_that_is_not_utf8_is_skipped_not_a_crash() {
        use std::os::unix::ffi::OsStrExt;
        let args = [
            std::ffi::OsStr::from_bytes(b"caf\xe9.md").to_os_string(),
            "ok.md".into(),
        ];
        assert_eq!(
            paths_from_args(&args, Path::new("/n")),
            [PathBuf::from("/n/ok.md")]
        );
    }

    #[test]
    fn only_file_urls_are_files() {
        let urls: Vec<tauri::Url> = [
            "file:///Users/me/My%20Note.md",
            "https://example.com/a.md",
            "nimw://x",
        ]
        .iter()
        .map(|u| u.parse().unwrap())
        .collect();
        assert_eq!(
            paths_from_urls(&urls),
            [PathBuf::from("/Users/me/My Note.md")]
        );
    }
}
