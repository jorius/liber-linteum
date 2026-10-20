//! The vault header `nimw-vault.json`: key slots plus an HMAC over canonical JSON (spec §3.2).
//!
//! Canonical JSON is the header as a `serde_json::Value` without `"mac"`, serialised compactly with
//! sorted keys (serde_json's default `Map`; the workspace must not enable `preserve_order`).
//! Fields this version doesn't know inside known objects are dropped on parse, so a future writer
//! must add new data as a new slot type or a new format version.

use data_encoding::BASE64URL_NOPAD;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::error::{CryptoError, Result};
use crate::kdf::{Argon2Params, passphrase_kek};
use crate::keys::{Secret, Subkeys, VaultId, VaultKey, hkdf_sha256, hmac_sha256, random_bytes};
use crate::recovery::RecoveryCode;
use crate::slots::{
    NewSlot, Slot, SlotKind, Unlock, aad, b64, bytes, device_kek, field, object, recovery_kek,
    slot_aad, slot_from_json, slot_to_json, text, uint, unwrap, wrap,
};

const FORMAT: &str = "nimw-vault";
const VERSION: u64 = 1;
const MAX_HEADER_BYTES: usize = 1 << 20;
/// Known plus unknown slots; also bounds how many KDF runs a hostile header can cause.
const MAX_SLOTS: usize = 64;
/// One normally; a few while a passphrase change or merge settles. Each costs a KDF run on unlock.
const MAX_PASSPHRASE_SLOTS: usize = 4;
/// Tombstones reset at each key rotation, so this is never reached in practice.
const MAX_REMOVED: usize = 1024;
const RETIRING: &[u8] = b"nimw/v1/retiring";

/// The previous vault key during a rotation, wrapped under the new one.
#[derive(Clone, Debug)]
struct Retiring {
    epoch: u32,
    nonce: [u8; 12],
    wrapped: Vec<u8>,
}

/// An open vault: its key, subkeys, and (mid-rotation) the retiring epoch's subkeys.
pub struct Unlocked {
    pub vk: VaultKey,
    pub subkeys: Subkeys,
    pub epoch: u32,
    pub retiring: Option<(u32, Subkeys)>,
    /// Which vault these keys open; headers refuse an `Unlocked` from another vault or epoch.
    vault_id: VaultId,
}

impl Unlocked {
    fn new(vk: VaultKey, id: &VaultId, epoch: u32, retiring: Option<(u32, Subkeys)>) -> Self {
        Self {
            subkeys: Subkeys::derive(&vk, id),
            vk,
            epoch,
            retiring,
            vault_id: *id,
        }
    }

    /// K_content for a file written at `epoch`.
    pub fn content_key(&self, epoch: u32) -> Option<&Secret<32>> {
        if epoch == self.epoch {
            return Some(&self.subkeys.content);
        }
        match &self.retiring {
            Some((e, k)) if *e == epoch => Some(&k.content),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct VaultHeader {
    pub vault_id: VaultId,
    pub epoch: u32,
    pub slots: Vec<Slot>,
    retiring: Option<Retiring>,
    /// Slot types this version can't read, with their index in the file's `slots` array.
    unknown_slots: Vec<(usize, Value)>,
    /// Ids of slots removed this epoch, sorted: a merge never brings them back (spec §4.3).
    removed: Vec<[u8; 16]>,
    /// Kept valid by every method that takes an `Unlocked`; `remove_slot` leaves it stale until `to_bytes`.
    mac: [u8; 32],
}

impl VaultHeader {
    /// A new vault with a passphrase slot and a recovery slot. `params` must meet the floor.
    pub fn create(
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(VaultHeader, Unlocked, RecoveryCode)> {
        params.check_floor()?;
        Self::create_unchecked(passphrase, params)
    }

    /// `create` without the Argon2 floor (tests and vectors use tiny parameters).
    pub(crate) fn create_unchecked(
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(VaultHeader, Unlocked, RecoveryCode)> {
        let vault_id = VaultId::random();
        let u = Unlocked::new(VaultKey::random(), &vault_id, 1, None);
        let mut h = VaultHeader {
            vault_id,
            epoch: 1,
            slots: Vec::new(),
            retiring: None,
            unknown_slots: Vec::new(),
            removed: Vec::new(),
            mac: [0; 32],
        };
        h.push_passphrase(&u.vk, passphrase, params)?;
        let rc = h.push_recovery(&u.vk)?;
        h.seal(&u);
        Ok((h, u, rc))
    }

    /// Checks format, version and parameter caps. The MAC is checked by `unlock`.
    pub fn parse(input: &[u8]) -> Result<VaultHeader> {
        if input.len() > MAX_HEADER_BYTES {
            return Err(CryptoError::BadFormat("header too large"));
        }
        let v: Value = serde_json::from_slice(input)?;
        let o = object(&v, "header")?;
        if text(o, "format")? != FORMAT {
            return Err(CryptoError::BadFormat("format"));
        }
        let version = field(o, "version")?
            .as_u64()
            .ok_or(CryptoError::BadFormat("version"))?;
        if version != VERSION {
            return Err(CryptoError::UnsupportedVersion(
                u32::try_from(version).unwrap_or(u32::MAX),
            ));
        }
        let list = field(o, "slots")?
            .as_array()
            .ok_or(CryptoError::BadFormat("slots"))?;
        if list.len() > MAX_SLOTS {
            return Err(CryptoError::BadFormat("too many slots"));
        }
        let mut slots = Vec::new();
        let mut unknown_slots = Vec::new();
        for (i, s) in list.iter().enumerate() {
            match slot_from_json(s)? {
                Some(slot) if slots.iter().any(|k: &Slot| k.id == slot.id) => {
                    return Err(CryptoError::BadFormat("duplicate slot id"));
                }
                Some(slot) => slots.push(slot),
                None => unknown_slots.push((i, s.clone())),
            }
        }
        if passphrase_count(&slots) > MAX_PASSPHRASE_SLOTS {
            return Err(CryptoError::BadFormat("too many passphrase slots"));
        }
        let list = field(o, "removed")?
            .as_array()
            .ok_or(CryptoError::BadFormat("removed"))?;
        if list.len() > MAX_REMOVED {
            return Err(CryptoError::BadFormat("too many removed slots"));
        }
        let mut removed = list
            .iter()
            .map(|r| {
                r.as_str()
                    .and_then(|s| BASE64URL_NOPAD.decode(s.as_bytes()).ok())
                    .and_then(|b| <[u8; 16]>::try_from(b).ok())
                    .ok_or(CryptoError::BadFormat("removed"))
            })
            .collect::<Result<Vec<_>>>()?;
        removed.sort_unstable();
        removed.dedup();
        let retiring = match field(o, "retiring")? {
            Value::Null => None,
            r => {
                let r = object(r, "retiring")?;
                Some(Retiring {
                    epoch: uint(r, "epoch")?,
                    nonce: bytes(r, "nonce")?,
                    wrapped: bytes::<{ crate::slots::WRAPPED_LEN }>(r, "wrapped")?.to_vec(),
                })
            }
        };
        Ok(VaultHeader {
            vault_id: VaultId(bytes(o, "vault_id")?),
            epoch: uint(o, "epoch")?,
            slots,
            retiring,
            unknown_slots,
            removed,
            mac: bytes(o, "mac")?,
        })
    }

    /// Opens the first matching slot, then verifies the header MAC.
    pub fn unlock(&self, with: Unlock) -> Result<Unlocked> {
        let id = &self.vault_id;
        for s in &self.slots {
            let kek = match (&s.kind, &with) {
                (SlotKind::Passphrase { params, salt }, Unlock::Passphrase(pw)) => {
                    passphrase_kek(pw, salt, params)?
                }
                (SlotKind::Recovery, Unlock::Recovery(rc)) => recovery_kek(rc, id),
                (SlotKind::Device { .. }, Unlock::Device(secret)) => device_kek(secret, id),
                _ => continue,
            };
            let Ok(vk) = unwrap(
                &kek,
                &s.nonce,
                &slot_aad(id, self.epoch, &s.id, &s.kind),
                &s.wrapped,
            ) else {
                continue;
            };
            let mut u = Unlocked::new(vk, id, self.epoch, None);
            self.verify(&u.subkeys.header)?;
            if let Some(r) = &self.retiring {
                let old = unwrap(
                    &retiring_kek(&u.vk, id),
                    &r.nonce,
                    &aad(RETIRING, id, r.epoch, &[]),
                    &r.wrapped,
                )?;
                u.retiring = Some((r.epoch, Subkeys::derive(&old, id)));
            }
            return Ok(u);
        }
        Err(CryptoError::Authentication)
    }

    /// The file bytes, with the MAC recomputed under `u`'s header key. Refuses an `Unlocked`
    /// from another vault or epoch, whose MAC would lock everyone out.
    pub fn to_bytes(&self, u: &Unlocked) -> Result<Vec<u8>> {
        self.check_unlocked(u)?;
        let mut v = self.to_json();
        v["mac"] = b64(&mac_over(&v, &u.subkeys.header));
        Ok(serde_json::to_vec(&v).expect("a Value always serialises"))
    }

    pub fn add_slot(&mut self, u: &Unlocked, s: NewSlot) -> Result<[u8; 16]> {
        self.check_unlocked(u)?;
        let id = match s {
            NewSlot::Passphrase(pw, params) => {
                params.check_floor()?;
                self.push_passphrase(&u.vk, pw, params)?
            }
            NewSlot::Device { device_id, secret } => {
                if device_id.len() > crate::slots::MAX_DEVICE_ID {
                    return Err(CryptoError::Params("device id too long"));
                }
                let kek = device_kek(secret, &self.vault_id);
                self.push(SlotKind::Device { device_id }, &kek, &u.vk)?
            }
        };
        self.seal(u);
        Ok(id)
    }

    /// Refuses to remove the recovery slot or the last passphrase slot.
    pub fn remove_slot(&mut self, id: &[u8; 16]) -> Result<()> {
        let i = self
            .slots
            .iter()
            .position(|s| &s.id == id)
            .ok_or(CryptoError::Params("no such slot"))?;
        let passphrases = passphrase_count(&self.slots);
        match self.slots[i].kind {
            SlotKind::Recovery => Err(CryptoError::Params("the recovery slot can't be removed")),
            SlotKind::Passphrase { .. } if passphrases == 1 => Err(CryptoError::Params(
                "the last passphrase slot can't be removed",
            )),
            _ => {
                self.bury(&[*id])?;
                self.slots.remove(i);
                Ok(())
            }
        }
    }

    /// Replaces the recovery slot; the returned code is shown once.
    pub fn new_recovery(&mut self, u: &Unlocked) -> Result<RecoveryCode> {
        self.check_unlocked(u)?;
        let old: Vec<[u8; 16]> = recovery_slot_ids(&self.slots).collect();
        self.bury(&old)?;
        self.slots.retain(|s| !matches!(s.kind, SlotKind::Recovery));
        let rc = self.push_recovery(&u.vk)?;
        self.seal(u);
        Ok(rc)
    }

    /// Merges a sync-conflict copy (spec §4.3) and returns how many of its slots were added.
    /// A slot can't be checked without its secret, so `other` must carry a valid MAC under this
    /// vault's header key at the same epoch; anything else is refused whole. Tombstones are
    /// unioned: no removed slot is added, and local slots the other copy removed are dropped.
    pub fn merge_from(&mut self, other: &VaultHeader, u: &Unlocked) -> Result<usize> {
        self.check_unlocked(u)?;
        if other.vault_id != self.vault_id || other.epoch != self.epoch {
            return Err(CryptoError::Authentication);
        }
        other.verify(&u.subkeys.header)?;
        let mut removed = [&self.removed[..], &other.removed[..]].concat();
        removed.sort_unstable();
        removed.dedup();
        let live = |s: &&Slot| removed.binary_search(&s.id).is_err();
        let mut slots: Vec<Slot> = self.slots.iter().filter(live).cloned().collect();
        let mut added = Vec::new();
        for s in other.slots.iter().filter(live) {
            if !slots.iter().any(|m| m.id == s.id) {
                added.push(s.id);
                slots.push(s.clone());
            }
        }
        // Both copies ran `new_recovery`: keep the recovery slot with the smallest id, so every
        // device converges on the same one. The other code stops working.
        if let Some(keep) = recovery_slot_ids(&slots).min() {
            removed.extend(recovery_slot_ids(&slots).filter(|id| *id != keep));
            removed.sort_unstable();
            slots.retain(|s| !matches!(s.kind, SlotKind::Recovery) || s.id == keep);
        }
        if slots.len() + self.unknown_slots.len() > MAX_SLOTS
            || passphrase_count(&slots) > MAX_PASSPHRASE_SLOTS
            || removed.len() > MAX_REMOVED
        {
            return Err(CryptoError::Params("merged header would exceed its limits"));
        }
        let n = added
            .iter()
            .filter(|id| slots.iter().any(|s| s.id == **id))
            .count();
        self.slots = slots;
        self.removed = removed;
        self.seal(u);
        Ok(n)
    }

    /// Starts a key rotation (spec §3.2): new VK at the next epoch, the old one kept as retiring.
    /// Only a new passphrase slot and a new recovery slot remain; device slots are dropped and
    /// keyring slots must be re-added by the caller.
    pub fn begin_rotation(
        &mut self,
        u: &Unlocked,
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(Unlocked, RecoveryCode)> {
        params.check_floor()?;
        self.begin_rotation_unchecked(u, passphrase, params)
    }

    pub(crate) fn begin_rotation_unchecked(
        &mut self,
        u: &Unlocked,
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(Unlocked, RecoveryCode)> {
        self.check_unlocked(u)?;
        if self.retiring.is_some() {
            return Err(CryptoError::Params("a rotation is already in progress"));
        }
        let id = self.vault_id;
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or(CryptoError::Params("epoch overflow"))?;
        let nu = Unlocked::new(
            VaultKey::random(),
            &id,
            epoch,
            Some((self.epoch, Subkeys::derive(&u.vk, &id))),
        );
        let nonce = random_bytes();
        let retiring = Retiring {
            epoch: self.epoch,
            nonce,
            wrapped: wrap(
                &retiring_kek(&nu.vk, &id),
                &nonce,
                &aad(RETIRING, &id, self.epoch, &[]),
                &u.vk,
            ),
        };
        let mut next = VaultHeader {
            vault_id: id,
            epoch,
            slots: Vec::new(),
            retiring: Some(retiring),
            unknown_slots: Vec::new(),
            removed: Vec::new(),
            mac: [0; 32],
        };
        next.push_passphrase(&nu.vk, passphrase, params)?;
        let rc = next.push_recovery(&nu.vk)?;
        next.seal(&nu);
        *self = next;
        Ok((nu, rc))
    }

    /// Drops the retiring key once every file is at the current epoch.
    pub fn finish_rotation(&mut self, u: &Unlocked) -> Result<()> {
        self.check_unlocked(u)?;
        self.retiring = None;
        self.seal(u);
        Ok(())
    }

    fn check_unlocked(&self, u: &Unlocked) -> Result<()> {
        if u.vault_id != self.vault_id || u.epoch != self.epoch {
            return Err(CryptoError::Params(
                "unlocked key is for another vault or epoch",
            ));
        }
        Ok(())
    }

    /// Records removed slot ids (sorted) so a merge can't bring them back.
    fn bury(&mut self, ids: &[[u8; 16]]) -> Result<()> {
        if self.removed.len() + ids.len() > MAX_REMOVED {
            return Err(CryptoError::Params(
                "too many removed slots; rotate the vault key",
            ));
        }
        self.removed.extend_from_slice(ids);
        self.removed.sort_unstable();
        self.removed.dedup();
        Ok(())
    }

    fn slot_count(&self) -> usize {
        self.slots.len() + self.unknown_slots.len()
    }

    fn push(&mut self, kind: SlotKind, kek: &Secret<32>, vk: &VaultKey) -> Result<[u8; 16]> {
        if self.slot_count() >= MAX_SLOTS {
            return Err(CryptoError::Params("too many slots"));
        }
        if matches!(kind, SlotKind::Passphrase { .. })
            && passphrase_count(&self.slots) >= MAX_PASSPHRASE_SLOTS
        {
            return Err(CryptoError::Params("too many passphrase slots"));
        }
        let id: [u8; 16] = random_bytes();
        let nonce = random_bytes();
        let aad = slot_aad(&self.vault_id, self.epoch, &id, &kind);
        let wrapped = wrap(kek, &nonce, &aad, vk);
        self.slots.push(Slot {
            id,
            kind,
            nonce,
            wrapped,
        });
        Ok(id)
    }

    fn push_passphrase(
        &mut self,
        vk: &VaultKey,
        pw: &str,
        params: Argon2Params,
    ) -> Result<[u8; 16]> {
        let salt = random_bytes();
        let kek = passphrase_kek(pw, &salt, &params)?;
        self.push(SlotKind::Passphrase { params, salt }, &kek, vk)
    }

    fn push_recovery(&mut self, vk: &VaultKey) -> Result<RecoveryCode> {
        let rc = RecoveryCode::generate();
        let kek = recovery_kek(&rc, &self.vault_id);
        self.push(SlotKind::Recovery, &kek, vk)?;
        Ok(rc)
    }

    /// The header without `"mac"`; unknown slots go back to their original positions.
    fn to_json(&self) -> Value {
        let mut slots: Vec<Value> = self.slots.iter().map(slot_to_json).collect();
        for (i, v) in &self.unknown_slots {
            slots.insert((*i).min(slots.len()), v.clone());
        }
        json!({
            "format": FORMAT,
            "version": VERSION,
            "vault_id": b64(&self.vault_id.0),
            "epoch": self.epoch,
            "slots": slots,
            "removed": self.removed.iter().map(|r| b64(r)).collect::<Vec<_>>(),
            "retiring": self.retiring.as_ref().map(|r| json!({
                "epoch": r.epoch,
                "nonce": b64(&r.nonce),
                "wrapped": b64(&r.wrapped),
            })),
        })
    }

    fn seal(&mut self, u: &Unlocked) {
        self.mac = mac_over(&self.to_json(), &u.subkeys.header);
    }

    fn verify(&self, k_header: &Secret<32>) -> Result<()> {
        if bool::from(mac_over(&self.to_json(), k_header).ct_eq(&self.mac)) {
            Ok(())
        } else {
            Err(CryptoError::Authentication)
        }
    }
}

fn recovery_slot_ids(slots: &[Slot]) -> impl Iterator<Item = [u8; 16]> + '_ {
    slots
        .iter()
        .filter(|s| matches!(s.kind, SlotKind::Recovery))
        .map(|s| s.id)
}

fn passphrase_count(slots: &[Slot]) -> usize {
    slots
        .iter()
        .filter(|s| matches!(s.kind, SlotKind::Passphrase { .. }))
        .count()
}

fn mac_over(header: &Value, k_header: &Secret<32>) -> [u8; 32] {
    let canonical = serde_json::to_vec(header).expect("a Value always serialises");
    hmac_sha256(k_header.expose(), &[&canonical])
}

fn retiring_kek(new_vk: &VaultKey, id: &VaultId) -> Secret<32> {
    hkdf_sha256(new_vk.expose(), &id.0, RETIRING)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};

    use super::*;
    use crate::error::CryptoError;
    use crate::keys::{Secret, hmac_sha256, with_seeded_rng};
    use crate::slots::{NewSlot, SlotKind, Unlock};

    const TINY: Argon2Params = Argon2Params {
        m_kib: 8,
        t: 1,
        p: 1,
    };

    fn new_vault(pw: &str) -> (VaultHeader, Unlocked, RecoveryCode) {
        VaultHeader::create_unchecked(pw, TINY).unwrap()
    }

    fn device(h: &mut VaultHeader, u: &Unlocked, name: &str, secret: &Secret<32>) -> [u8; 16] {
        h.add_slot(
            u,
            NewSlot::Device {
                device_id: name.into(),
                secret,
            },
        )
        .unwrap()
    }

    fn id_of(h: &VaultHeader, f: impl Fn(&SlotKind) -> bool) -> [u8; 16] {
        h.slots.iter().find(|s| f(&s.kind)).unwrap().id
    }

    fn is_auth<T>(r: Result<T>) -> bool {
        matches!(r, Err(CryptoError::Authentication))
    }

    #[test]
    fn create_unlock_with_passphrase_and_recovery() {
        let (h, u, rc) = new_vault("correct horse");
        let a = h.unlock(Unlock::Passphrase("correct horse")).unwrap();
        let b = h.unlock(Unlock::Recovery(&rc)).unwrap();
        assert_eq!(a.vk.expose(), u.vk.expose());
        assert_eq!(b.vk.expose(), u.vk.expose());
        assert_eq!((a.epoch, b.epoch), (1, 1));
        assert!(a.retiring.is_none());
        assert!(is_auth(h.unlock(Unlock::Passphrase("wrong horse"))));
        assert!(is_auth(h.unlock(Unlock::Device(&Secret::random()))));
        // Through the file too.
        let p = VaultHeader::parse(&h.to_bytes(&u).unwrap()).unwrap();
        let c = p.unlock(Unlock::Passphrase("correct horse")).unwrap();
        assert_eq!(c.vk.expose(), u.vk.expose());
        // The public constructor enforces the Argon2 floor.
        assert!(matches!(
            VaultHeader::create("pw", TINY),
            Err(CryptoError::Params(_))
        ));
    }

    #[test]
    fn unlocked_from_another_vault_is_refused() {
        let (mut h, u, _) = new_vault("pw");
        let (_, other, _) = new_vault("pw");
        let before = h.to_bytes(&u).unwrap();
        let dev = Secret::random();
        let refused = |r: Result<()>| matches!(r, Err(CryptoError::Params(_)));
        assert!(refused(h.to_bytes(&other).map(drop)));
        assert!(refused(
            h.add_slot(
                &other,
                NewSlot::Device {
                    device_id: "d".into(),
                    secret: &dev
                }
            )
            .map(drop)
        ));
        assert!(refused(h.new_recovery(&other).map(drop)));
        assert!(refused(h.merge_from(&h.clone(), &other).map(drop)));
        assert!(refused(
            h.begin_rotation_unchecked(&other, "x", TINY).map(drop)
        ));
        assert!(refused(h.finish_rotation(&other)));
        assert_eq!(h.to_bytes(&u).unwrap(), before);
    }

    #[test]
    fn add_and_remove_device_slot() {
        let (mut h, u, rc) = new_vault("pw");
        let dev = Secret::random();
        let id = device(&mut h, &u, "mac-1", &dev);
        let d = h.unlock(Unlock::Device(&dev)).unwrap();
        assert_eq!(d.vk.expose(), u.vk.expose());
        h.remove_slot(&id).unwrap();
        assert!(h.remove_slot(&id).is_err());
        let p = VaultHeader::parse(&h.to_bytes(&u).unwrap()).unwrap();
        assert!(is_auth(p.unlock(Unlock::Device(&dev))));
        p.unlock(Unlock::Passphrase("pw")).unwrap();
        p.unlock(Unlock::Recovery(&rc)).unwrap();
        let pass = id_of(&h, |k| matches!(k, SlotKind::Passphrase { .. }));
        let rec = id_of(&h, |k| matches!(k, SlotKind::Recovery));
        assert!(matches!(h.remove_slot(&pass), Err(CryptoError::Params(_))));
        assert!(matches!(h.remove_slot(&rec), Err(CryptoError::Params(_))));
        assert_eq!(h.slots.len(), 2);
        // A new recovery key replaces the old one.
        let rc2 = h.new_recovery(&u).unwrap();
        assert!(is_auth(h.unlock(Unlock::Recovery(&rc))));
        h.unlock(Unlock::Recovery(&rc2)).unwrap();
        assert_eq!(h.slots.len(), 2);
    }

    #[test]
    fn header_json_round_trips_and_is_canonical() {
        // serde_json must not enable `preserve_order`: canonical JSON relies on sorted keys.
        assert_eq!(
            json!({"b": 1, "a": {"d": 2, "c": 3}}).to_string(),
            r#"{"a":{"c":3,"d":2},"b":1}"#
        );
        let (mut h, u, _) = new_vault("pw");
        device(&mut h, &u, "mac-1", &Secret::random());
        let bytes = h.to_bytes(&u).unwrap();
        let p = VaultHeader::parse(&bytes).unwrap();
        assert_eq!(p.to_bytes(&u).unwrap(), bytes);
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["format"], "nimw-vault");
        assert_eq!(v["version"], 1);
        assert_eq!(v["epoch"], 1);
        assert_eq!(v["retiring"], Value::Null);
        assert_eq!(v["slots"][0]["type"], "passphrase");
        assert_eq!(v["slots"][0]["kdf"]["alg"], "argon2id");
        assert_eq!(v["slots"][0]["kdf"]["m_kib"], 8);
        assert_eq!(v["slots"][1]["type"], "recovery");
        assert_eq!(v["slots"][2]["device_id"], "mac-1");
        assert_eq!(v["vault_id"].as_str().unwrap().len(), 22); // 16 bytes, Base64url, no padding
        // MAC = HMAC-SHA-256(K_header, compact sorted JSON without "mac").
        let mut canon = v.clone();
        canon.as_object_mut().unwrap().remove("mac");
        let want = hmac_sha256(
            u.subkeys.header.expose(),
            &[&serde_json::to_vec(&canon).unwrap()],
        );
        assert_eq!(
            data_encoding::BASE64URL_NOPAD.encode(&want),
            v["mac"].as_str().unwrap()
        );
        // Whitespace and key order on disk don't matter.
        let pretty = serde_json::to_vec_pretty(&v).unwrap();
        assert_ne!(pretty, bytes);
        let q = VaultHeader::parse(&pretty).unwrap();
        q.unlock(Unlock::Passphrase("pw")).unwrap();
        assert_eq!(q.to_bytes(&u).unwrap(), bytes);
    }

    #[test]
    fn seeded_rng_makes_headers_deterministic() {
        let make = |seed| {
            with_seeded_rng(seed, || {
                let (mut h, u, rc) = new_vault("pw");
                let dev = Secret::random();
                device(&mut h, &u, "d", &dev);
                (h.to_bytes(&u).unwrap(), rc.to_display())
            })
        };
        assert_eq!(make(7), make(7));
        assert_ne!(make(7), make(8));
    }

    enum Expect {
        ParseErr(fn(&CryptoError) -> bool),
        UnlockErr(fn(&CryptoError) -> bool),
        Ok,
    }

    #[test]
    fn hostile_headers_fail_cleanly() {
        let (mut h, u, _) = new_vault("pw");
        device(&mut h, &u, "mac-1", &Secret::random());
        let good: Value = serde_json::from_slice(&h.to_bytes(&u).unwrap()).unwrap();
        type Mutate = fn(&mut Value);
        let cases: Vec<(&str, Mutate, Expect)> = vec![
            ("untouched", |_| {}, Expect::Ok),
            (
                "m_kib 64 GiB",
                |v| v["slots"][0]["kdf"]["m_kib"] = json!(64u64 * 1024 * 1024),
                Expect::ParseErr(|e| matches!(e, CryptoError::Params(_))),
            ),
            (
                "m_kib over u32",
                |v| v["slots"][0]["kdf"]["m_kib"] = json!(1u64 << 40),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "t zero",
                |v| v["slots"][0]["kdf"]["t"] = json!(0),
                Expect::ParseErr(|e| matches!(e, CryptoError::Params(_))),
            ),
            (
                "unknown kdf alg",
                |v| v["slots"][0]["kdf"]["alg"] = json!("scrypt"),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "missing vault_id",
                |v| {
                    v.as_object_mut().unwrap().remove("vault_id");
                },
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "vault_id not base64",
                |v| v["vault_id"] = json!("!!"),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "vault_id wrong length",
                |v| v["vault_id"] = json!("AAAA"),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "nonce 11 bytes",
                |v| v["slots"][1]["nonce"] = json!("AAAAAAAAAAAAAAA"),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "wrapped too short",
                |v| v["slots"][1]["wrapped"] = json!("AAAA"),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "slots not an array",
                |v| v["slots"] = json!({}),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "slot not an object",
                |v| v["slots"][0] = json!(3),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "too many slots",
                |v| *v["slots"].as_array_mut().unwrap() = vec![json!({"type": "x"}); 65],
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat("too many slots"))),
            ),
            (
                "duplicate slot id",
                |v| {
                    let s = v["slots"][2].clone();
                    v["slots"].as_array_mut().unwrap().push(s);
                },
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat("duplicate slot id"))),
            ),
            (
                "five passphrase slots",
                |v| {
                    for c in ["B", "C", "D", "E"] {
                        let mut s = v["slots"][0].clone();
                        s["id"] = json!(format!("{c}AAAAAAAAAAAAAAAAAAAAA"));
                        v["slots"].as_array_mut().unwrap().push(s);
                    }
                },
                Expect::ParseErr(|e| {
                    matches!(e, CryptoError::BadFormat("too many passphrase slots"))
                }),
            ),
            (
                "four passphrase slots are fine (MAC then refuses the edit)",
                |v| {
                    for c in ["B", "C", "D"] {
                        let mut s = v["slots"][0].clone();
                        s["id"] = json!(format!("{c}AAAAAAAAAAAAAAAAAAAAA"));
                        v["slots"].as_array_mut().unwrap().push(s);
                    }
                },
                Expect::UnlockErr(|e| matches!(e, CryptoError::Authentication)),
            ),
            (
                "removed missing",
                |v| {
                    v.as_object_mut().unwrap().remove("removed");
                },
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat("removed"))),
            ),
            (
                "removed entry not a 16-byte id",
                |v| v["removed"] = json!(["AAAA"]),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat("removed"))),
            ),
            (
                "too many removed ids",
                |v| v["removed"] = json!(vec!["AAAAAAAAAAAAAAAAAAAAAA"; 1025]),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat("too many removed slots"))),
            ),
            (
                "epoch negative",
                |v| v["epoch"] = json!(-1),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "device_id not a string",
                |v| v["slots"][2]["device_id"] = json!(5),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "wrong format",
                |v| v["format"] = json!("other"),
                Expect::ParseErr(|e| matches!(e, CryptoError::BadFormat(_))),
            ),
            (
                "version 2",
                |v| v["version"] = json!(2),
                Expect::ParseErr(|e| matches!(e, CryptoError::UnsupportedVersion(2))),
            ),
            (
                "flipped mac byte",
                |v| {
                    let mut m = data_encoding::BASE64URL_NOPAD
                        .decode(v["mac"].as_str().unwrap().as_bytes())
                        .unwrap();
                    m[0] ^= 1;
                    v["mac"] = json!(data_encoding::BASE64URL_NOPAD.encode(&m));
                },
                Expect::UnlockErr(|e| matches!(e, CryptoError::Authentication)),
            ),
            (
                "device_id edited (MAC catches it)",
                |v| v["slots"][2]["device_id"] = json!("evil"),
                Expect::UnlockErr(|e| matches!(e, CryptoError::Authentication)),
            ),
            (
                "unknown slot type is kept (but unMACed here)",
                |v| {
                    v["slots"]
                        .as_array_mut()
                        .unwrap()
                        .insert(1, json!({"type": "recipient", "id": "x", "future": [1, 2]}));
                },
                Expect::UnlockErr(|e| matches!(e, CryptoError::Authentication)),
            ),
        ];
        for (name, mutate, expect) in cases {
            let mut v = good.clone();
            mutate(&mut v);
            let bytes = serde_json::to_vec(&v).unwrap();
            let start = Instant::now();
            let parsed = VaultHeader::parse(&bytes);
            assert!(
                start.elapsed() < Duration::from_millis(50),
                "{name}: parse ran long"
            );
            match expect {
                Expect::ParseErr(ok) => match parsed {
                    Err(e) => assert!(ok(&e), "{name}: got {e:?}"),
                    Ok(_) => panic!("{name}: parsed"),
                },
                Expect::UnlockErr(ok) => match parsed.unwrap().unlock(Unlock::Passphrase("pw")) {
                    Err(e) => assert!(ok(&e), "{name}: got {e:?}"),
                    Ok(_) => panic!("{name}: unlocked"),
                },
                Expect::Ok => {
                    parsed.unwrap().unlock(Unlock::Passphrase("pw")).unwrap();
                }
            }
        }
        // Garbage never panics.
        for junk in [
            &b""[..],
            b"null",
            b"[]",
            b"{",
            b"\xff\xfe",
            b"{\"format\":\"nimw-vault\"}",
        ] {
            assert!(VaultHeader::parse(junk).is_err());
        }
        assert!(VaultHeader::parse(&vec![b' '; 2 << 20]).is_err());
    }

    #[test]
    fn unknown_slot_survives_to_bytes_in_place() {
        let (h, u, _) = new_vault("pw");
        let mut v: Value = serde_json::from_slice(&h.to_bytes(&u).unwrap()).unwrap();
        let unknown =
            json!({"type": "recipient", "id": "AAAAAAAAAAAAAAAAAAAAAA", "future": [1, 2]});
        v["slots"]
            .as_array_mut()
            .unwrap()
            .insert(1, unknown.clone());
        let p = VaultHeader::parse(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(p.slots.len(), 2);
        // A writer that knows the type MACs it; this reader keeps it where it was.
        let written = p.to_bytes(&u).unwrap();
        let w: Value = serde_json::from_slice(&written).unwrap();
        assert_eq!(w["slots"][1], unknown);
        let q = VaultHeader::parse(&written).unwrap();
        q.unlock(Unlock::Passphrase("pw")).unwrap();
        assert_eq!(q.to_bytes(&u).unwrap(), written);
    }

    #[test]
    fn merge_keeps_valid_slots_only() {
        let (h, u, _) = new_vault("pw");
        let base = h.to_bytes(&u).unwrap();
        let mut a = VaultHeader::parse(&base).unwrap();
        let mut b = VaultHeader::parse(&base).unwrap();
        let (da, db) = (Secret::random(), Secret::random());
        device(&mut a, &u, "a", &da);
        device(&mut b, &u, "b", &db);
        assert_eq!(a.merge_from(&b, &u).unwrap(), 1);
        assert_eq!(a.merge_from(&b, &u).unwrap(), 0);
        let a = VaultHeader::parse(&a.to_bytes(&u).unwrap()).unwrap();
        for s in [&da, &db] {
            assert_eq!(
                a.unlock(Unlock::Device(s)).unwrap().vk.expose(),
                u.vk.expose()
            );
        }
        let mut a = a;
        let before = a.slots.len();
        // A look-alike header (same vault_id, different VK) is refused whole.
        let (mut c, mut cu, _) = new_vault("pw");
        c.vault_id = h.vault_id;
        cu.vault_id = h.vault_id;
        let dc = Secret::random();
        device(&mut c, &cu, "c", &dc);
        assert!(is_auth(a.merge_from(&c, &u)));
        // So is a genuine copy with a foreign slot spliced in.
        let mut b2 = VaultHeader::parse(&b.to_bytes(&u).unwrap()).unwrap();
        b2.slots.push(c.slots.last().unwrap().clone());
        assert!(is_auth(a.merge_from(&b2, &u)));
        assert_eq!(a.slots.len(), before);
        assert!(is_auth(a.unlock(Unlock::Device(&dc))));
    }

    fn recovery_ids(h: &VaultHeader) -> Vec<[u8; 16]> {
        h.slots
            .iter()
            .filter(|s| matches!(s.kind, SlotKind::Recovery))
            .map(|s| s.id)
            .collect()
    }

    #[test]
    fn merge_honours_tombstones() {
        let (mut h, u, rc) = new_vault("pw");
        let dev = Secret::random();
        let dev_id = device(&mut h, &u, "d", &dev);
        let base = h.to_bytes(&u).unwrap();
        // A removed a device slot; B is a stale copy that still has it.
        let mut a = VaultHeader::parse(&base).unwrap();
        let mut b = VaultHeader::parse(&base).unwrap();
        a.remove_slot(&dev_id).unwrap();
        assert_eq!(a.merge_from(&b, &u).unwrap(), 0);
        assert!(is_auth(a.unlock(Unlock::Device(&dev))));
        let a_bytes = a.to_bytes(&u).unwrap();
        let v: Value = serde_json::from_slice(&a_bytes).unwrap();
        assert_eq!(
            v["removed"],
            json!([data_encoding::BASE64URL_NOPAD.encode(&dev_id)])
        );
        // The stale copy drops it too when it merges the newer one.
        assert_eq!(
            b.merge_from(&VaultHeader::parse(&a_bytes).unwrap(), &u)
                .unwrap(),
            0
        );
        assert!(is_auth(b.unlock(Unlock::Device(&dev))));
        assert_eq!(b.to_bytes(&u).unwrap(), a_bytes);
        // A replaced recovery code stays replaced.
        let mut a = VaultHeader::parse(&base).unwrap();
        let b = VaultHeader::parse(&base).unwrap();
        let rc_a = a.new_recovery(&u).unwrap();
        assert_eq!(a.merge_from(&b, &u).unwrap(), 0);
        assert!(is_auth(a.unlock(Unlock::Recovery(&rc))));
        a.unlock(Unlock::Recovery(&rc_a)).unwrap();
        // Tombstones are MACed.
        let mut v: Value = serde_json::from_slice(&a.to_bytes(&u).unwrap()).unwrap();
        v["removed"] = json!([]);
        let t = VaultHeader::parse(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(is_auth(t.unlock(Unlock::Passphrase("pw"))));
    }

    #[test]
    fn concurrent_recovery_replacements_converge_on_one() {
        let (h, u, _) = new_vault("pw");
        let base = h.to_bytes(&u).unwrap();
        let mut a = VaultHeader::parse(&base).unwrap();
        let mut b = VaultHeader::parse(&base).unwrap();
        let rc_a = a.new_recovery(&u).unwrap();
        let rc_b = b.new_recovery(&u).unwrap();
        let (a0, b0) = (a.clone(), b.clone());
        a.merge_from(&b0, &u).unwrap();
        b.merge_from(&a0, &u).unwrap();
        // The smaller slot id wins, so both devices pick the same one.
        let winner = recovery_ids(&a0)[0].min(recovery_ids(&b0)[0]);
        assert_eq!(recovery_ids(&a), vec![winner]);
        assert_eq!(recovery_ids(&b), vec![winner]);
        assert_eq!(a.to_bytes(&u).unwrap(), b.to_bytes(&u).unwrap());
        let (win, lose) = if winner == recovery_ids(&a0)[0] {
            (&rc_a, &rc_b)
        } else {
            (&rc_b, &rc_a)
        };
        a.unlock(Unlock::Recovery(win)).unwrap();
        assert!(is_auth(a.unlock(Unlock::Recovery(lose))));
    }

    #[test]
    fn rotation_keeps_old_epoch_readable() {
        let (mut h, u, rc) = new_vault("old");
        let dev = Secret::random();
        device(&mut h, &u, "mac-1", &dev);
        let (u2, rc2) = h.begin_rotation_unchecked(&u, "new", TINY).unwrap();
        assert_eq!(u2.epoch, 2);
        assert_ne!(u2.vk.expose(), u.vk.expose());
        // Writing with the pre-rotation key would MAC the header so no slot can open it.
        assert!(matches!(h.to_bytes(&u), Err(CryptoError::Params(_))));
        assert!(matches!(h.finish_rotation(&u), Err(CryptoError::Params(_))));
        assert!(h.begin_rotation_unchecked(&u2, "x", TINY).is_err());
        let p = VaultHeader::parse(&h.to_bytes(&u2).unwrap()).unwrap();
        assert_eq!(p.epoch, 2);
        assert!(
            !p.slots
                .iter()
                .any(|s| matches!(s.kind, SlotKind::Device { .. }))
        );
        assert!(is_auth(p.unlock(Unlock::Passphrase("old"))));
        assert!(is_auth(p.unlock(Unlock::Recovery(&rc))));
        assert!(is_auth(p.unlock(Unlock::Device(&dev))));
        let r = p.unlock(Unlock::Passphrase("new")).unwrap();
        p.unlock(Unlock::Recovery(&rc2)).unwrap();
        assert_eq!(r.epoch, 2);
        assert_eq!(r.vk.expose(), u2.vk.expose());
        assert_eq!(r.retiring.as_ref().unwrap().0, 1);
        assert_eq!(
            r.content_key(1).unwrap().expose(),
            u.subkeys.content.expose()
        );
        assert_eq!(
            r.content_key(2).unwrap().expose(),
            u2.subkeys.content.expose()
        );
        assert!(r.content_key(3).is_none());
        // The old Unlocked no longer fits this header.
        let mut p = p;
        assert!(p.finish_rotation(&u).is_err());
        p.finish_rotation(&r).unwrap();
        let f = VaultHeader::parse(&p.to_bytes(&r).unwrap())
            .unwrap()
            .unlock(Unlock::Passphrase("new"))
            .unwrap();
        assert!(f.content_key(1).is_none());
        assert_eq!(
            f.content_key(2).unwrap().expose(),
            u2.subkeys.content.expose()
        );
        // The public entry point enforces the Argon2 floor.
        assert!(matches!(
            p.begin_rotation(&r, "x", TINY),
            Err(CryptoError::Params(_))
        ));
    }
}
