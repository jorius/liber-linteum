//! Test-only helpers. Never a dependency of production code.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tempfile::TempDir;

/// Absolute path of a committed fixture vault under `fixtures/vaults/`.
pub fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/vaults")
        .join(name)
}

/// Copies a fixture vault (hidden entries included) into a fresh temp dir.
/// Mutating tests must use this; committed fixtures are never written.
pub fn copy_fixture(name: &str) -> TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    copy_dir(&fixture_path(name), dir.path());
    dir
}

/// Like [`copy_fixture`], but inside the user's home folder so the OS trash
/// works (on Linux the system temp dir is often a different filesystem than
/// `~/.local/share/Trash`). Use only in tests that call `trash`.
pub fn trashable_fixture(name: &str) -> TempDir {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = tempfile::Builder::new()
        .prefix("nimw-trash-test-")
        .tempdir_in(home)
        .expect("tempdir in home");
    copy_dir(&fixture_path(name), dir.path());
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    for item in std::fs::read_dir(from).expect("read fixture dir") {
        let item = item.expect("dir entry");
        let target = to.join(item.file_name());
        if item.file_type().expect("file type").is_dir() {
            std::fs::create_dir(&target).expect("create dir");
            copy_dir(&item.path(), &target);
        } else {
            std::fs::copy(item.path(), &target).expect("copy file");
        }
    }
}

/// Every file and folder under `root` (hidden included) → (bytes, mtime).
/// Folders map to empty bytes. Used to prove an operation changed nothing.
pub fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for item in std::fs::read_dir(&dir).expect("read dir") {
            let item = item.expect("dir entry");
            let meta = item.metadata().expect("metadata");
            let rel = item.path().strip_prefix(root).unwrap().to_path_buf();
            let bytes = if meta.is_dir() {
                stack.push(item.path());
                Vec::new()
            } else {
                std::fs::read(item.path()).expect("read file")
            };
            out.insert(rel, (bytes, meta.modified().expect("mtime")));
        }
    }
    out
}

/// Polls `check` every 25 ms until it returns true or `timeout` elapses.
pub fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    check()
}
