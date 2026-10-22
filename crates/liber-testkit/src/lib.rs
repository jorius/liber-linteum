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

/// Tests that move files to the real OS trash run only when `LIBER_TRASH_TESTS=1`
/// (CI sets it). Locally they are skipped so test runs don't fill your Trash.
/// Returns `false` (and prints why) when the test should skip itself.
pub fn real_trash_tests_enabled() -> bool {
    let enabled = std::env::var("LIBER_TRASH_TESTS").as_deref() == Ok("1");
    if !enabled {
        eprintln!("skipped: set LIBER_TRASH_TESTS=1 to run tests that use the real OS trash");
    }
    enabled
}

/// Whether this run seals every vault `Vault::open` sees (`LIBER_TEST_STORAGE=encrypted`,
/// E3): a test that asserts on plaintext bytes on disk, or on behaviour encrypted
/// vaults change by design, returns early when this is `true` (and prints why).
pub fn plain_disk_only() -> bool {
    let sealed = std::env::var("LIBER_TEST_STORAGE").as_deref() == Ok("encrypted");
    if sealed {
        eprintln!("skipped: needs a plaintext vault on disk (LIBER_TEST_STORAGE=encrypted)");
    }
    sealed
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
        .prefix("liber-trash-test-")
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
            // Not `item.metadata()`: on Windows that is the parent folder's
            // copy, which NTFS updates lazily (a folder's mtime lags).
            let meta = std::fs::symlink_metadata(item.path()).expect("metadata");
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

/// Shape of a generated benchmark vault (spec §7.3).
#[derive(Debug, Clone, Copy)]
pub struct VaultShape {
    pub notes: usize,
    pub folders: usize,
    pub max_depth: usize,
    pub links_per_note: usize,
    pub tags_per_note: usize,
    pub attachments: usize,
    /// Notes that link to `hub.md` (for the rename benchmark).
    pub hub_backlinks: usize,
}

impl VaultShape {
    /// The NFR-01 target: 10,000 notes.
    pub const TEN_K: VaultShape = VaultShape {
        notes: 10_000,
        folders: 400,
        max_depth: 6,
        links_per_note: 8,
        tags_per_note: 3,
        attachments: 1_000,
        hub_backlinks: 100,
    };
}

/// Tiny deterministic PRNG (xorshift64*), so generated vaults are identical
/// on every machine without extra dependencies.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Writes a deterministic vault into `root`: nested folders, notes with
/// frontmatter (half of them), wikilinks/embeds/Markdown links, tags,
/// attachments, and a `hub.md` with `hub_backlinks` backlinks. Returns the
/// vault-relative paths of the generated notes (index = note number).
pub fn generate_vault(root: &Path, shape: VaultShape, seed: u64) -> Vec<String> {
    let mut rng = Rng(seed.max(1));
    let mut folders = vec![String::new()];
    for i in 0..shape.folders {
        let parent = folders[rng.below(folders.len())].clone();
        let depth = if parent.is_empty() {
            0
        } else {
            parent.matches('/').count() + 1
        };
        let parent = if depth >= shape.max_depth {
            String::new()
        } else {
            parent
        };
        let name = if parent.is_empty() {
            format!("Folder {i}")
        } else {
            format!("{parent}/Folder {i}")
        };
        std::fs::create_dir_all(root.join(&name)).expect("create folder");
        folders.push(name);
    }
    let in_folder = |folder: &str, file: &str| {
        if folder.is_empty() {
            file.to_string()
        } else {
            format!("{folder}/{file}")
        }
    };
    let notes: Vec<String> = (0..shape.notes)
        .map(|i| in_folder(&folders[i % folders.len()], &format!("Note {i}.md")))
        .collect();
    let attachments: Vec<String> = (0..shape.attachments)
        .map(|i| in_folder(&folders[(i * 7) % folders.len()], &format!("image-{i}.png")))
        .collect();
    for a in &attachments {
        std::fs::write(root.join(a), b"PNG placeholder").expect("write attachment");
    }
    std::fs::write(
        root.join("hub.md"),
        "# Hub\n\nThe page everyone links to.\n",
    )
    .expect("write hub");
    for (i, path) in notes.iter().enumerate() {
        let mut text = String::new();
        if i % 2 == 0 {
            text.push_str(&format!(
                "---\nsubtitle: Generated note {i}\ntags: [gen, batch{}]\n---\n",
                i % 50
            ));
        }
        text.push_str(&format!(
            "# Note {i}\n\nGenerated paragraph with some words for the excerpt.\n\n"
        ));
        if i < shape.hub_backlinks {
            text.push_str("Back to [[hub]].\n");
        }
        for _ in 0..shape.links_per_note {
            let link = match rng.below(4) {
                0 | 1 => format!("[[Note {}]]", rng.below(shape.notes)),
                2 => format!("![[image-{}.png]]", rng.below(shape.attachments.max(1))),
                _ => format!("[x](</{}>)", notes[rng.below(shape.notes)]),
            };
            text.push_str(&format!("- {link}\n"));
        }
        for t in 0..shape.tags_per_note {
            text.push_str(&format!("#topic{} ", (i + t * 13) % 200));
        }
        text.push('\n');
        std::fs::write(root.join(path), text).expect("write note");
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_is_deterministic_and_shaped() {
        let shape = VaultShape {
            notes: 50,
            folders: 10,
            max_depth: 3,
            links_per_note: 4,
            tags_per_note: 2,
            attachments: 5,
            hub_backlinks: 3,
        };
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let notes = generate_vault(a.path(), shape, 7);
        assert_eq!(notes.len(), 50);
        assert!(a.path().join(&notes[49]).is_file());
        generate_vault(b.path(), shape, 7);
        let strip = |s: BTreeMap<PathBuf, (Vec<u8>, SystemTime)>| {
            s.into_iter().map(|(k, (v, _))| (k, v)).collect::<Vec<_>>()
        };
        assert_eq!(strip(snapshot(a.path())), strip(snapshot(b.path())));
        let files = strip(snapshot(a.path()))
            .into_iter()
            .filter(|(k, _)| k.extension().is_some_and(|e| e == "md"))
            .count();
        assert_eq!(files, 51, "50 notes + hub");
    }
}
