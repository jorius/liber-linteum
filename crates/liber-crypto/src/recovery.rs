//! Recovery code: 32 random bytes shown as `LIBER-` + 13 Crockford groups + a checksum group.

use std::sync::OnceLock;

use data_encoding::{Encoding, Specification};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{CryptoError, Result};
use crate::keys::Secret;

fn crockford() -> &'static Encoding {
    static ENC: OnceLock<Encoding> = OnceLock::new();
    ENC.get_or_init(|| {
        let mut spec = Specification::new();
        spec.symbols.push_str("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
        spec.translate.from.push_str("abcdefghjkmnpqrstvwxyzOoIiLl");
        spec.translate.to.push_str("ABCDEFGHJKMNPQRSTVWXYZ001111");
        spec.encoding().expect("valid Crockford spec")
    })
}

/// First 4 Crockford characters of SHA-256(domain || secret).
fn checksum(secret: &[u8; 32]) -> String {
    let h = Sha256::new()
        .chain_update(b"liber/v1/recovery-check")
        .chain_update(secret)
        .finalize();
    crockford().encode(&h[..3])[..4].to_string()
}

pub struct RecoveryCode(Secret<32>);

impl RecoveryCode {
    pub fn generate() -> Self {
        Self(Secret::random())
    }

    pub fn secret(&self) -> &Secret<32> {
        &self.0
    }

    /// The 75-character display form, wiped on drop. Buffers are pre-sized so they never
    /// reallocate and leave a copy behind.
    pub fn to_display(&self) -> Zeroizing<String> {
        let mut body = Zeroizing::new(String::with_capacity(56));
        crockford().encode_append(self.0.expose(), &mut body);
        body.push_str(&checksum(self.0.expose()));
        let mut out = Zeroizing::new(String::with_capacity(5 + 14 * 5));
        out.push_str("LIBER");
        for g in body.as_bytes().chunks(4) {
            out.push('-');
            out.push_str(std::str::from_utf8(g).expect("ascii"));
        }
        out
    }

    pub fn parse(s: &str) -> Result<Self> {
        let mut chars: String = s
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect();
        // The prefix letters L, I, B, E, R are all valid symbols or translated ones, so strip it before decoding.
        if !chars.is_ascii() {
            return Err(CryptoError::RecoveryCode);
        }
        if chars.len() == 61 && chars[..5].eq_ignore_ascii_case("LIBER") {
            chars.drain(..5);
        }
        if chars.len() != 56 {
            return Err(CryptoError::RecoveryCode);
        }
        let mut b = Box::new([0u8; 32]);
        let enc = crockford();
        if enc.decode_len(52).ok() != Some(32)
            || enc.decode_mut(&chars.as_bytes()[..52], &mut b[..]).is_err()
        {
            return Err(CryptoError::RecoveryCode);
        }
        // Compare the user's checksum group, normalised through the same alphabet.
        let want = checksum(&b);
        let got = chars[52..]
            .to_ascii_uppercase()
            .replace(['O'], "0")
            .replace(['I', 'L'], "1");
        if got != want {
            return Err(CryptoError::RecoveryCode);
        }
        Ok(Self(Secret::from_box(b)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_round_trips() {
        let c = RecoveryCode::generate();
        let p = RecoveryCode::parse(&c.to_display()).unwrap();
        assert_eq!(c.secret().expose(), p.secret().expose());
    }

    #[test]
    fn recovery_parse_rejects_non_ascii_without_panic() {
        let tail = "0".repeat(56);
        for bad in [
            format!("LIB\u{e9}{tail}"),
            format!("L\u{1f600}{tail}"),
            "\u{e9}".repeat(61),
        ] {
            assert!(matches!(
                RecoveryCode::parse(&bad),
                Err(CryptoError::RecoveryCode)
            ));
        }
    }

    #[test]
    fn recovery_display_shape() {
        let d: Zeroizing<String> = RecoveryCode::generate().to_display();
        assert_eq!(d.len(), 5 + 14 * 5);
        assert!(d.starts_with("LIBER"));
        for g in d[5..].split('-').skip(1) {
            assert_eq!(g.len(), 4);
            assert!(
                g.chars()
                    .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c))
            );
        }
        assert_eq!(d.matches('-').count(), 14);
    }

    #[test]
    fn recovery_parse_is_forgiving_and_checksummed() {
        let c = RecoveryCode::generate();
        let d = c.to_display();
        let same =
            |s: &str| RecoveryCode::parse(s).unwrap().secret().expose() == c.secret().expose();
        assert!(same(&d.to_lowercase()));
        assert!(same(&d.replace('-', " ")));
        assert!(same(&d.replace('0', "o").replace('1', "i")));
        assert!(same(&d.replace('1', "l")));
        assert!(same(d.strip_prefix("LIBER-").unwrap()));
        // Corrupt one data character.
        let mut bad = d.as_bytes().to_vec();
        bad[6] = if bad[6] == b'A' { b'B' } else { b'A' };
        assert!(matches!(
            RecoveryCode::parse(&String::from_utf8(bad).unwrap()),
            Err(CryptoError::RecoveryCode)
        ));
    }
}
