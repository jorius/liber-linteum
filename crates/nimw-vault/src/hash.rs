use std::fmt;

/// BLAKE3 content hash used for compare-and-swap writes and rename detection.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hash([u8; 32]);

impl Hash {
    pub fn of(bytes: &[u8]) -> Hash {
        Hash(*blake3::hash(bytes).as_bytes())
    }

    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn from_hex(s: &str) -> Option<Hash> {
        if s.len() != 64 || !s.is_ascii() {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(Hash(out))
    }
}

impl fmt::Debug for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hash({})", &self.to_hex()[..12])
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::Hash;

    #[test]
    fn hash_is_blake3_and_round_trips_hex() {
        let h = Hash::of(b"hello");
        assert_eq!(
            h.to_hex(),
            "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f"
        );
        assert_eq!(Hash::from_hex(&h.to_hex()), Some(h));
        assert_ne!(Hash::of(b"hello"), Hash::of(b"hello!"));
    }

    #[test]
    fn from_hex_rejects_bad_input() {
        assert_eq!(Hash::from_hex("abc"), None);
        assert_eq!(Hash::from_hex(&"zz".repeat(32)), None);
        assert_eq!(Hash::from_hex(&"é".repeat(32)), None);
    }
}
