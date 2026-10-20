//! Panic-only entry points shared by the cargo-fuzz targets and `tests/fuzz_smoke.rs`.
//!
//! Each takes arbitrary bytes, runs the real parser or reader under fixed, public test keys
//! and drops the `Result`; a panic is the only failure. The keys are the Task 7 vector
//! device secret and constants, so no vault secret is reachable and nothing here is
//! deterministic-RNG or key-injection API: callers can only pass bytes in.

use std::io::{Cursor, Read, Seek, SeekFrom, Write};

use data_encoding::HEXLOWER;

use crate::{
    FolderId, KeyringFile, NameCodec, Secret, StreamReader, StreamWriter, Unlock, VaultHeader,
    VaultId, header_epoch, salvage, shorten, strip_conflict,
};

/// The device secret of the frozen v1 vectors, so mutated vectors get past slot lookup.
fn device() -> Secret<32> {
    let hex = "f8bd4884a75a6c952ad123d3169ae8f9e8964da5d268b5b33d24a39bfdbe5954";
    Secret::from_bytes(HEXLOWER.decode(hex.as_bytes()).unwrap().try_into().unwrap())
}

/// Vault header JSON: parse, then try the device slot (cheap, unlike a passphrase slot).
pub fn fuzz_header(data: &[u8]) {
    if let Ok(h) = VaultHeader::parse(data) {
        let d = device();
        if let Ok(u) = h.unlock(Unlock::Device(&d)) {
            let _ = h.to_bytes(&u);
        }
    }
}

/// `keyring.liberk`: parse, then unlock with the device slot.
pub fn fuzz_keyring(data: &[u8]) {
    if let Ok(k) = KeyringFile::parse(data) {
        let d = device();
        if let Ok(s) = k.unlock(Unlock::Device(&d)) {
            let _ = k.to_bytes(&s);
        }
    }
}

/// A `.libere` file: the bytes as-is (reader, seek, salvage), and `data` itself as plaintext
/// sealed then tampered at an offset taken from its first two bytes, to reach past the header.
pub fn fuzz_stream(data: &[u8]) {
    let key = Secret::<32>::from_bytes([7; 32]);
    let any_epoch = |_| Some(&key);
    let _ = header_epoch(data);
    if let Ok(mut r) = StreamReader::open(Cursor::new(data), any_epoch) {
        let mut out = Vec::new();
        let _ = r.read_to_end(&mut out);
        let _ = r.seek(SeekFrom::Start(r.len() / 2));
        let _ = r.read_to_end(&mut out);
    }
    let _ = salvage(data, any_epoch);

    let (pos, body) = data.split_at(data.len().min(2));
    let mut w = StreamWriter::new(Vec::new(), &key, 1).unwrap();
    w.write_all(body).unwrap();
    let mut sealed = w.finish().unwrap();
    let i = pos.iter().fold(0usize, |a, &b| a << 8 | b as usize) % sealed.len();
    sealed[i] ^= 1;
    let _ = salvage(&sealed[..], any_epoch);
    if let Ok(mut r) = StreamReader::open(Cursor::new(sealed), any_epoch) {
        let _ = r.read_to_end(&mut Vec::new());
    }
}

/// On-disk names: decrypt as file and as folder, shorten, and strip a conflict suffix.
pub fn fuzz_names(data: &[u8]) {
    let s = String::from_utf8_lossy(data);
    let key = Secret::<64>::from_bytes([3; 64]);
    let id = VaultId([5; 16]);
    let c = NameCodec::new(&key, &id, 1);
    let _ = c.decrypt_file(&FolderId::ROOT, &s);
    let _ = c.decrypt_folder(&FolderId::ROOT, &s);
    let _ = shorten(&s);
    let _ = strip_conflict(&s);
}
