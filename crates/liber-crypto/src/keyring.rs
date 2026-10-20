//! The keyring (spec §3.3): an app-level X-Wing (X25519 + ML-KEM-768) identity. Its public key
//! can be given a slot in any vault without unlocking it; its secret opens those slots. Public-key
//! wrapping is unauthenticated, so the keyring also keeps commitments to the vaults the user
//! enrolled, and the app opens a vault silently only if it is enrolled (§15 flaw 5).
//!
//! The file `keyring.liberk` uses the vault header's canonical-JSON MAC, under a key derived from
//! the keyring seed. Unknown slot types are refused: a new keyring slot type needs a new version.

use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use x_wing::{
    DecapsulationKey, Decapsulator, ENCAPSULATION_KEY_SIZE, EncapsulationKey, Key, KeyExport,
    KeyInit, TryKeyInit,
};

use crate::error::{CryptoError, Result};
use crate::header::{MAX_PASSPHRASE_SLOTS, MAX_SLOTS, check_mac, mac_over, passphrase_count};
use crate::kdf::{Argon2Params, passphrase_kek};
use crate::keys::{Secret, VaultId, hkdf_sha256, hmac_sha256, random_bytes};
use crate::recovery::RecoveryCode;
use crate::slots::{
    Slot, SlotKind, Unlock, b64, bytes, field, object, slot_from_json, slot_to_json, text, unwrap,
    wrap,
};

const FORMAT: &str = "liber-keyring";
const VERSION: u64 = 1;
const MAX_FILE_BYTES: usize = 1 << 20;
/// About 90 bytes of JSON each, so the cap keeps the file well under `MAX_FILE_BYTES`.
const MAX_ENROLLED: usize = 4096;

/// What a vault needs to add a keyring slot. Not secret.
#[derive(Clone, Debug)]
pub struct KeyringPublic {
    pub keyring_id: [u8; 16],
    pub ek: EncapsulationKey,
}

/// An unlocked keyring. The X-Wing decapsulation key is derived from `seed` on each use.
pub struct KeyringSecret {
    pub(crate) keyring_id: [u8; 16],
    seed: Secret<32>,
    mac_key: Secret<32>,
    commit_key: Secret<32>,
}

impl KeyringSecret {
    fn new(keyring_id: [u8; 16], seed: Secret<32>) -> Self {
        Self {
            mac_key: hkdf_sha256(seed.expose(), &keyring_id, b"liber/v1/keyring/mac"),
            commit_key: hkdf_sha256(seed.expose(), &keyring_id, b"liber/v1/keyring/commit"),
            keyring_id,
            seed,
        }
    }

    /// Built from a reference to the heap seed. x-wing keeps its own copy of the seed inline
    /// (zeroized on drop by its `zeroize` feature); a move of the returned value may leave a stack copy.
    pub(crate) fn decapsulation_key(&self) -> DecapsulationKey {
        DecapsulationKey::new(<&Key<DecapsulationKey>>::from(self.seed.expose()))
    }

    fn commit(&self, vault_id: &VaultId, k_header: &Secret<32>) -> [u8; 32] {
        hmac_sha256(self.commit_key.expose(), &[&vault_id.0, k_header.expose()])
    }
}

#[derive(Clone, Debug)]
pub struct KeyringFile {
    public: KeyringPublic,
    slots: Vec<Slot>,
    /// `(vault_id, HMAC(commit_key, vault_id ‖ K_header))`, sorted by vault id.
    enrolled: Vec<([u8; 16], [u8; 32])>,
    /// Kept valid by every method that takes a `KeyringSecret`.
    mac: [u8; 32],
}

impl KeyringFile {
    /// A new keyring with a passphrase slot and a recovery slot. `params` must meet the floor.
    pub fn create(
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(KeyringFile, KeyringSecret, RecoveryCode)> {
        params.check_floor()?;
        Self::create_unchecked(passphrase, params)
    }

    /// `create` without the Argon2 floor (tests and vectors use tiny parameters).
    pub(crate) fn create_unchecked(
        passphrase: &str,
        params: Argon2Params,
    ) -> Result<(KeyringFile, KeyringSecret, RecoveryCode)> {
        let keyring_id = random_bytes();
        let s = KeyringSecret::new(keyring_id, Secret::random());
        let ek = s.decapsulation_key().encapsulation_key().clone();
        let mut f = KeyringFile {
            public: KeyringPublic { keyring_id, ek },
            slots: Vec::new(),
            enrolled: Vec::new(),
            mac: [0; 32],
        };
        let salt = random_bytes();
        let kek = passphrase_kek(passphrase, &salt, &params)?;
        f.push(SlotKind::Passphrase { params, salt }, &kek, &s);
        let rc = RecoveryCode::generate();
        f.push(SlotKind::Recovery, &recovery_kek(&rc, &keyring_id), &s);
        f.seal(&s);
        Ok((f, s, rc))
    }

    /// Checks format, version, the public key and every length. The MAC is checked by `unlock`.
    pub fn parse(input: &[u8]) -> Result<KeyringFile> {
        if input.len() > MAX_FILE_BYTES {
            return Err(CryptoError::BadFormat("keyring too large"));
        }
        let v: Value = serde_json::from_slice(input)?;
        let o = object(&v, "keyring")?;
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
        let ek = bytes::<ENCAPSULATION_KEY_SIZE>(o, "public")?;
        let ek = EncapsulationKey::new(<&Key<EncapsulationKey>>::from(&ek))
            .map_err(|_| CryptoError::BadFormat("public"))?;

        let list = field(o, "slots")?
            .as_array()
            .ok_or(CryptoError::BadFormat("slots"))?;
        if list.len() > MAX_SLOTS {
            return Err(CryptoError::BadFormat("too many slots"));
        }
        let mut slots: Vec<Slot> = Vec::new();
        for s in list {
            let slot = slot_from_json(s)?.ok_or(CryptoError::BadFormat("unknown slot type"))?;
            if matches!(slot.kind, SlotKind::Keyring { .. }) {
                return Err(CryptoError::BadFormat("keyring slot in a keyring"));
            }
            if slots.iter().any(|k| k.id == slot.id) {
                return Err(CryptoError::BadFormat("duplicate slot id"));
            }
            slots.push(slot);
        }
        if passphrase_count(&slots) > MAX_PASSPHRASE_SLOTS {
            return Err(CryptoError::BadFormat("too many passphrase slots"));
        }

        let list = field(o, "enrolled")?
            .as_array()
            .ok_or(CryptoError::BadFormat("enrolled"))?;
        if list.len() > MAX_ENROLLED {
            return Err(CryptoError::BadFormat("too many enrolled vaults"));
        }
        let mut enrolled = list
            .iter()
            .map(|e| {
                let e = object(e, "enrolled")?;
                Ok((bytes(e, "vault_id")?, bytes(e, "commit")?))
            })
            .collect::<Result<Vec<_>>>()?;
        enrolled.sort_unstable_by_key(|e| e.0);
        if enrolled.windows(2).any(|w| w[0].0 == w[1].0) {
            return Err(CryptoError::BadFormat("duplicate enrolled vault"));
        }

        Ok(KeyringFile {
            public: KeyringPublic {
                keyring_id: bytes(o, "keyring_id")?,
                ek,
            },
            slots,
            enrolled,
            mac: bytes(o, "mac")?,
        })
    }

    /// Opens the first matching slot, then verifies the file MAC.
    pub fn unlock(&self, with: Unlock) -> Result<KeyringSecret> {
        let kid = &self.public.keyring_id;
        for s in &self.slots {
            let kek = match (&s.kind, &with) {
                (SlotKind::Passphrase { params, salt }, Unlock::Passphrase(pw)) => {
                    passphrase_kek(pw, salt, params)?
                }
                (SlotKind::Recovery, Unlock::Recovery(rc)) => recovery_kek(rc, kid),
                (SlotKind::Device { .. }, Unlock::Device(d)) => {
                    hkdf_sha256(d.expose(), kid, b"liber/v1/keyring-slot/device")
                }
                _ => continue,
            };
            let Ok(seed) = unwrap(&kek, &s.nonce, &slot_aad(kid, &s.id, &s.kind), &s.wrapped)
            else {
                continue;
            };
            let ks = KeyringSecret::new(*kid, seed);
            check_mac(&self.to_json(), &ks.mac_key, &self.mac)?;
            return Ok(ks);
        }
        Err(CryptoError::Authentication)
    }

    pub fn public(&self) -> KeyringPublic {
        self.public.clone()
    }

    /// Refuses a secret from another keyring, or a file this secret didn't write (whose public
    /// key could be an attacker's).
    pub fn to_bytes(&self, s: &KeyringSecret) -> Result<Vec<u8>> {
        self.check_secret(s)?;
        let mut v = self.to_json();
        v["mac"] = b64(&self.mac);
        Ok(serde_json::to_vec(&v).expect("a Value always serialises"))
    }

    /// Records that `vault_id` with this `K_header` is the user's (again, after a key rotation).
    pub fn enroll(
        &mut self,
        s: &KeyringSecret,
        vault_id: &VaultId,
        k_header: &Secret<32>,
    ) -> Result<()> {
        self.check_secret(s)?;
        let commit = s.commit(vault_id, k_header);
        match self.enrolled.binary_search_by_key(&vault_id.0, |e| e.0) {
            Ok(i) => self.enrolled[i].1 = commit,
            Err(_) if self.enrolled.len() >= MAX_ENROLLED => {
                return Err(CryptoError::Params("too many enrolled vaults"));
            }
            Err(i) => self.enrolled.insert(i, (vault_id.0, commit)),
        }
        self.seal(s);
        Ok(())
    }

    /// Whether the app may open this vault silently: its K_header matches the enrolled commitment.
    pub fn is_enrolled(
        &self,
        s: &KeyringSecret,
        vault_id: &VaultId,
        k_header: &Secret<32>,
    ) -> bool {
        self.check_secret(s).is_ok()
            && self
                .enrolled
                .binary_search_by_key(&vault_id.0, |e| e.0)
                .is_ok_and(|i| bool::from(s.commit(vault_id, k_header).ct_eq(&self.enrolled[i].1)))
    }

    fn check_secret(&self, s: &KeyringSecret) -> Result<()> {
        if s.keyring_id != self.public.keyring_id {
            return Err(CryptoError::Params("secret is for another keyring"));
        }
        check_mac(&self.to_json(), &s.mac_key, &self.mac)
    }

    fn push(&mut self, kind: SlotKind, kek: &Secret<32>, s: &KeyringSecret) {
        let id = random_bytes();
        let nonce = random_bytes();
        let aad = slot_aad(&self.public.keyring_id, &id, &kind);
        let wrapped = wrap(kek, &nonce, &aad, &s.seed);
        self.slots.push(Slot {
            id,
            kind,
            nonce,
            wrapped,
        });
    }

    /// The file without `"mac"`.
    fn to_json(&self) -> Value {
        json!({
            "format": FORMAT,
            "version": VERSION,
            "keyring_id": b64(&self.public.keyring_id),
            "public": b64(&self.public.ek.to_bytes()),
            "slots": self.slots.iter().map(slot_to_json).collect::<Vec<_>>(),
            "enrolled": self.enrolled.iter().map(|(v, c)| json!({
                "vault_id": b64(v),
                "commit": b64(c),
            })).collect::<Vec<_>>(),
        })
    }

    fn seal(&mut self, s: &KeyringSecret) {
        self.mac = mac_over(&self.to_json(), &s.mac_key);
    }
}

fn recovery_kek(rc: &RecoveryCode, keyring_id: &[u8; 16]) -> Secret<32> {
    hkdf_sha256(
        rc.secret().expose(),
        keyring_id,
        b"liber/v1/keyring-slot/recovery",
    )
}

/// `"liber/v1/keyring-slot" ‖ keyring_id ‖ slot id ‖ type`
fn slot_aad(keyring_id: &[u8; 16], slot_id: &[u8; 16], kind: &SlotKind) -> Vec<u8> {
    [
        &b"liber/v1/keyring-slot"[..],
        keyring_id,
        slot_id,
        kind.type_name().as_bytes(),
    ]
    .concat()
}

#[cfg(test)]
mod tests {
    use data_encoding::BASE64URL_NOPAD;
    use serde_json::{Value, json};

    use super::*;
    use crate::header::VaultHeader;
    use crate::keys::with_seeded_rng;
    use crate::slots::{NewSlot, Unlock};

    const TINY: Argon2Params = Argon2Params {
        m_kib: 8,
        t: 1,
        p: 1,
    };

    fn new_keyring(pw: &str) -> (KeyringFile, KeyringSecret, RecoveryCode) {
        KeyringFile::create_unchecked(pw, TINY).unwrap()
    }

    fn is_auth<T>(r: Result<T>) -> bool {
        matches!(r, Err(CryptoError::Authentication))
    }

    fn is_format<T>(r: Result<T>) -> bool {
        matches!(r, Err(CryptoError::BadFormat(_)))
    }

    #[test]
    fn keyring_slot_opens_vault() {
        let (kf, ks, _) = new_keyring("keyring pw");
        let (mut h, u, _) = VaultHeader::create_unchecked("vault pw", TINY).unwrap();
        // Only the public half: the keyring stays locked.
        let public = KeyringFile::parse(&kf.to_bytes(&ks).unwrap())
            .unwrap()
            .public();
        h.add_slot(&u, NewSlot::Keyring(&public)).unwrap();
        let h = VaultHeader::parse(&h.to_bytes(&u).unwrap()).unwrap();
        let got = h.unlock(Unlock::Keyring(&ks)).unwrap();
        assert_eq!(got.vk.expose(), u.vk.expose());
        assert_eq!(got.subkeys.header.expose(), u.subkeys.header.expose());
        // Another keyring's secret opens nothing.
        let (_, other, _) = new_keyring("keyring pw");
        assert!(is_auth(h.unlock(Unlock::Keyring(&other))));
        // At most one slot per keyring (spec §3.2).
        let mut h2 = h.clone();
        assert!(matches!(
            h2.add_slot(&u, NewSlot::Keyring(&public)),
            Err(CryptoError::Params(_))
        ));
    }

    #[test]
    fn enrolled_only() {
        let (mut kf, ks, _) = new_keyring("keyring pw");
        let public = kf.public();
        let (mut real, ru, _) = VaultHeader::create_unchecked("vault pw", TINY).unwrap();
        real.add_slot(&ru, NewSlot::Keyring(&public)).unwrap();
        // The attacker has only the public key and plants a look-alike vault with a VK they know.
        let (mut fake, fu, _) = VaultHeader::create_unchecked("attacker", TINY).unwrap();
        fake.add_slot(&fu, NewSlot::Keyring(&public)).unwrap();
        let fake_open = fake.unlock(Unlock::Keyring(&ks)).unwrap();
        assert_eq!(fake_open.vk.expose(), fu.vk.expose());
        let real_open = real.unlock(Unlock::Keyring(&ks)).unwrap();

        let enrolled = |kf: &KeyringFile, h: &VaultHeader, u: &crate::Unlocked| {
            kf.is_enrolled(&ks, &h.vault_id, &u.subkeys.header)
        };
        assert!(!enrolled(&kf, &fake, &fake_open));
        assert!(!enrolled(&kf, &real, &real_open));
        kf.enroll(&ks, &real.vault_id, &real_open.subkeys.header)
            .unwrap();
        assert!(enrolled(&kf, &real, &real_open));
        assert!(!enrolled(&kf, &fake, &fake_open));
        // Copying the real vault_id doesn't help: the commitment binds K_header.
        assert!(!kf.is_enrolled(&ks, &real.vault_id, &fake_open.subkeys.header));
        // Survives the file round trip.
        let kf = KeyringFile::parse(&kf.to_bytes(&ks).unwrap()).unwrap();
        let ks = kf.unlock(Unlock::Passphrase("keyring pw")).unwrap();
        assert!(kf.is_enrolled(&ks, &real.vault_id, &real_open.subkeys.header));
    }

    #[test]
    fn keyring_file_round_trips_and_mac_checked() {
        let (mut kf, ks, rc) = new_keyring("keyring pw");
        kf.enroll(&ks, &VaultId([5; 16]), &Secret::from_bytes([6; 32]))
            .unwrap();
        let bytes = kf.to_bytes(&ks).unwrap();
        let back = KeyringFile::parse(&bytes).unwrap();
        assert_eq!(back.to_bytes(&ks).unwrap(), bytes);
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["format"], "liber-keyring");
        assert_eq!(v["version"], 1);
        assert_eq!(serde_json::to_vec(&v).unwrap(), bytes, "canonical");
        let types: Vec<&str> = v["slots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["type"].as_str().unwrap())
            .collect();
        assert_eq!(types, ["passphrase", "recovery"]);

        for with in [Unlock::Passphrase("keyring pw"), Unlock::Recovery(&rc)] {
            let s = back.unlock(with).unwrap();
            assert_eq!(s.seed.expose(), ks.seed.expose());
            assert_eq!(s.keyring_id, ks.keyring_id);
        }
        assert!(is_auth(back.unlock(Unlock::Passphrase("wrong"))));
        assert!(is_auth(back.unlock(Unlock::Device(&Secret::random()))));

        // Flip one bit of an enrolled commitment: the MAC refuses the file.
        let mut t = v.clone();
        let c = t["enrolled"][0]["commit"].as_str().unwrap().to_owned();
        let mut c = BASE64URL_NOPAD.decode(c.as_bytes()).unwrap();
        c[0] ^= 1;
        t["enrolled"][0]["commit"] = json!(BASE64URL_NOPAD.encode(&c));
        let t = KeyringFile::parse(&serde_json::to_vec(&t).unwrap()).unwrap();
        assert!(is_auth(t.unlock(Unlock::Passphrase("keyring pw"))));
        // Dropping the enrolment is caught too.
        let mut t = v.clone();
        t["enrolled"] = json!([]);
        let t = KeyringFile::parse(&serde_json::to_vec(&t).unwrap()).unwrap();
        assert!(is_auth(t.unlock(Unlock::Passphrase("keyring pw"))));
    }

    #[test]
    fn mismatched_secret_is_refused() {
        let (mut kf, _, _) = new_keyring("a");
        let (_, other, _) = new_keyring("b");
        let k = Secret::from_bytes([1; 32]);
        assert!(kf.to_bytes(&other).is_err());
        assert!(kf.enroll(&other, &VaultId([1; 16]), &k).is_err());
        assert!(!kf.is_enrolled(&other, &VaultId([1; 16]), &k));

        // A file with this keyring's id but an attacker's public key: never re-MAC'd by the real secret.
        let (kf, ks, _) = new_keyring("a");
        let mut v: Value = serde_json::from_slice(&kf.to_bytes(&ks).unwrap()).unwrap();
        let (theirs, their_s, _) = new_keyring("x");
        let their_v: Value = serde_json::from_slice(&theirs.to_bytes(&their_s).unwrap()).unwrap();
        v["public"] = their_v["public"].clone();
        let mut forged = KeyringFile::parse(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(is_auth(forged.to_bytes(&ks)));
        assert!(is_auth(forged.enroll(&ks, &VaultId([1; 16]), &k)));
        assert!(is_auth(forged.unlock(Unlock::Passphrase("a"))));
    }

    #[test]
    fn seeded_rng_makes_keyring_and_slot_deterministic() {
        let run = |seed| {
            with_seeded_rng(seed, || {
                let (kf, ks, rc) = new_keyring("pw");
                let (mut h, u, _) = VaultHeader::create_unchecked("vault", TINY).unwrap();
                h.add_slot(&u, NewSlot::Keyring(&kf.public())).unwrap();
                (
                    kf.to_bytes(&ks).unwrap(),
                    h.to_bytes(&u).unwrap(),
                    rc.to_display(),
                )
            })
        };
        assert_eq!(run(7), run(7));
        assert_ne!(run(7).0, run(8).0);
    }

    #[test]
    fn hostile_keyring_files_fail_cleanly() {
        let (mut kf, ks, _) = new_keyring("pw");
        kf.enroll(&ks, &VaultId([5; 16]), &Secret::from_bytes([6; 32]))
            .unwrap();
        let good: Value = serde_json::from_slice(&kf.to_bytes(&ks).unwrap()).unwrap();
        let edit = |f: &dyn Fn(&mut Value)| {
            let mut v = good.clone();
            f(&mut v);
            KeyringFile::parse(&serde_json::to_vec(&v).unwrap())
        };
        let b64 = |n: usize| json!(BASE64URL_NOPAD.encode(&vec![0u8; n]));
        assert!(matches!(
            edit(&|v| v["version"] = json!(2)),
            Err(CryptoError::UnsupportedVersion(2))
        ));
        assert!(is_format(edit(&|v| v["format"] = json!("liber-vault"))));
        assert!(is_format(edit(&|v| v["public"] = b64(1215))));
        assert!(is_format(edit(&|v| v["public"] = b64(1217))));
        assert!(is_format(edit(&|v| v["keyring_id"] = b64(15))));
        assert!(is_format(edit(&|v| v["enrolled"][0]["commit"] = b64(31))));
        assert!(is_format(edit(&|v| v["enrolled"] = json!({}))));
        assert!(is_format(edit(&|v| {
            let e = v["enrolled"][0].clone();
            v["enrolled"].as_array_mut().unwrap().push(e);
        })));
        assert!(is_format(edit(&|v| {
            let s = v["slots"][0].clone();
            v["slots"].as_array_mut().unwrap().push(s);
        })));
        assert!(is_format(edit(&|v| v["slots"][0]["type"] = json!("later"))));
        assert!(is_format(edit(&|v| {
            v["slots"][1]["type"] = json!("keyring");
            v["slots"][1]["keyring_id"] = b64(16);
            v["slots"][1]["enc"] = b64(1120);
        })));
        assert!(is_format(edit(&|v| {
            let s = v["slots"][1].clone();
            let list = v["slots"].as_array_mut().unwrap();
            for i in 0..MAX_SLOTS {
                let mut s = s.clone();
                s["id"] = json!(BASE64URL_NOPAD.encode(&(i as u128).to_be_bytes()));
                list.push(s);
            }
        })));
        let too_many = || {
            let e = &good["enrolled"][0];
            (0..=MAX_ENROLLED as u128)
                .map(|i| {
                    let mut e = e.clone();
                    e["vault_id"] = json!(BASE64URL_NOPAD.encode(&i.to_be_bytes()));
                    e
                })
                .collect::<Vec<_>>()
        };
        assert!(is_format(edit(&|v| v["enrolled"] = json!(too_many()))));
        assert!(is_format(KeyringFile::parse(&vec![
            b' ';
            MAX_FILE_BYTES + 1
        ])));
        assert!(KeyringFile::parse(b"\xff").is_err());
        assert!(KeyringFile::parse(b"[]").is_err());
    }

    #[test]
    fn vault_keyring_slot_ciphertext_length_is_exact() {
        let (kf, _, _) = new_keyring("pw");
        let (mut h, u, _) = VaultHeader::create_unchecked("vault", TINY).unwrap();
        h.add_slot(&u, NewSlot::Keyring(&kf.public())).unwrap();
        let mut v: Value = serde_json::from_slice(&h.to_bytes(&u).unwrap()).unwrap();
        let i = v["slots"]
            .as_array()
            .unwrap()
            .iter()
            .position(|s| s["type"] == "keyring")
            .unwrap();
        for n in [0, 1119, 1121] {
            v["slots"][i]["enc"] = json!(BASE64URL_NOPAD.encode(&vec![0u8; n]));
            assert!(is_format(VaultHeader::parse(
                &serde_json::to_vec(&v).unwrap()
            )));
        }
    }
}
