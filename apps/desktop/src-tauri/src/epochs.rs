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

const FILE_NAME: &str = "vault-epochs.json";

fn hex(id: &[u8; 16]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

fn io(e: impl std::fmt::Display) -> CommandError {
    CommandError::new(ErrorKind::Io, format!("{FILE_NAME}: {e}"))
}

/// `Err(rollback)` if `epoch` is below the stored one for `vault_id`;
/// otherwise records the higher of the two. A store that can't be read is
/// an error, never an empty store: that would disable the check.
pub fn check_and_record(config_dir: &Path, vault_id: &[u8; 16], epoch: u32) -> CmdResult<()> {
    let path = config_dir.join(FILE_NAME);
    let mut store: BTreeMap<String, u32> = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(io(e)),
    };
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
    // Atomic: temp file in the same folder → fsync → rename.
    std::fs::create_dir_all(config_dir).map_err(io)?;
    let tmp = config_dir.join(format!(".{FILE_NAME}.tmp-{}", std::process::id()));
    let json = serde_json::to_vec_pretty(&store).map_err(io)?;
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(io)
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
        std::fs::write(dir.path().join(FILE_NAME), "{ torn").unwrap();
        let err = check_and_record(dir.path(), &a, 9).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io, "a damaged store is never reset");
    }
}
