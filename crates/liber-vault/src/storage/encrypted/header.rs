//! Header changes on an unlocked vault (E3 Task 5): a new passphrase, a new
//! recovery code, and merging the header's sync-conflict copies (spec §4.3).
//! Every write goes through `VaultHeader`, which verifies before it signs
//! (format §16 #19).

use super::{EncryptedStorage, HEADER_FILE, crypto, lock, read_header};
use crate::error::{Result, VaultError, io_err};
use crate::path::VaultPath;
use crate::storage::Replace;
use crate::storage::plain::replace_atomic;
use liber_crypto::{
    Argon2Params, CryptoError, MergeOutcome, NewSlot, RecoveryCode, SlotKind, Unlock, Unlocked,
    VaultHeader,
};
use std::path::{Path, PathBuf};

/// Passphrase slots a header may hold (format §6).
const MAX_PASSPHRASE_SLOTS: usize = 4;

/// A sync client's copy of the header: `liber-vault (conflicted copy).json`,
/// `liber-vault 2.json`, `liber-vault.sync-conflict-<…>.json`.
fn is_header_copy(name: &str) -> bool {
    name != HEADER_FILE
        && name.starts_with("liber-vault")
        && (name.ends_with(".json") || name.contains(".sync-conflict-"))
}

/// Where a merged header copy goes in the app: the OS trash.
pub fn trash_header_copy(path: &Path) -> std::io::Result<()> {
    trash::delete(path).map_err(std::io::Error::other)
}

fn ids(h: &VaultHeader, kind: fn(&SlotKind) -> bool) -> Vec<[u8; 16]> {
    h.slots()
        .iter()
        .filter(|s| kind(&s.kind))
        .map(|s| s.id)
        .collect()
}

fn is_recovery(k: &SlotKind) -> bool {
    matches!(k, SlotKind::Recovery)
}

fn is_passphrase(k: &SlotKind) -> bool {
    matches!(k, SlotKind::Passphrase { .. })
}

/// The passphrase slot `pass` opens: each tried alone (a copy without the
/// others), one Argon2 run per slot.
fn passphrase_slot(h: &VaultHeader, u: &Unlocked, pass: &str) -> Result<[u8; 16]> {
    let all = ids(h, is_passphrase);
    for id in &all {
        let mut alone = h.clone();
        for other in all.iter().filter(|o| *o != id) {
            alone.remove_slot(u, other).map_err(crypto)?;
        }
        match alone.unlock(Unlock::Passphrase(pass)) {
            Ok(_) => return Ok(*id),
            Err(CryptoError::Authentication) => {}
            Err(e) => return Err(crypto(e)),
        }
    }
    Err(VaultError::WrongSecret)
}

impl EncryptedStorage {
    /// Replaces the passphrase slot `current` opens with one for `next`
    /// (spec §3.2: rewrap one slot); `WrongSecret` if it opens none.
    /// `params` (called once `current` is proven: calibrating takes seconds)
    /// must meet the Argon2 floor.
    pub fn change_passphrase(
        &self,
        current: &str,
        next: &str,
        params: impl FnOnce() -> Argon2Params,
    ) -> Result<()> {
        let keys = self.keys()?;
        let u = &keys.unlocked;
        let mut header = lock(&self.header);
        let old = passphrase_slot(&header, u, current)?;
        let params = params();
        let mut h = header.clone();
        let add = |h: &mut VaultHeader| h.add_slot(u, NewSlot::Passphrase(next, params));
        // The last passphrase slot can't be removed, nor a fifth added.
        if ids(&h, is_passphrase).len() < MAX_PASSPHRASE_SLOTS {
            add(&mut h).map_err(crypto)?;
            h.remove_slot(u, &old).map_err(crypto)?;
        } else {
            h.remove_slot(u, &old).map_err(crypto)?;
            add(&mut h).map_err(crypto)?;
        }
        self.write_header(&mut h, u, &[])?;
        *header = h;
        Ok(())
    }

    /// A new recovery code, replacing the old one, once `passphrase` proves
    /// the user: `WrongSecret` if it opens no slot.
    pub fn new_recovery(&self, passphrase: &str) -> Result<RecoveryCode> {
        let keys = self.keys()?;
        let u = &keys.unlocked;
        let mut header = lock(&self.header);
        header
            .unlock(Unlock::Passphrase(passphrase))
            .map_err(|e| match e {
                CryptoError::Authentication => VaultError::WrongSecret,
                e => crypto(e),
            })?;
        let mut h = header.clone();
        let code = h.new_recovery(u).map_err(crypto)?;
        let mine = ids(&h, is_recovery);
        // Another device's new code on disk may win the merge (smallest id):
        // then this code wouldn't open the vault, so none is returned.
        self.write_header(&mut h, u, &mine)?;
        *header = h;
        Ok(code)
    }

    /// Merges each sync-conflict copy of the header in the vault root into
    /// it and writes it; then hands each merged copy to `discard`. A copy
    /// that doesn't parse, or isn't this vault's at this epoch with a valid
    /// MAC, stays where it is. `None` if nothing merged.
    pub fn merge_header_copies(
        &self,
        discard: impl Fn(&Path) -> std::io::Result<()>,
    ) -> Result<Option<MergeOutcome>> {
        let err = |e| io_err(self.root.display().to_string(), e);
        let mut copies: Vec<PathBuf> = std::fs::read_dir(&self.root)
            .map_err(err)?
            .filter_map(|i| i.ok())
            .filter(|i| i.file_name().to_str().is_some_and(is_header_copy))
            .filter(|i| i.file_type().is_ok_and(|t| t.is_file()))
            .map(|i| i.path())
            .collect();
        copies.sort();
        let keys = self.keys()?;
        let u = &keys.unlocked;
        let mut header = lock(&self.header);
        let mut next = header.clone();
        let mut merged = Vec::new();
        let mut added = 0;
        for copy in &copies {
            let Some(other) = read_header(copy)
                .ok()
                .and_then(|b| VaultHeader::parse(&b).ok())
            else {
                continue;
            };
            let mut trial = next.clone();
            if let Ok(o) = trial.merge_from(&other, u) {
                added += o.added;
                next = trial;
                merged.push(copy);
            }
        }
        if merged.is_empty() {
            return Ok(None);
        }
        let now = ids(&next, is_recovery);
        let local_recovery_dropped = ids(&header, is_recovery).iter().any(|id| !now.contains(id));
        self.write_header(&mut next, u, &[])?;
        *header = next;
        drop(header);
        for copy in merged {
            // One left behind merges again, to the same result, next time.
            let _ = discard(copy);
        }
        Ok(Some(MergeOutcome {
            added,
            local_recovery_dropped,
        }))
    }

    /// Writes `h`, after merging in the header on disk: a change another
    /// device made since (same epoch) is kept, and a header at another
    /// epoch (a rotation) is never overwritten: `Conflict`. `Conflict` too
    /// if a slot in `keep` didn't survive the merge.
    fn write_header(&self, h: &mut VaultHeader, u: &Unlocked, keep: &[[u8; 16]]) -> Result<()> {
        let path = self.root.join(HEADER_FILE);
        let bytes = read_header(&path).map_err(|e| io_err(HEADER_FILE, e))?;
        let disk = VaultHeader::parse(&bytes).map_err(crypto)?;
        // Another device rotated it (or it won't merge): a sync conflict, not
        // damage; locking and unlocking again reads the new one (review M1).
        h.merge_from(&disk, u).map_err(|_| VaultError::Conflict {
            path: HEADER_FILE.to_string(),
            current: crate::Hash::of(&bytes),
        })?;
        if keep.iter().any(|id| !h.slots().iter().any(|s| s.id == *id)) {
            return Err(VaultError::Conflict {
                path: HEADER_FILE.to_string(),
                current: crate::Hash::of(&bytes),
            });
        }
        let bytes = h.to_bytes(u).map_err(crypto)?;
        replace_atomic(
            &self.root,
            &VaultPath::new(HEADER_FILE)?,
            &mut &bytes[..],
            Replace::Overwrite,
            false,
        )
    }
}
