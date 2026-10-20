//! Frozen v1 test vectors (spec §4.4). Every value comes from the real code paths under a seeded
//! RNG and must match the files in `tests/vectors/v1` byte for byte; `tests/xcheck/xcheck.py`
//! re-derives them independently. `REGEN=1` rewrites the files: only for a deliberate format change.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use data_encoding::HEXLOWER;
use serde_json::json;

use crate::header::VaultHeader;
use crate::kdf::Argon2Params;
use crate::keyring::KeyringFile;
use crate::keys::{Secret, random_bytes, with_seeded_rng};
use crate::names::{FolderId, NameCodec, shorten};
use crate::slots::{NewSlot, Unlock};
use crate::stream::StreamWriter;

const SEED: u64 = 0x4c69_6265_7256_3031;
const PASSPHRASE: &str = "correct horse ⚡ batterie";
/// Below the floor on purpose, so the Python reader runs quickly.
const PARAMS: Argon2Params = Argon2Params {
    m_kib: 64,
    t: 1,
    p: 1,
};
/// Non-ASCII, so the canonical JSON pins raw UTF-8 (Python needs `ensure_ascii=False`).
const DEVICE_ID: &str = "José's MacBook";
const FILE_LENS: [usize; 5] = [0, 1, 65_535, 65_536, 200_000];

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/v1")
}

fn hex(b: &[u8]) -> String {
    HEXLOWER.encode(b)
}

/// Every committed file, regenerated: `(file name, bytes)`.
fn generate() -> Vec<(String, Vec<u8>)> {
    with_seeded_rng(SEED, || {
        let mut out = Vec::new();
        let (mut h, u, rc) = VaultHeader::create_unchecked(PASSPHRASE, PARAMS).unwrap();
        let (vault_id, epoch) = (*h.vault_id(), h.epoch());
        let device = Secret::<32>::random();
        let add_device = |h: &mut VaultHeader, device_id: &str, secret| {
            let device_id = device_id.into();
            h.add_slot(&u, NewSlot::Device { device_id, secret })
                .unwrap()
        };
        add_device(&mut h, DEVICE_ID, &device);
        let (mut kf, ks, krc) = KeyringFile::create_unchecked(PASSPHRASE, PARAMS).unwrap();
        kf.enroll(&ks, &vault_id, &u.subkeys().header).unwrap();
        h.add_slot(&u, NewSlot::Keyring(&kf.public())).unwrap();
        // A removed slot leaves a tombstone in `removed`, which the MAC covers.
        let gone = add_device(&mut h, "old phone", &Secret::random());
        h.remove_slot(&u, &gone).unwrap();
        let header = h.to_bytes(&u).unwrap();
        // Python has no X-Wing, so the keyring slot is checked here.
        let k = VaultHeader::parse(&header).unwrap();
        let k = k.unlock(Unlock::Keyring(&ks)).unwrap();
        assert_eq!(k.vk.expose(), u.vk.expose());
        out.push(("header.json".to_string(), header));
        out.push(("keyring.liberk".to_string(), kf.to_bytes(&ks).unwrap()));

        let codec = NameCodec::new(&u.subkeys().name, &vault_id, epoch);
        let projects = FolderId::random();
        let long = format!("{}.md", "x".repeat(150));
        let table = [
            (FolderId::ROOT, "Notes.md", None),
            (FolderId::ROOT, "Projects", Some(projects)),
            (projects, "Plan.md", None),
            (projects, "Cafe\u{301} notes.md", None), // NFD in, NFC encrypted
            (projects, "Re\u{301}sume\u{301}", Some(FolderId::random())),
            (projects, long.as_str(), None),
        ];
        let names: Vec<_> = table
            .iter()
            .map(|(parent, name, folder)| {
                let (kind, on_disk) = match folder {
                    Some(id) => ("folder", codec.encrypt_folder(parent, id, name)),
                    None => ("file", codec.encrypt_file(parent, name)),
                };
                let mut v = json!({
                    "parent": hex(&parent.0),
                    "name": name,
                    "kind": kind,
                    "on_disk": on_disk,
                });
                if let Some(id) = folder {
                    v["folder_id"] = json!(hex(&id.0));
                }
                if let Some(s) = shorten(&on_disk) {
                    v["short"] = json!({ "on_disk": s.on_disk, "side_file": s.side_file });
                }
                v
            })
            .collect();

        let mut files = Vec::new();
        for len in FILE_LENS {
            let salt: [u8; 32] = random_bytes();
            let plain: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let mut w =
                StreamWriter::with_salt(Vec::new(), &u.subkeys().content, epoch, salt).unwrap();
            w.write_all(&plain).unwrap();
            let name = format!("file-{len}.libere");
            out.push((name.clone(), w.finish().unwrap()));
            files.push(json!({
                "name": name,
                "plaintext_rule": "i % 251",
                "len": len,
                "salt": hex(&salt),
            }));
        }

        // A rotation: new key at epoch 2, the old one kept as retiring.
        let (u2, rc2) = h.begin_rotation_unchecked(&u, PASSPHRASE, PARAMS).unwrap();
        out.push(("header-rotated.json".to_string(), h.to_bytes(&u2).unwrap()));

        let s = u.subkeys();
        let v = json!({
            "vk": hex(u.vk.expose()),
            "vault_id": hex(&vault_id.0),
            "epoch": epoch,
            "subkeys": {
                "content": hex(s.content.expose()),
                "name": hex(s.name.expose()),
                "header": hex(s.header.expose()),
                "index": hex(s.index.expose()),
            },
            "passphrase": PASSPHRASE,
            "params": { "m_kib": PARAMS.m_kib, "t": PARAMS.t, "p": PARAMS.p },
            "recovery_code": rc.to_display(),
            "device": { "device_id": DEVICE_ID, "secret": hex(device.expose()) },
            "names": names,
            "files": files,
            "rotated": {
                "vk": hex(u2.vk.expose()),
                "epoch": u2.epoch(),
                "recovery_code": rc2.to_display(),
            },
            "keyring": { "recovery_code": krc.to_display() },
        });
        let mut vj = serde_json::to_vec_pretty(&v).unwrap();
        vj.push(b'\n');
        out.push(("vectors.json".to_string(), vj));
        out
    })
}

#[test]
fn vectors_are_stable() {
    let files = generate();
    let dir = dir();
    if std::env::var_os("REGEN").is_some_and(|v| v == "1") {
        std::fs::create_dir_all(&dir).unwrap();
        for (name, bytes) in &files {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
    }
    let mut committed: Vec<String> = std::fs::read_dir(&dir)
        .expect("tests/vectors/v1 is missing (REGEN=1 writes it)")
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    committed.sort();
    let mut want: Vec<String> = files.iter().map(|f| f.0.clone()).collect();
    want.sort();
    assert_eq!(committed, want, "stale or missing vector files");
    for (name, bytes) in &files {
        let got = std::fs::read(dir.join(name)).unwrap();
        assert!(
            got == *bytes,
            "{name} differs from the regenerated vector: the v1 on-disk format changed"
        );
    }
}

#[test]
fn python_cross_check() {
    let skip = |why: &str| println!("SKIP: python3 + cryptography not available{why}");
    // A missing python3, or a stub that can't run one (the Windows Store alias), counts as absent.
    let runs = Command::new("python3")
        .args(["-I", "-c", ""])
        .output()
        .is_ok_and(|o| o.status.success());
    if !runs {
        return skip("");
    }
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/xcheck/xcheck.py");
    let out = Command::new("python3")
        .arg("-I")
        .arg(script)
        .arg(dir())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    match out.status.code() {
        Some(0) => print!("{stdout}"),
        Some(77) => skip(&format!(
            ": {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        _ => panic!(
            "xcheck failed ({}):\n{stdout}{}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ),
    }
}
