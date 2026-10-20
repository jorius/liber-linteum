//! Key slots: each wraps the vault key under its own KEK with AES-256-GCM (spec §3.2).

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{AeadInOut, KeyInit, Nonce};
use data_encoding::BASE64URL_NOPAD;
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

use crate::error::{CryptoError, Result};
use crate::kdf::Argon2Params;
use crate::keys::{Secret, VaultId, VaultKey, hkdf_sha256};
use crate::recovery::RecoveryCode;

/// A wrapped 32-byte key plus the GCM tag.
pub(crate) const WRAPPED_LEN: usize = 32 + 16;
/// Bound on a keyring slot's KEM ciphertext (X-Wing's is 1120 bytes).
const MAX_ENC: usize = 4096;
pub(crate) const MAX_DEVICE_ID: usize = 256;

#[derive(Clone, Debug)]
pub enum SlotKind {
    Passphrase {
        params: Argon2Params,
        salt: [u8; 32],
    },
    Recovery,
    Keyring {
        keyring_id: [u8; 16],
        enc: Vec<u8>,
    },
    Device {
        device_id: String,
    },
}

impl SlotKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            SlotKind::Passphrase { .. } => "passphrase",
            SlotKind::Recovery => "recovery",
            SlotKind::Keyring { .. } => "keyring",
            SlotKind::Device { .. } => "device",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Slot {
    pub id: [u8; 16],
    pub kind: SlotKind,
    pub(crate) nonce: [u8; 12],
    pub(crate) wrapped: Vec<u8>,
}

/// What the user offers to open the vault.
pub enum Unlock<'a> {
    Passphrase(&'a str),
    Recovery(&'a RecoveryCode),
    Device(&'a Secret<32>),
}

/// A slot to add to an unlocked vault. Recovery slots come only from `create` / `new_recovery`.
pub enum NewSlot<'a> {
    Passphrase(&'a str, Argon2Params),
    Device {
        device_id: String,
        secret: &'a Secret<32>,
    },
}

pub(crate) fn recovery_kek(rc: &RecoveryCode, id: &VaultId) -> Secret<32> {
    hkdf_sha256(rc.secret().expose(), &id.0, b"nimw/v1/slot/recovery")
}

pub(crate) fn device_kek(secret: &Secret<32>, id: &VaultId) -> Secret<32> {
    hkdf_sha256(secret.expose(), &id.0, b"nimw/v1/slot/device")
}

/// `label ‖ vault_id ‖ epoch (u32 BE) ‖ tail…`
pub(crate) fn aad(label: &[u8], id: &VaultId, epoch: u32, tail: &[&[u8]]) -> Vec<u8> {
    let mut a = [label, &id.0, &epoch.to_be_bytes()].concat();
    tail.iter().for_each(|t| a.extend_from_slice(t));
    a
}

pub(crate) fn slot_aad(id: &VaultId, epoch: u32, slot_id: &[u8; 16], kind: &SlotKind) -> Vec<u8> {
    aad(
        b"nimw/v1/slot",
        id,
        epoch,
        &[slot_id, kind.type_name().as_bytes()],
    )
}

fn cipher(kek: &Secret<32>) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(kek.expose()).expect("32-byte key")
}

/// AES-256-GCM over a 32-byte key; encrypted in place, so no plaintext copy is left behind.
pub(crate) fn wrap(kek: &Secret<32>, nonce: &[u8; 12], aad: &[u8], key: &VaultKey) -> Vec<u8> {
    let mut buf = Vec::with_capacity(WRAPPED_LEN);
    buf.extend_from_slice(key.expose());
    cipher(kek)
        .encrypt_in_place(&Nonce::<Aes256Gcm>::from(*nonce), aad, &mut buf)
        .expect("buffer has room for the tag");
    buf
}

/// Decrypts into a zeroizing buffer, then moves the key to the heap.
pub(crate) fn unwrap(
    kek: &Secret<32>,
    nonce: &[u8; 12],
    aad: &[u8],
    wrapped: &[u8],
) -> Result<VaultKey> {
    let mut buf = Zeroizing::new(wrapped.to_vec());
    cipher(kek)
        .decrypt_in_place(&Nonce::<Aes256Gcm>::from(*nonce), aad, &mut *buf)
        .map_err(|_| CryptoError::Authentication)?;
    if buf.len() != 32 {
        return Err(CryptoError::BadFormat("wrapped key length"));
    }
    let mut b = Box::new([0u8; 32]);
    b.copy_from_slice(&buf);
    Ok(Secret::from_box(b))
}

// ---- JSON: untrusted input, every length bounded ----

pub(crate) fn b64(b: &[u8]) -> Value {
    Value::String(BASE64URL_NOPAD.encode(b))
}

pub(crate) fn object<'a>(v: &'a Value, what: &'static str) -> Result<&'a Map<String, Value>> {
    v.as_object().ok_or(CryptoError::BadFormat(what))
}

pub(crate) fn field<'a>(o: &'a Map<String, Value>, k: &'static str) -> Result<&'a Value> {
    o.get(k).ok_or(CryptoError::BadFormat(k))
}

pub(crate) fn text<'a>(o: &'a Map<String, Value>, k: &'static str) -> Result<&'a str> {
    field(o, k)?.as_str().ok_or(CryptoError::BadFormat(k))
}

pub(crate) fn uint(o: &Map<String, Value>, k: &'static str) -> Result<u32> {
    let n = field(o, k)?.as_u64().ok_or(CryptoError::BadFormat(k))?;
    u32::try_from(n).map_err(|_| CryptoError::BadFormat(k))
}

/// Base64url (no padding) of at most `max` bytes. Callers bound the whole input (1 MiB).
pub(crate) fn bytes_max(o: &Map<String, Value>, k: &'static str, max: usize) -> Result<Vec<u8>> {
    let b = BASE64URL_NOPAD
        .decode(text(o, k)?.as_bytes())
        .map_err(|_| CryptoError::BadFormat(k))?;
    if b.len() > max {
        return Err(CryptoError::BadFormat(k));
    }
    Ok(b)
}

/// Exactly `N` bytes. Non-secret values only (ids, salts, nonces, MACs).
pub(crate) fn bytes<const N: usize>(o: &Map<String, Value>, k: &'static str) -> Result<[u8; N]> {
    bytes_max(o, k, N)?
        .try_into()
        .map_err(|_| CryptoError::BadFormat(k))
}

/// `None` for a slot type this version doesn't know (kept verbatim by the header).
pub(crate) fn slot_from_json(v: &Value) -> Result<Option<Slot>> {
    let o = object(v, "slot")?;
    let kind = match text(o, "type")? {
        "passphrase" => {
            let k = object(field(o, "kdf")?, "kdf")?;
            if text(k, "alg")? != "argon2id" {
                return Err(CryptoError::BadFormat("kdf alg"));
            }
            let params = Argon2Params {
                m_kib: uint(k, "m_kib")?,
                t: uint(k, "t")?,
                p: uint(k, "p")?,
            };
            params.check()?;
            SlotKind::Passphrase {
                params,
                salt: bytes(k, "salt")?,
            }
        }
        "recovery" => SlotKind::Recovery,
        "keyring" => SlotKind::Keyring {
            keyring_id: bytes(o, "keyring_id")?,
            enc: bytes_max(o, "enc", MAX_ENC)?,
        },
        "device" => {
            let d = text(o, "device_id")?;
            if d.len() > MAX_DEVICE_ID {
                return Err(CryptoError::BadFormat("device_id"));
            }
            SlotKind::Device {
                device_id: d.to_owned(),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(Slot {
        id: bytes(o, "id")?,
        kind,
        nonce: bytes(o, "nonce")?,
        wrapped: bytes::<WRAPPED_LEN>(o, "wrapped")?.to_vec(),
    }))
}

pub(crate) fn slot_to_json(s: &Slot) -> Value {
    let mut v = json!({
        "type": s.kind.type_name(),
        "id": b64(&s.id),
        "nonce": b64(&s.nonce),
        "wrapped": b64(&s.wrapped),
    });
    match &s.kind {
        SlotKind::Passphrase { params, salt } => {
            v["kdf"] = json!({
                "alg": "argon2id",
                "m_kib": params.m_kib,
                "t": params.t,
                "p": params.p,
                "salt": b64(salt),
            });
        }
        SlotKind::Recovery => {}
        SlotKind::Keyring { keyring_id, enc } => {
            v["keyring_id"] = b64(keyring_id);
            v["enc"] = b64(enc);
        }
        SlotKind::Device { device_id } => v["device_id"] = json!(device_id),
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aad_layouts_are_pinned() {
        let id = VaultId([1; 16]);
        let a = slot_aad(&id, 0x0102_0304, &[9; 16], &SlotKind::Recovery);
        let want = [
            &b"nimw/v1/slot"[..],
            &[1; 16],
            &[1, 2, 3, 4],
            &[9; 16],
            b"recovery",
        ]
        .concat();
        assert_eq!(a, want);
        let r = aad(b"nimw/v1/retiring", &id, 7, &[]);
        assert_eq!(
            r,
            [&b"nimw/v1/retiring"[..], &[1; 16], &[0, 0, 0, 7]].concat()
        );
    }

    #[test]
    fn wrap_binds_key_nonce_and_aad() {
        let (kek, vk) = (Secret::random(), Secret::random());
        let n = [3u8; 12];
        let w = wrap(&kek, &n, b"aad", &vk);
        assert_eq!(w.len(), WRAPPED_LEN);
        assert_eq!(unwrap(&kek, &n, b"aad", &w).unwrap().expose(), vk.expose());
        let auth = |r: Result<VaultKey>| matches!(r, Err(CryptoError::Authentication));
        assert!(auth(unwrap(&kek, &n, b"aaD", &w)));
        assert!(auth(unwrap(&kek, &[4; 12], b"aad", &w)));
        assert!(auth(unwrap(&Secret::random(), &n, b"aad", &w)));
        assert!(auth(unwrap(&kek, &n, b"aad", &w[..10])));
        assert!(auth(unwrap(&kek, &n, b"aad", &[])));
    }
}
