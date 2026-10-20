//! Argon2id passphrase KEK and parameter calibration.

use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use unicode_normalization::UnicodeNormalization;

use crate::error::{CryptoError, Result};
use crate::keys::Secret;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Argon2Params {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Argon2Params {
    pub const DEFAULT: Self = Self {
        m_kib: 262_144,
        t: 3,
        p: 4,
    };
    pub const FLOOR: Self = Self {
        m_kib: 65_536,
        t: 3,
        p: 4,
    };
    pub const MAX_M_KIB: u32 = 1_048_576;
    pub const MAX_T: u32 = 32;
    pub const MAX_P: u32 = 16;

    /// Sanity bounds for parsed (untrusted) parameters.
    pub fn check(&self) -> Result<()> {
        if self.m_kib > Self::MAX_M_KIB || self.t > Self::MAX_T || self.p > Self::MAX_P {
            return Err(CryptoError::Params("argon2 parameter above cap"));
        }
        if self.t == 0 || self.p == 0 {
            return Err(CryptoError::Params("argon2 parameter is zero"));
        }
        Ok(())
    }

    /// Creation-time check: bounds plus the security floor.
    pub fn check_floor(&self) -> Result<()> {
        self.check()?;
        if self.m_kib < Self::FLOOR.m_kib || self.t < Self::FLOOR.t {
            return Err(CryptoError::Params("argon2 parameters below floor"));
        }
        Ok(())
    }

    /// Halve memory while a run exceeds 2 s (not below the floor), then raise t until a run takes 0.5 s.
    pub fn calibrate_with(mut measure: impl FnMut(&Argon2Params) -> Duration) -> Self {
        let mut p = Self::DEFAULT;
        while measure(&p) > Duration::from_secs(2) && p.m_kib > Self::FLOOR.m_kib {
            p.m_kib = (p.m_kib / 2).max(Self::FLOOR.m_kib);
        }
        while measure(&p) < Duration::from_millis(500) && p.t < Self::MAX_T {
            p.t += 1;
        }
        p
    }

    pub fn calibrate() -> Self {
        Self::calibrate_with(|p| {
            let start = Instant::now();
            let _ = passphrase_kek("calibration", &[0u8; 32], p);
            start.elapsed()
        })
    }
}

/// Argon2id over the NFC-normalised passphrase (never trimmed), straight into a heap buffer.
pub fn passphrase_kek(passphrase: &str, salt: &[u8; 32], p: &Argon2Params) -> Result<Secret<32>> {
    p.check()?;
    let params = Params::new(p.m_kib, p.t, p.p, Some(32))
        .map_err(|_| CryptoError::Params("argon2 parameters rejected"))?;
    // Pre-sized so the buffer never reallocates (which would leave unzeroized copies); wiped on
    // drop. NFC output is at most 3× its input (UAX #15 stability bound).
    let mut pw = String::with_capacity(3 * passphrase.len() + 16);
    pw.extend(passphrase.nfc());
    let pw = zeroize::Zeroizing::new(pw);
    let mut b = Box::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pw.as_bytes(), salt, &mut b[..])
        .map_err(|_| CryptoError::Params("argon2 failed"))?;
    Ok(Secret::from_box(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_rules() {
        let fast = Argon2Params::calibrate_with(|_| Duration::from_millis(100));
        assert_eq!(fast.t, Argon2Params::MAX_T);
        assert_eq!(fast.m_kib, Argon2Params::DEFAULT.m_kib);
        fast.check_floor().unwrap();
        // t rises only until the measurement reaches 0.5 s.
        let mut t_seen = 0;
        let mid = Argon2Params::calibrate_with(|p| {
            t_seen = p.t;
            Duration::from_millis(if p.t >= 5 { 500 } else { 100 })
        });
        assert_eq!(mid.t, 5);
        assert_eq!(t_seen, 5);
        let slow = Argon2Params::calibrate_with(|_| Duration::from_secs(5));
        assert_eq!(slow.m_kib, Argon2Params::FLOOR.m_kib);
        slow.check_floor().unwrap();
    }

    #[test]
    fn params_caps() {
        let p = Argon2Params {
            m_kib: 64 * 1024 * 1024,
            t: 3,
            p: 4,
        };
        assert!(matches!(p.check(), Err(CryptoError::Params(_))));
        let d = Argon2Params::DEFAULT;
        assert!(
            Argon2Params {
                m_kib: 1_048_577,
                ..d
            }
            .check()
            .is_err()
        );
        assert!(
            Argon2Params {
                m_kib: 1_048_576,
                ..d
            }
            .check()
            .is_ok()
        );
        assert!(Argon2Params { t: 0, ..d }.check().is_err());
        assert!(Argon2Params { t: 33, ..d }.check().is_err());
        assert!(Argon2Params { p: 0, ..d }.check().is_err());
        assert!(Argon2Params { p: 17, ..d }.check().is_err());
        let s = [0u8; 32];
        assert!(
            passphrase_kek(
                "x",
                &s,
                &Argon2Params {
                    m_kib: 8,
                    t: 1,
                    p: 0
                }
            )
            .is_err()
        );
        assert!(
            passphrase_kek(
                "x",
                &s,
                &Argon2Params {
                    m_kib: 1_048_577,
                    ..d
                }
            )
            .is_err()
        );
        assert!(
            Argon2Params {
                m_kib: 8,
                t: 1,
                p: 1
            }
            .check_floor()
            .is_err()
        );
    }

    #[test]
    fn passphrase_is_nfc_normalised_not_trimmed() {
        let tiny = Argon2Params {
            m_kib: 8,
            t: 1,
            p: 1,
        };
        let s = [7u8; 32];
        let k = |pw: &str| passphrase_kek(pw, &s, &tiny).unwrap();
        assert_eq!(k("caf\u{e9}").expose(), k("cafe\u{301}").expose());
        assert_ne!(k(" pass").expose(), k("pass").expose());
    }
}
