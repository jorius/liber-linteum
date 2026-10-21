//! Decrypted copies (spec §5.5): opening an encrypted vault's attachment in
//! another app needs a plaintext file. This run's copies live in one folder,
//! `<temp>/liber-<pid>-<random>/`, private to the user (`0700` on unix), and
//! the folder is removed when the vault locks and when the app quits. One of
//! the three audited exceptions to "no plaintext outside the vault".
//!
//! A run holds an exclusive lock on `.lock` in its folder while the folder
//! exists. The OS drops a dead process's locks, so a folder whose `.lock`
//! can be locked was left by a run that is gone (crashed or killed): the next
//! run's startup sweep removes it. `.lock` is removed last, only once every
//! copy is gone, so a copy that couldn't be removed (open in a viewer on
//! Windows) is still found by the next wipe or sweep (review C1).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

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
        sweep(temp, SystemTime::now());
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
        // Exactly one plain name: never `..`, a separator or `C:x` (review M3).
        let mut parts = Path::new(name).components();
        if !matches!((parts.next(), parts.next()), (Some(Component::Normal(n)), None) if n == name)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{name:?} isn't a plain file name"),
            ));
        }
        let mut lock = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if lock.is_none() {
            #[cfg(unix)]
            let made =
                std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700)
                    .create(&self.folder);
            #[cfg(not(unix))]
            let made = std::fs::create_dir(&self.folder);
            match made {
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

    /// Removes every copy, then the folder. If a copy can't be removed
    /// (open in another app on Windows), the lock stays held and `.lock`
    /// stays on disk: the next wipe (at the latest on quit) or the next run's
    /// sweep tries again.
    pub fn wipe(&self) {
        let mut lock = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if self.folder.symlink_metadata().is_err() {
            *lock = None;
            return;
        }
        if remove_copies(&self.folder).is_ok() {
            // Released first: Windows won't remove an open file.
            *lock = None;
            remove_lock_and_folder(&self.folder);
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

/// Removes everything in a run folder except its `.lock`; `Err` if anything
/// is left.
fn remove_copies(folder: &Path) -> std::io::Result<()> {
    let mut result = Ok(());
    for item in std::fs::read_dir(folder)? {
        let item = item?;
        if item.file_name() == LOCK_FILE {
            continue;
        }
        let removed = if item.file_type()?.is_dir() {
            std::fs::remove_dir_all(item.path())
        } else {
            std::fs::remove_file(item.path())
        };
        if removed.is_err() {
            result = removed;
        }
    }
    result
}

/// The last step, once [`remove_copies`] left only `.lock`.
fn remove_lock_and_folder(folder: &Path) {
    let _ = std::fs::remove_file(folder.join(LOCK_FILE));
    let _ = std::fs::remove_dir(folder);
}

/// The effective uid of this process, read from a probe file it creates in
/// `temp` (std has no `geteuid`, and src-tauri takes no libc edge). `None`
/// if the probe can't be made: then nothing is swept.
#[cfg(unix)]
fn my_uid(temp: &Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    let random: String = liber_crypto::FolderId::random()
        .0
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let probe = temp.join(format!(".liber-uid-{}-{random}", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .ok()?;
    let uid = file.metadata().ok().map(|m| m.uid());
    drop(file);
    let _ = std::fs::remove_file(&probe);
    uid
}

/// Whether `m` (from `lstat`) is owned by `uid`. In a sticky shared temp
/// folder (`/tmp`) no other user can rename or replace an entry we own.
#[cfg(unix)]
fn owned(m: &std::fs::Metadata, uid: Option<u32>) -> bool {
    use std::os::unix::fs::MetadataExt;
    uid == Some(m.uid())
}

/// `%TEMP%` is per user on Windows.
#[cfg(not(unix))]
fn owned(_: &std::fs::Metadata, _: Option<u32>) -> bool {
    true
}

/// `path` by `lstat` (never through a link, never a cached listing type):
/// a real directory `uid` owns.
fn own_dir(path: &Path, uid: Option<u32>) -> Option<std::fs::Metadata> {
    path.symlink_metadata()
        .ok()
        .filter(|m| m.file_type().is_dir() && owned(m, uid))
}

/// Removes the run folders in `temp` whose run is gone: a real folder (by
/// `lstat`, not a link) that this user owns, named exactly as [`run_pid`]
/// wants, not this process's, holding a `.lock` that nothing holds, or no
/// `.lock` at all and older than `start` (a run that died before making
/// it). Ownership is checked again right before anything is removed
/// (review round 2: a link swapped in by another user is never followed).
/// Anything else is left alone.
fn sweep(temp: &Path, start: SystemTime) {
    let Ok(items) = std::fs::read_dir(temp) else {
        return;
    };
    #[cfg(unix)]
    let uid = my_uid(temp);
    #[cfg(not(unix))]
    let uid = None;
    for item in items.flatten() {
        let name = item.file_name();
        let Some(pid) = name.to_str().and_then(run_pid) else {
            continue;
        };
        let folder = item.path();
        if pid == std::process::id() {
            continue;
        }
        let Some(meta) = own_dir(&folder, uid) else {
            continue;
        };
        let lock = match File::open(folder.join(LOCK_FILE)) {
            Ok(lock) if lock.try_lock().is_ok() => Some(lock),
            Ok(_) => continue,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if !meta.modified().is_ok_and(|t| t < start) {
                    continue;
                }
                None
            }
            Err(_) => continue,
        };
        if own_dir(&folder, uid).is_none() || remove_copies(&folder).is_err() {
            continue;
        }
        drop(lock);
        remove_lock_and_folder(&folder);
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
        // No `.lock`: newer than this run (another run starting) is kept.
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

        sweep(t, SystemTime::UNIX_EPOCH);
        assert!(!dead.exists(), "a gone run's folder is removed");
        for kept in [&live, &mine, &unlocked, &odd, &plain_file] {
            assert!(kept.exists(), "{kept:?} kept");
        }
        #[cfg(unix)]
        assert!(link.symlink_metadata().is_ok() && odd.join("copy.pdf").exists());

        // Older than this run with no `.lock` (it died before making one): removed.
        let later = SystemTime::now() + std::time::Duration::from_secs(3600);
        sweep(t, later);
        assert!(!unlocked.exists());
        for kept in [&live, &mine, &odd, &plain_file] {
            assert!(kept.exists(), "{kept:?} kept");
        }
        drop(held);
    }

    /// Review round 2: a link named like a gone run's folder is never
    /// followed, with or without a `.lock` behind it: the target's
    /// contents stay.
    #[cfg(unix)]
    #[test]
    fn a_link_named_like_a_run_folder_is_never_followed() {
        let temp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let with_lock = run_folder(elsewhere.path(), "documents");
        std::fs::create_dir(with_lock.join("1")).unwrap();
        std::fs::write(with_lock.join("1/notes.txt"), "mine").unwrap();
        let without = elsewhere.path().join("photos");
        std::fs::create_dir(&without).unwrap();
        std::fs::write(without.join("a.jpg"), "mine").unwrap();
        std::os::unix::fs::symlink(&with_lock, temp.path().join(format!("liber-4000008-{HEX}")))
            .unwrap();
        std::os::unix::fs::symlink(&without, temp.path().join(format!("liber-4000009-{HEX}")))
            .unwrap();
        sweep(
            temp.path(),
            SystemTime::now() + std::time::Duration::from_secs(3600),
        );
        assert!(with_lock.join("copy.pdf").exists());
        assert!(with_lock.join("1/notes.txt").exists());
        assert!(with_lock.join(LOCK_FILE).exists());
        assert!(without.join("a.jpg").exists());
    }

    #[cfg(unix)]
    #[test]
    fn only_this_users_folders_count_as_its_own() {
        let temp = tempfile::tempdir().unwrap();
        let uid = my_uid(temp.path()).expect("a probe in a temp dir");
        assert_eq!(
            std::fs::read_dir(temp.path()).unwrap().count(),
            0,
            "probe removed"
        );
        let dir = temp.path().join("d");
        std::fs::create_dir(&dir).unwrap();
        let meta = dir.symlink_metadata().unwrap();
        assert!(owned(&meta, Some(uid)));
        assert!(!owned(&meta, Some(uid.wrapping_add(1))));
        assert!(!owned(&meta, None), "unknown uid: nothing is ours");
        assert!(own_dir(&dir, Some(uid)).is_some());
        let link = temp.path().join("l");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(
            own_dir(&link, Some(uid)).is_none(),
            "a link is never a folder"
        );
        std::fs::write(temp.path().join("f"), "").unwrap();
        assert!(own_dir(&temp.path().join("f"), Some(uid)).is_none());
    }

    #[test]
    fn only_a_plain_file_name_is_written() {
        let temp = tempfile::tempdir().unwrap();
        let copies = DecryptedCopies::new(temp.path());
        let mut bad = vec!["", "..", ".", "a/b", "/abs.pdf", "../up.pdf"];
        if cfg!(windows) {
            bad.extend(["C:x.pdf", "a\\b.pdf"]);
        }
        for name in bad {
            let err = copies.write(name, b"x").unwrap_err();
            assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "{name:?}");
        }
        copies.write("fine name.pdf", b"x").unwrap();
        copies.wipe();
    }

    /// Review C1: a copy that can't be removed keeps `.lock` (and the lock)
    /// in place, so a later wipe, or a later run's sweep, removes it all.
    #[cfg(unix)]
    #[test]
    fn a_copy_that_cant_be_removed_keeps_the_lock_for_a_later_wipe_or_sweep() {
        use std::os::unix::fs::PermissionsExt;
        let chmod = |p: &Path, m| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m));
        let temp = tempfile::tempdir().unwrap();
        let copies = DecryptedCopies::new(temp.path());
        let gone = copies.write("gone.pdf", b"one").unwrap();
        let stuck = copies.write("stuck.pdf", b"two").unwrap();
        let stuck_dir = stuck.parent().unwrap().to_path_buf();
        chmod(&stuck_dir, 0o500).unwrap();
        copies.wipe();
        assert!(!gone.exists(), "what can go, goes");
        assert!(stuck.exists() && copies.folder().join(LOCK_FILE).exists());
        assert!(copies.lock.lock().unwrap().is_some(), "still held");
        chmod(&stuck_dir, 0o700).unwrap();
        copies.wipe();
        assert!(!copies.folder().exists());

        // The same for a gone run's folder found by a sweep.
        let dead = run_folder(temp.path(), &format!("liber-4000007-{HEX}"));
        let sub = dead.join("1");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("stuck.pdf"), "plaintext").unwrap();
        chmod(&sub, 0o500).unwrap();
        sweep(temp.path(), SystemTime::UNIX_EPOCH);
        assert!(dead.join(LOCK_FILE).exists() && sub.join("stuck.pdf").exists());
        chmod(&sub, 0o700).unwrap();
        sweep(temp.path(), SystemTime::UNIX_EPOCH);
        assert!(!dead.exists());
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
        sweep(
            temp.path(),
            SystemTime::now() + std::time::Duration::from_secs(3600),
        );
        assert!(a.exists());
        copies.wipe();
        assert!(!copies.folder().exists());
        // The next copy makes the folder again.
        let c = copies.write("again.pdf", b"three").unwrap();
        assert!(c.exists());
        copies.wipe();
    }
}
