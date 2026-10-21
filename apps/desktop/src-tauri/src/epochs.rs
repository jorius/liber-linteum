//! The epoch store (spec §16 #18): the highest key epoch this device has seen
//! for each encrypted vault, in `<config_dir>/vault-epochs.json` as
//! `{ "<vault_id hex>": epoch }`. A header at a lower epoch is an old header
//! put back (it would undo a rotation or a revoked slot): never opened.
//! One of the three audited exceptions to "no plaintext outside the vault":
//! it holds ids and numbers, nothing of the vault's content.

use crate::error::{CmdResult, CommandError, ErrorKind};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_NAME: &str = "vault-epochs.json";

/// One reader-modifier-writer of the store at a time in this process: two
/// unlocks at once must not lose a record (review I3).
static STORE: Mutex<()> = Mutex::new(());

type Store = BTreeMap<String, u32>;

fn hex(id: &[u8; 16]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

fn io(e: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Io, format!("{FILE_NAME}: {e}"))
}

fn hold() -> std::sync::MutexGuard<'static, ()> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// The store; empty when there is none. One that doesn't parse is `damaged`,
/// never an empty store: that would switch the rollback check off. The UI
/// offers [`reset`] after the user confirms.
fn load(path: &Path) -> CmdResult<Store> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            CommandError::new(
                ErrorKind::Damaged,
                format!(
                    "this device's rollback memory, {}, is damaged ({e}): encrypted vaults \
                     stay closed until it is reset",
                    path.display()
                ),
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::new()),
        Err(e) => Err(io(e)),
    }
}

/// Fails as [`check_and_record`] would on a store it can't read; changes nothing.
pub fn check_readable(config_dir: &Path) -> CmdResult<()> {
    let _one = hold();
    load(&config_dir.join(FILE_NAME)).map(|_| ())
}

/// `Err(rollback)` if `epoch` is below the stored one for `vault_id`;
/// otherwise records the higher of the two.
pub fn check_and_record(config_dir: &Path, vault_id: &[u8; 16], epoch: u32) -> CmdResult<()> {
    let _one = hold();
    let path = config_dir.join(FILE_NAME);
    let mut store = load(&path)?;
    let key = hex(vault_id);
    let stored = store.get(&key).copied().unwrap_or(0);
    if epoch < stored {
        return Err(CommandError::new(
            ErrorKind::Rollback,
            format!(
                "this vault's header is at key epoch {epoch}, but this device has seen epoch \
                 {stored}: an old header was put back. It isn't opened."
            ),
        ));
    }
    if epoch == stored {
        return Ok(());
    }
    store.insert(key, epoch);
    save(config_dir, &store)
}

/// Atomic: a temp file unique to this write → fsync → rename → fsync the folder.
fn save(config_dir: &Path, store: &Store) -> CmdResult<()> {
    let json = serde_json::to_vec_pretty(store).map_err(io)?;
    write_atomic(config_dir, FILE_NAME, &json).map_err(io)
}

fn write_atomic(config_dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::fs::create_dir_all(config_dir)?;
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let tmp = config_dir.join(format!(".{name}.tmp-{}-{n}", std::process::id()));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, config_dir.join(name))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    #[cfg(unix)]
    if let Ok(dir) = std::fs::File::open(config_dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Where this install's id lives: random, made once (encryption UX §8.2).
const INSTALL_ID_FILE: &str = "install-id";

/// This install's id, which an in-place conversion's journal carries so only
/// this device recovers it (§8.2). Made once, then kept.
pub fn install_id(config_dir: &Path) -> CmdResult<String> {
    static MAKING: Mutex<()> = Mutex::new(());
    let _one = MAKING.lock().unwrap_or_else(|e| e.into_inner());
    let path = config_dir.join(INSTALL_ID_FILE);
    let fail =
        |e: std::io::Error| CommandError::new(ErrorKind::Io, format!("{INSTALL_ID_FILE}: {e}"));
    match std::fs::read_to_string(&path) {
        Ok(id) if !id.trim().is_empty() => return Ok(id.trim().to_string()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(fail(e)),
    }
    let id = hex(&liber_crypto::FolderId::random().0);
    write_atomic(config_dir, INSTALL_ID_FILE, id.as_bytes()).map_err(fail)?;
    Ok(id)
}

/// Moves a damaged store aside as `vault-epochs.json.damaged-<unix secs>`,
/// kept for inspection, after the user confirmed losing this device's
/// protection against an old header put back. A readable store is refused
/// (`notPermitted`): the webview can't switch the check off at will.
pub fn reset(config_dir: &Path) -> CmdResult<()> {
    let _one = hold();
    let path = config_dir.join(FILE_NAME);
    match load(&path) {
        Err(e) if e.kind == ErrorKind::Damaged => {}
        Err(e) => return Err(e),
        Ok(_) => {
            return Err(CommandError::new(
                ErrorKind::NotPermitted,
                "this device's rollback memory isn't damaged",
            ));
        }
    }
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let aside = config_dir.join(format!("{FILE_NAME}.damaged-{secs}"));
    std::fs::rename(&path, aside).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_the_highest_epoch_and_refuses_a_lower_one() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = ([1u8; 16], [2u8; 16]);
        check_and_record(dir.path(), &a, 1).unwrap();
        check_and_record(dir.path(), &a, 3).unwrap();
        check_and_record(dir.path(), &b, 1).unwrap();
        let err = check_and_record(dir.path(), &a, 2).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Rollback);
        check_and_record(dir.path(), &a, 3).unwrap();
        let store: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(store[hex(&a)], 3);
        assert_eq!(store[hex(&b)], 1);
    }

    #[test]
    fn a_damaged_store_fails_closed_until_reset() {
        let dir = tempfile::tempdir().unwrap();
        let a = [1u8; 16];
        check_and_record(dir.path(), &a, 1).unwrap();
        let err = reset(dir.path()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotPermitted, "a readable store stays");
        std::fs::write(dir.path().join(FILE_NAME), "{ torn").unwrap();
        for err in [
            check_and_record(dir.path(), &a, 9).unwrap_err(),
            check_readable(dir.path()).unwrap_err(),
        ] {
            assert_eq!(err.kind, ErrorKind::Damaged);
            assert!(
                err.message
                    .contains(&dir.path().join(FILE_NAME).display().to_string())
            );
        }
        reset(dir.path()).unwrap();
        let aside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("vault-epochs.json.damaged-"))
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            std::fs::read(dir.path().join(&aside[0])).unwrap(),
            b"{ torn",
            "kept aside, unchanged"
        );
        check_and_record(dir.path(), &a, 1).unwrap();
    }

    #[test]
    fn the_install_id_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let id = install_id(dir.path()).unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(install_id(dir.path()).unwrap(), id);
        let other = tempfile::tempdir().unwrap();
        assert_ne!(install_id(other.path()).unwrap(), id);
    }

    #[test]
    fn concurrent_records_are_all_kept() {
        let dir = tempfile::tempdir().unwrap();
        let threads: Vec<_> = (0..16u8)
            .map(|i| {
                let dir = dir.path().to_path_buf();
                std::thread::spawn(move || check_and_record(&dir, &[i; 16], 1 + u32::from(i)))
            })
            .collect();
        for t in threads {
            t.join().unwrap().unwrap();
        }
        let store: Store =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(store.len(), 16);
        for i in 0..16u8 {
            assert_eq!(store[&hex(&[i; 16])], 1 + u32::from(i));
        }
    }
}
