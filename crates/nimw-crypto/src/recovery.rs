//! Recovery code: 32 random bytes shown as `NIMW-` + 13 Crockford groups + a checksum group.

use std::sync::OnceLock;

use data_encoding::{Encoding, Specification};
use sha2::{Digest, Sha256};

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
        .chain_update(b"nimw/v1/recovery-check")
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

    pub fn to_display(&self) -> String {
        let body = crockford().encode(self.0.expose()) + &checksum(self.0.expose());
        let mut out = String::from("NIMW");
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
        // The prefix letters N, I, M, W are all valid symbols or translated ones, so strip it before decoding.
        if chars.len() >= 4 && chars[..4].eq_ignore_ascii_case("NIMW") && chars.len() == 60 {
            chars.drain(..4);
        }
        if chars.len() != 56 || !chars.is_ascii() {
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
    fn recovery_display_shape() {
        let d = RecoveryCode::generate().to_display();
        assert_eq!(d.len(), 4 + 14 * 5);
        assert!(d.starts_with("NIMW"));
        for g in d[4..].split('-').skip(1) {
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
        assert!(same(d.strip_prefix("NIMW-").unwrap()));
        // Corrupt one data character.
        let mut bad = d.clone().into_bytes();
        bad[6] = if bad[6] == b'A' { b'B' } else { b'A' };
        assert!(matches!(
            RecoveryCode::parse(&String::from_utf8(bad).unwrap()),
            Err(CryptoError::RecoveryCode)
        ));
    }
}
