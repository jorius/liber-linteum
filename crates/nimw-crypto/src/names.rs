//! Encrypted file and folder names (spec §4.3).

use aes_siv::KeyInit;
use aes_siv::siv::{Aes256Siv, IV_SIZE};
use data_encoding::{BASE32_NOPAD, BASE64URL_NOPAD};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::error::{CryptoError, Result};
use crate::keys::{Secret, VaultId, random_bytes};

/// A folder's random id, stored inside its own encrypted name. The vault root is all zeros.
#[derive(Clone, Copy, Eq, PartialEq, Hash, Debug)]
pub struct FolderId(pub [u8; 16]);

impl FolderId {
    pub const ROOT: FolderId = FolderId([0; 16]);

    pub fn random() -> Self {
        Self(random_bytes())
    }
}

/// Encoded names longer than this many bytes are stored as `<hash>.nimwl` plus a side file.
pub const LONG_NAME_LIMIT: usize = 200;

/// AES-SIV-256 names bound to the vault, the key epoch and the parent folder's id.
pub struct NameCodec<'a> {
    key: &'a Secret<64>,
    vault_id: &'a VaultId,
    epoch: u32,
}

impl<'a> NameCodec<'a> {
    pub fn new(key: &'a Secret<64>, vault_id: &'a VaultId, epoch: u32) -> Self {
        Self {
            key,
            vault_id,
            epoch,
        }
    }

    /// `name` must be one valid path component; decryption rejects anything else.
    pub fn encrypt_file(&self, parent: &FolderId, name: &str) -> String {
        let name: String = name.nfc().collect();
        format!("{}{FILE_EXT}", self.seal(parent, name.as_bytes()))
    }

    pub fn decrypt_file(&self, parent: &FolderId, on_disk: &str) -> Result<String> {
        let stem = on_disk
            .strip_suffix(FILE_EXT)
            .ok_or(CryptoError::BadFormat("file name lacks .nimwe"))?;
        valid_name(self.open(parent, stem)?)
    }

    pub fn encrypt_folder(&self, parent: &FolderId, id: &FolderId, name: &str) -> String {
        let mut pt = id.0.to_vec();
        pt.extend(name.nfc().collect::<String>().bytes());
        self.seal(parent, &pt)
    }

    pub fn decrypt_folder(&self, parent: &FolderId, on_disk: &str) -> Result<(FolderId, String)> {
        let mut pt = self.open(parent, on_disk)?;
        if pt.len() < 16 {
            return Err(CryptoError::BadFormat("folder name shorter than its id"));
        }
        let name = pt.split_off(16);
        let id = FolderId(pt.try_into().expect("split at 16"));
        Ok((id, valid_name(name)?))
    }

    fn seal(&self, parent: &FolderId, plaintext: &[u8]) -> String {
        let ct = self
            .siv()
            .encrypt(self.ad(parent), plaintext)
            .expect("3 headers, any plaintext length");
        BASE64URL_NOPAD.encode(&ct)
    }

    fn open(&self, parent: &FolderId, encoded: &str) -> Result<Vec<u8>> {
        if encoded.len() > MAX_ENCODED_LEN {
            return Err(CryptoError::BadFormat("encrypted name too long"));
        }
        let ct = BASE64URL_NOPAD
            .decode(encoded.as_bytes())
            .map_err(|_| CryptoError::BadFormat("encrypted name is not Base64url"))?;
        if ct.len() < IV_SIZE {
            return Err(CryptoError::BadFormat(
                "encrypted name shorter than its tag",
            ));
        }
        self.siv()
            .decrypt(self.ad(parent), &ct)
            .map_err(|_| CryptoError::Authentication)
    }

    fn siv(&self) -> Aes256Siv {
        // By reference: the key never sits in a stack array (the cipher zeroizes its own copy).
        Aes256Siv::new_from_slice(self.key.expose()).expect("64-byte AES-SIV-256 key")
    }

    /// AD components: vault id, epoch (u32 BE), parent folder id (spec §4.3).
    fn ad(&self, parent: &FolderId) -> [Vec<u8>; 3] {
        [
            self.vault_id.0.to_vec(),
            self.epoch.to_be_bytes().to_vec(),
            parent.0.to_vec(),
        ]
    }
}

/// Room for a 255-byte name plus a folder id and tag, Base64url-encoded, with margin.
const MAX_ENCODED_LEN: usize = 1024;
const FILE_EXT: &str = ".nimwe";

/// Guards against path traversal once vaults can be shared.
fn valid_name(pt: Vec<u8>) -> Result<String> {
    let s = String::from_utf8(pt).map_err(|_| CryptoError::BadFormat("name is not UTF-8"))?;
    if s.is_empty() || s == "." || s == ".." || s.contains(['/', '\\', '\0']) {
        return Err(CryptoError::BadFormat(
            "name is not a single path component",
        ));
    }
    Ok(s)
}

/// The on-disk form of a name too long for the file system.
#[derive(Debug, PartialEq, Eq)]
pub struct ShortName {
    pub on_disk: String,
    pub side_file: String,
    /// The full encoded name; it is already ciphertext, so it gets no second layer.
    pub side_contents: String,
}

/// `Some` when `encoded` (an `encrypt_*` result) is longer than `LONG_NAME_LIMIT` bytes.
pub fn shorten(encoded: &str) -> Option<ShortName> {
    if encoded.len() <= LONG_NAME_LIMIT {
        return None;
    }
    let mut h = BASE32_NOPAD.encode(&Sha256::digest(encoded.as_bytes()));
    h.truncate(32);
    h.make_ascii_lowercase();
    Some(ShortName {
        on_disk: format!("{h}.nimwl"),
        side_file: format!("{h}.nimwn"),
        side_contents: encoded.to_string(),
    })
}

/// A sync provider's conflict copy: the name it was copied from, and the provider's label.
#[derive(Debug, PartialEq, Eq)]
pub struct ConflictName {
    pub original: String,
    pub label: String,
}

/// Recognises Dropbox, iCloud, Google Drive and Syncthing conflict suffixes, before or after
/// our extension. Suffixes start with a space or `.`, neither in Base64url or base32, so a
/// real encoded name never matches.
pub fn strip_conflict(on_disk: &str) -> Option<ConflictName> {
    let core_len = on_disk
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .filter(|&n| n > 0)?;
    let (core, rest) = on_disk.split_at(core_len);
    let (suffix, ext) = [".nimwe", ".nimwl", ".nimwn"]
        .into_iter()
        .find_map(|e| {
            rest.strip_suffix(e)
                .or_else(|| rest.strip_prefix(e))
                .map(|s| (s, e))
        })
        .unwrap_or((rest, ""));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let label = if let Some(inner) = suffix.strip_prefix(" (").and_then(|s| s.strip_suffix(')')) {
        // Dropbox ` (… conflicted copy …)` or Google Drive ` (1)`.
        (inner.contains("conflicted copy") || digits(inner)).then_some(inner)?
    } else if let Some(n) = suffix.strip_prefix(' ') {
        digits(n).then_some(n)? // iCloud ` 2`
    } else {
        // Syncthing `.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX`.
        let l = suffix.strip_prefix('.')?;
        let p: Vec<&str> = l.strip_prefix("sync-conflict-")?.split('-').collect();
        let ok = p.len() == 3
            && p[0].len() == 8
            && digits(p[0])
            && p[1].len() == 6
            && digits(p[1])
            && p[2].len() == 7
            && p[2].bytes().all(|b| b.is_ascii_alphanumeric());
        ok.then_some(l)?
    };
    Some(ConflictName {
        original: format!("{core}{ext}"),
        label: label.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Secret<64> {
        Secret::random()
    }

    #[test]
    fn file_and_folder_round_trip() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let parent = FolderId::random();
        let f = c.encrypt_file(&parent, "Notes.md");
        assert!(f.ends_with(".nimwe"), "{f}");
        assert_eq!(c.encrypt_file(&parent, "Notes.md"), f, "deterministic");
        assert_eq!(c.decrypt_file(&parent, &f).unwrap(), "Notes.md");

        let id = FolderId::random();
        let d = c.encrypt_folder(&FolderId::ROOT, &id, "Projects");
        assert!(!d.contains('.'), "{d}");
        assert_eq!(
            c.decrypt_folder(&FolderId::ROOT, &d).unwrap(),
            (id, "Projects".to_string())
        );
        // One-byte names and names of exactly one SIV block both work.
        for n in ["a", "abcdefghijklmnop", "ünïcødé 名前.md"] {
            assert_eq!(
                c.decrypt_file(&parent, &c.encrypt_file(&parent, n))
                    .unwrap(),
                n
            );
        }
    }

    #[test]
    fn same_name_different_parent_differs() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let (a, b) = (FolderId::random(), FolderId::random());
        assert_ne!(
            c.encrypt_file(&a, "Notes.md"),
            c.encrypt_file(&b, "Notes.md")
        );
        let id = FolderId::random();
        assert_ne!(
            c.encrypt_folder(&a, &id, "x"),
            c.encrypt_folder(&b, &id, "x")
        );
    }

    #[test]
    fn folder_rename_keeps_id() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let id = FolderId::random();
        let old = c.encrypt_folder(&FolderId::ROOT, &id, "Drafts");
        let new = c.encrypt_folder(&FolderId::ROOT, &id, "Archive");
        assert_ne!(old, new);
        assert_eq!(c.decrypt_folder(&FolderId::ROOT, &new).unwrap().0, id);
        assert_eq!(c.decrypt_folder(&FolderId::ROOT, &old).unwrap().0, id);
    }

    #[test]
    fn wrong_parent_or_epoch_fails() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let parent = FolderId::random();
        let f = c.encrypt_file(&parent, "Notes.md");
        let d = c.encrypt_folder(&parent, &FolderId::random(), "Sub");
        let other = FolderId::random();
        assert!(matches!(
            c.decrypt_file(&other, &f),
            Err(CryptoError::Authentication)
        ));
        assert!(matches!(
            c.decrypt_folder(&other, &d),
            Err(CryptoError::Authentication)
        ));
        let c2 = NameCodec::new(&k, &v, 2);
        assert!(matches!(
            c2.decrypt_file(&parent, &f),
            Err(CryptoError::Authentication)
        ));
        assert!(matches!(
            c2.decrypt_folder(&parent, &d),
            Err(CryptoError::Authentication)
        ));
        let v2 = VaultId::random();
        let c3 = NameCodec::new(&k, &v2, 1);
        assert!(matches!(
            c3.decrypt_file(&parent, &f),
            Err(CryptoError::Authentication)
        ));
        let k2 = key();
        let c4 = NameCodec::new(&k2, &v, 1);
        assert!(matches!(
            c4.decrypt_file(&parent, &f),
            Err(CryptoError::Authentication)
        ));
    }

    #[test]
    fn nfd_and_nfc_names_encrypt_alike() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let p = FolderId::ROOT;
        let nfc = c.encrypt_file(&p, "Canci\u{f3}n.md");
        assert_eq!(nfc, c.encrypt_file(&p, "Cancio\u{301}n.md"));
        assert_eq!(c.decrypt_file(&p, &nfc).unwrap(), "Canci\u{f3}n.md");
        let id = FolderId::random();
        assert_eq!(
            c.encrypt_folder(&p, &id, "Canci\u{f3}n"),
            c.encrypt_folder(&p, &id, "Cancio\u{301}n")
        );
    }

    #[test]
    fn long_names_shorten() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let enc = c.encrypt_file(&FolderId::ROOT, &"x".repeat(180));
        assert!(enc.len() > LONG_NAME_LIMIT, "{}", enc.len());
        let s = shorten(&enc).unwrap();
        assert_eq!(s.on_disk.len(), 32 + 6);
        assert!(s.on_disk.ends_with(".nimwl"));
        let h = &s.on_disk[..32];
        assert!(
            h.bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)),
            "{h}"
        );
        assert_eq!(s.side_file, format!("{h}.nimwn"));
        assert_eq!(s.side_contents, enc);
        assert_eq!(
            c.decrypt_file(&FolderId::ROOT, &s.side_contents).unwrap(),
            "x".repeat(180)
        );
        assert_eq!(shorten(&enc).unwrap(), s, "deterministic");
        assert!(shorten(&"a".repeat(LONG_NAME_LIMIT + 1)).is_some());
        assert!(shorten(&"a".repeat(LONG_NAME_LIMIT)).is_none());
        assert!(shorten(&c.encrypt_file(&FolderId::ROOT, "Notes.md")).is_none());
    }

    #[test]
    fn shorten_hash_known_answer() {
        // SHA-256 of 201 × 'a', base32 (RFC 4648) lower case, cut to 32 characters (Python oracle).
        let s = shorten(&"a".repeat(201)).unwrap();
        assert_eq!(s.on_disk, "vexp3aqqsnz6ld42ebln5ya6qb7cc3hg.nimwl");
    }

    #[test]
    fn conflict_suffixes() {
        let enc = "Zm9vYmFy-_Q";
        let table: &[(&str, &str, &str)] = &[
            // Dropbox
            (
                "Zm9vYmFy-_Q (Jose's conflicted copy 2026-10-20).nimwe",
                "Zm9vYmFy-_Q.nimwe",
                "Jose's conflicted copy 2026-10-20",
            ),
            (
                "Zm9vYmFy-_Q.nimwe (Jose's conflicted copy 2026-10-20)",
                "Zm9vYmFy-_Q.nimwe",
                "Jose's conflicted copy 2026-10-20",
            ),
            (
                "Zm9vYmFy-_Q (Jose's conflicted copy 2026-10-20)",
                "Zm9vYmFy-_Q",
                "Jose's conflicted copy 2026-10-20",
            ),
            // iCloud
            ("Zm9vYmFy-_Q 2.nimwe", "Zm9vYmFy-_Q.nimwe", "2"),
            ("Zm9vYmFy-_Q.nimwe 3", "Zm9vYmFy-_Q.nimwe", "3"),
            ("Zm9vYmFy-_Q 12", "Zm9vYmFy-_Q", "12"),
            // Google Drive
            ("Zm9vYmFy-_Q (1).nimwe", "Zm9vYmFy-_Q.nimwe", "1"),
            ("Zm9vYmFy-_Q.nimwe (2)", "Zm9vYmFy-_Q.nimwe", "2"),
            ("Zm9vYmFy-_Q (1)", "Zm9vYmFy-_Q", "1"),
            // Syncthing
            (
                "Zm9vYmFy-_Q.sync-conflict-20261020-101530-ABCDEFG.nimwe",
                "Zm9vYmFy-_Q.nimwe",
                "sync-conflict-20261020-101530-ABCDEFG",
            ),
            (
                "Zm9vYmFy-_Q.nimwe.sync-conflict-20261020-101530-ABCDEFG",
                "Zm9vYmFy-_Q.nimwe",
                "sync-conflict-20261020-101530-ABCDEFG",
            ),
            (
                "Zm9vYmFy-_Q.sync-conflict-20261020-101530-ABCDEFG",
                "Zm9vYmFy-_Q",
                "sync-conflict-20261020-101530-ABCDEFG",
            ),
            // A shortened long name
            (
                "abcdefghijklmnopqrstuvwxyz234567 2.nimwl",
                "abcdefghijklmnopqrstuvwxyz234567.nimwl",
                "2",
            ),
        ];
        for (on_disk, original, label) in table {
            assert_eq!(
                strip_conflict(on_disk),
                Some(ConflictName {
                    original: original.to_string(),
                    label: label.to_string()
                }),
                "{on_disk}"
            );
        }
        let none = [
            enc.to_string(),
            format!("{enc}.nimwe"),
            "abcdefghijklmnopqrstuvwxyz234567.nimwl".to_string(),
            "Notes.md".to_string(),
            format!("{enc} (copy).nimwe"),
            format!("{enc} 2a.nimwe"),
            format!("{enc} ().nimwe"),
            format!("{enc} .nimwe"),
            format!("{enc}.sync-conflict-2026102-101530-ABCDEFG.nimwe"),
            format!("{enc}.sync-conflict-20261020-101530-ABCDEF.nimwe"),
            " 2.nimwe".to_string(),
            " (1)".to_string(),
            String::new(),
            "ü 2".to_string(),
        ];
        for n in &none {
            assert_eq!(strip_conflict(n), None, "{n:?}");
        }
        // Every real encoded name is left alone.
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        for i in 0..200 {
            let n = format!("n{i}");
            assert_eq!(strip_conflict(&c.encrypt_file(&FolderId::ROOT, &n)), None);
            assert_eq!(
                strip_conflict(&c.encrypt_folder(&FolderId::ROOT, &FolderId::random(), &n)),
                None
            );
        }
    }

    #[test]
    fn rejects_traversal_names() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let p = FolderId::random();
        for bad in ["..", ".", "", "a/b", "a\\b", "a\0b", "/"] {
            let f = format!("{}.nimwe", c.seal(&p, bad.as_bytes()));
            assert!(
                matches!(c.decrypt_file(&p, &f), Err(CryptoError::BadFormat(_))),
                "{bad:?}"
            );
            let mut pt = FolderId::random().0.to_vec();
            pt.extend_from_slice(bad.as_bytes());
            let d = c.seal(&p, &pt);
            assert!(
                matches!(c.decrypt_folder(&p, &d), Err(CryptoError::BadFormat(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn hostile_on_disk_names_are_bad_format() {
        let (k, v) = (key(), VaultId::random());
        let c = NameCodec::new(&k, &v, 1);
        let p = FolderId::ROOT;
        let bad_format = |r: Result<String>| matches!(r, Err(CryptoError::BadFormat(_)));
        let bad_folder =
            |r: Result<(FolderId, String)>| matches!(r, Err(CryptoError::BadFormat(_)));
        // Invalid UTF-8 after decryption.
        assert!(bad_format(c.decrypt_file(
            &p,
            &format!("{}.nimwe", c.seal(&p, &[0xff, 0xfe]))
        )));
        // Folder plaintext shorter than a folder id.
        assert!(bad_folder(c.decrypt_folder(&p, &c.seal(&p, &[1; 15]))));
        assert!(bad_folder(c.decrypt_folder(&p, &c.seal(&p, &[]))));
        let mut pt = FolderId::random().0.to_vec();
        pt.extend_from_slice(&[0xc3]);
        assert!(bad_folder(c.decrypt_folder(&p, &c.seal(&p, &pt))));
        // Not Base64url, padded, non-canonical trailing bits, too short for a tag, too long.
        let file = c.encrypt_file(&p, "Notes.md");
        let stem = file.strip_suffix(".nimwe").unwrap();
        for s in [
            "",
            "!!!!",
            "A",
            "AAAAAAAAAAAAAAAAAAAAAA==",
            "AAAAAAAAAAAAAAAAAAAAAB",
            "AAAAAAAAAAAAAAAAAAAA",
            &"A".repeat(100_000),
        ] {
            assert!(
                bad_format(c.decrypt_file(&p, &format!("{s}.nimwe"))),
                "{s:.20}"
            );
            assert!(bad_folder(c.decrypt_folder(&p, s)), "{s:.20}");
        }
        // Missing or wrong suffix; a folder name with the file suffix.
        assert!(bad_format(c.decrypt_file(&p, stem)));
        assert!(bad_format(c.decrypt_file(&p, &format!("{stem}.nimwl"))));
        assert!(bad_folder(c.decrypt_folder(&p, &file)));
        // A flipped tag bit is an authentication failure, not a format error.
        let mut ct = data_encoding::BASE64URL_NOPAD
            .decode(stem.as_bytes())
            .unwrap();
        ct[0] ^= 1;
        let flipped = format!("{}.nimwe", data_encoding::BASE64URL_NOPAD.encode(&ct));
        assert!(matches!(
            c.decrypt_file(&p, &flipped),
            Err(CryptoError::Authentication)
        ));
    }
}
