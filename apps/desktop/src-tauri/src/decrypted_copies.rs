//! Decrypted copies (spec §5.5): opening an encrypted vault's attachment in
//! another app needs a plaintext file. This run's copies live in one folder,
//! `<temp>/liber-<pid>-<random>/`, private to the user (`0700` on unix), and
//! the folder is removed when the vault locks and when the app quits. One of
//! the three audited exceptions to "no plaintext outside the vault".
//!
//! A run holds an exclusive lock on `.lock` in its folder while the folder
//! exists. The OS drops a dead process's locks, so a folder whose `.lock`
//! can be locked was left by a run that is gone (crashed or killed): the next
//! run's startup sweep removes it.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const LOCK_FILE: &str = ".lock";
/// Hex digits of a folder's random part.
const RANDOM_LEN: usize = 32;

pub struct DecryptedCopies {
    folder: PathBuf,
    /// This run's `.lock`, held while the folder exists.
    lock: Mutex<Option<File>>,
    /// Each copy gets its own numbered sub-folder: two attachments with the
    /// same name never replace each other (or a file another app has open).
    next: AtomicU64,
}

impl DecryptedCopies {
    /// This run's folder under `temp` (created on the first copy), after
    /// removing the folders runs no longer alive left there.
    pub fn new(temp: &Path) -> DecryptedCopies {
        sweep(temp);
        let random: String = liber_crypto::FolderId::random()
            .0
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        DecryptedCopies {
            folder: temp.join(format!("liber-{}-{random}", std::process::id())),
            lock: Mutex::new(None),
            next: AtomicU64::new(1),
        }
    }

    /// Writes `bytes` as `<folder>/<n>/<name>` and returns its path.
    /// `name` is a vault path's last component, so a single plain name.
    pub fn write(&self, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
        let mut lock = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if lock.is_none() {
            let mut dir = std::fs::DirBuilder::new();
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
            match dir.create(&self.folder) {
                Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
                _ => {}
            }
            let file = File::create(self.folder.join(LOCK_FILE))?;
            file.try_lock().map_err(std::io::Error::other)?;
            *lock = Some(file);
        }
        let dir = self
            .folder
            .join(self.next.fetch_add(1, Ordering::Relaxed).to_string());
        std::fs::create_dir(&dir)?;
        let path = dir.join(name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&path)?.write_all(bytes)?;
        Ok(path)
    }

    /// Removes the folder and every copy in it.
    // shortcut: a copy another app holds open on Windows can't be removed; the next run's sweep removes it. Upgrade: retry on unlock.
    pub fn wipe(&self) {
        let mut lock = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        // Released first: Windows won't remove an open file.
        if lock.take().is_some() {
            let _ = std::fs::remove_dir_all(&self.folder);
        }
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }
}

/// The pid in a run folder's name, exactly `liber-<pid>-<32 lowercase hex>`.
fn run_pid(name: &str) -> Option<u32> {
    let (pid, random) = name.strip_prefix("liber-")?.split_once('-')?;
    let hex = random.len() == RANDOM_LEN
        && random
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let digits = !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit());
    if hex && digits {
        pid.parse().ok()
    } else {
        None
    }
}

/// Removes the run folders in `temp` whose run is gone: a real folder (not
/// a link) named exactly as [`run_pid`] wants, not this process's, holding a
/// `.lock` that nothing holds. Anything else is left alone.
fn sweep(temp: &Path) {
    let Ok(items) = std::fs::read_dir(temp) else {
        return;
    };
    for item in items.flatten() {
        let name = item.file_name();
        let Some(pid) = name.to_str().and_then(run_pid) else {
            continue;
        };
        if pid == std::process::id() || !item.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(lock) = File::open(item.path().join(LOCK_FILE)) else {
            continue;
        };
        if lock.try_lock().is_err() {
            continue;
        }
        drop(lock);
        let _ = std::fs::remove_dir_all(item.path());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "0123456789abcdef0123456789abcdef";

    fn run_folder(temp: &Path, name: &str) -> PathBuf {
        let dir = temp.join(name);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join(LOCK_FILE), "").unwrap();
        std::fs::write(dir.join("copy.pdf"), "plaintext").unwrap();
        dir
    }

    #[test]
    fn names_are_matched_exactly() {
        assert_eq!(run_pid(&format!("liber-42-{HEX}")), Some(42));
        for name in [
            format!("liber--{HEX}"),
            format!("liber-4x2-{HEX}"),
            format!("liber-42-{}", HEX.to_uppercase()),
            format!("liber-42-{HEX}0"),
            format!("liber-42-{HEX}-x"),
            format!("Liber-42-{HEX}"),
            "liber-menu-a-cfg-42".to_string(),
            "liber-42".to_string(),
        ] {
            assert_eq!(run_pid(&name), None, "{name}");
        }
    }

    #[test]
    fn sweep_removes_only_folders_of_runs_that_are_gone() {
        let temp = tempfile::tempdir().unwrap();
        let t = temp.path();
        let dead = run_folder(t, &format!("liber-4000001-{HEX}"));
        // A live run: its lock is held.
        let live = run_folder(t, &format!("liber-4000002-{HEX}"));
        let held = File::open(live.join(LOCK_FILE)).unwrap();
        held.try_lock().unwrap();
        let mine = run_folder(t, &format!("liber-{}-{HEX}", std::process::id()));
        let unlocked = t.join(format!("liber-4000003-{HEX}"));
        std::fs::create_dir(&unlocked).unwrap();
        let odd = run_folder(t, "liber-4000004-short");
        let plain_file = t.join(format!("liber-4000005-{HEX}"));
        std::fs::write(&plain_file, "a file, not a folder").unwrap();
        #[cfg(unix)]
        let link = {
            let link = t.join(format!("liber-4000006-{HEX}"));
            std::os::unix::fs::symlink(&odd, &link).unwrap();
            link
        };

        sweep(t);
        assert!(!dead.exists(), "a gone run's folder is removed");
        for kept in [&live, &mine, &unlocked, &odd, &plain_file] {
            assert!(kept.exists(), "{kept:?} kept");
        }
        #[cfg(unix)]
        assert!(link.symlink_metadata().is_ok() && odd.join("copy.pdf").exists());
        drop(held);
    }

    #[test]
    fn copies_live_in_a_private_folder_until_wiped() {
        let temp = tempfile::tempdir().unwrap();
        let copies = DecryptedCopies::new(temp.path());
        let a = copies.write("same.pdf", b"one").unwrap();
        let b = copies.write("same.pdf", b"two").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert!(a.starts_with(copies.folder()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(copies.folder()), 0o700);
            assert_eq!(mode(&a), 0o600);
        }
        // A sweep never touches this run's own folder.
        sweep(temp.path());
        assert!(a.exists());
        copies.wipe();
        assert!(!copies.folder().exists());
        // The next copy makes the folder again.
        let c = copies.write("again.pdf", b"three").unwrap();
        assert!(c.exists());
        copies.wipe();
    }
}
