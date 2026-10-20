use std::fmt;

use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Sha256, Sha512};
use zeroize::Zeroize;

/// Heap-allocated secret bytes: zeroized on drop, pages locked best-effort.
pub struct Secret<const N: usize> {
    bytes: Box<[u8; N]>,
}

impl<const N: usize> Secret<N> {
    pub(crate) fn from_box(bytes: Box<[u8; N]>) -> Self {
        // shortcut: page-granular mlock, guards are leaked so shared pages stay locked; upgrade to a dedicated locked arena if many secrets are created
        // Best effort: locking can fail (rlimit), and that must not stop the vault opening.
        if let Ok(guard) = region::lock(bytes.as_ptr(), N) {
            std::mem::forget(guard);
        }
        Self { bytes }
    }

    pub fn random() -> Self {
        let mut b = Box::new([0u8; N]);
        fill_random(&mut b[..]);
        Self::from_box(b)
    }

    pub fn from_bytes(mut bytes: [u8; N]) -> Self {
        let b = Box::new(bytes);
        bytes.zeroize();
        Self::from_box(b)
    }

    pub fn expose(&self) -> &[u8; N] {
        &self.bytes
    }
}

impl<const N: usize> Drop for Secret<N> {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

impl<const N: usize> fmt::Debug for Secret<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret<{N}>(…)")
    }
}

pub type VaultKey = Secret<32>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct VaultId(pub [u8; 16]);

impl VaultId {
    pub fn random() -> Self {
        Self(random_bytes())
    }
}

/// The four per-purpose keys derived from the vault key (spec §3).
pub struct Subkeys {
    pub content: Secret<32>,
    pub name: Secret<64>,
    pub header: Secret<32>,
    pub index: Secret<32>,
}

impl Subkeys {
    pub fn derive(vk: &VaultKey, id: &VaultId) -> Subkeys {
        let hk = Hkdf::<Sha512>::new(Some(&id.0), vk.expose());
        fn expand<const N: usize>(hk: &Hkdf<Sha512>, info: &[u8]) -> Secret<N> {
            let mut b = Box::new([0u8; N]);
            hk.expand(info, &mut b[..]).expect("N <= 255 * 64");
            Secret::from_box(b)
        }
        Subkeys {
            content: expand(&hk, b"nimw/v1/content"),
            name: expand(&hk, b"nimw/v1/name"),
            header: expand(&hk, b"nimw/v1/header"),
            index: expand(&hk, b"nimw/v1/index"),
        }
    }
}

fn fill_random(buf: &mut [u8]) {
    // The OS RNG failing is unrecoverable; refusing to continue is the safe response.
    getrandom::fill(buf).expect("OS random number generator unavailable");
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    fill_random(&mut b);
    b
}

#[allow(dead_code)] // used by the key-slot and Argon2 tasks
pub(crate) fn rng() -> impl rand_core::CryptoRng {
    rand_core::UnwrapErr(getrandom::SysRng)
}

#[allow(dead_code)] // used by later tasks
pub(crate) fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8]) -> Secret<32> {
    let mut b = Box::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut b[..])
        .expect("32 <= 255 * 32");
    Secret::from_box(b)
}

#[allow(dead_code)] // used by later tasks
pub(crate) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    for p in parts {
        mac.update(p);
    }
    mac.finalize().into_bytes().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn hkdf_sha256_matches_rfc5869_case_1() {
        let salt: Vec<u8> = (0..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let okm = hkdf_sha256(&[0x0b; 22], &salt, &info);
        let want = unhex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf");
        assert_eq!(okm.expose().as_slice(), want.as_slice());
    }

    #[test]
    fn subkeys_are_distinct_and_deterministic() {
        let vk = VaultKey::random();
        let id = VaultId::random();
        let a = Subkeys::derive(&vk, &id);
        let b = Subkeys::derive(&vk, &id);
        assert_eq!(a.content.expose(), b.content.expose());
        assert_eq!(a.name.expose(), b.name.expose());
        assert_eq!(a.header.expose(), b.header.expose());
        assert_eq!(a.index.expose(), b.index.expose());
        let all: [&[u8]; 4] = [
            a.content.expose(),
            &a.name.expose()[..32],
            a.header.expose(),
            a.index.expose(),
        ];
        for i in 0..4 {
            for j in i + 1..4 {
                assert_ne!(all[i], all[j]);
            }
        }
        let c = Subkeys::derive(&vk, &VaultId::random());
        assert_ne!(a.content.expose(), c.content.expose());
    }

    #[test]
    fn many_secrets_create_and_drop_without_panic() {
        for _ in 0..1000 {
            drop(Secret::<32>::random());
        }
        let vk = VaultKey::random();
        let id = VaultId::random();
        for _ in 0..200 {
            drop(Subkeys::derive(&vk, &id));
        }
    }

    #[test]
    fn secret_debug_hides_bytes() {
        let s = format!("{:?}", Secret::<32>::from_bytes([7; 32]));
        assert!(!s.contains('7'), "{s}");
    }
}
