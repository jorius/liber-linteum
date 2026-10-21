//! E3 Global Constraints: a vault `EncryptedStorage` wrote decrypts with an
//! independent reader. `crates/liber-crypto/tests/xcheck/xcheck.py vault`
//! (stdlib + Python `cryptography` only) unlocks it with the passphrase,
//! checks the header MAC, decrypts every name and file under `d/` and compares
//! the tree with what was written. Runs when `LIBER_XCHECK_PY` names a Python
//! with `cryptography` >= 44 (AES-SIV, Argon2id); otherwise it prints SKIP.

use liber_crypto::{Argon2Params, FolderId, NameCodec, Unlock, VaultHeader};
use liber_vault::{EncryptedStorage, HEADER_FILE, Replace, Storage, VaultPath};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const PASS: &str = "correct horse ⚡ batterie";
const TINY: Argon2Params = Argon2Params {
    m_kib: 64,
    t: 1,
    p: 1,
};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn run(py: &str, root: &Path, expected: &Path) -> Output {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../liber-crypto/tests/xcheck/xcheck.py");
    Command::new(py)
        .arg("-I")
        .arg(script)
        .arg("vault")
        .arg(root)
        .arg(PASS)
        .arg(expected)
        .output()
        .unwrap()
}

fn first_file_under(dir: &Path, suffix: &str) -> PathBuf {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else if p.to_string_lossy().ends_with(suffix) {
                return p;
            }
        }
    }
    panic!("no {suffix} under {}", dir.display())
}

#[test]
fn an_e3_vault_decrypts_with_the_python_reader() {
    let Some(py) = std::env::var("LIBER_XCHECK_PY")
        .ok()
        .filter(|p| !p.is_empty())
    else {
        println!("SKIP: set LIBER_XCHECK_PY to a python3 with cryptography >= 44");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Vault");
    std::fs::create_dir(&root).unwrap();
    let (s, _code) = EncryptedStorage::create_insecure(&root, PASS, TINY).unwrap();
    let mut want: BTreeMap<String, String> = BTreeMap::new();
    let mut put = |path: &str, body: &[u8]| {
        s.replace_atomic(&vp(path), &mut &body[..], Replace::CreateOnly)
            .unwrap();
        want.insert(path.to_string(), hex(body));
    };
    let multi: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let long = format!("{}.md", "L".repeat(150));
    s.create_dir(&vp("Projects")).unwrap();
    s.create_dir(&vp("Projects/Résumé")).unwrap();
    s.create_dir(&vp(&"F".repeat(160))).unwrap();
    put("Notes.md", b"# Notes\n\nA short page.\n");
    put("big.bin", &multi);
    put("Projects/Résumé/Plan.md", b"nested");
    put(&long, b"a long name");
    put(
        &format!("{}/inside.md", "F".repeat(160)),
        b"in a long folder",
    );
    put("Draft.md", b"renamed later");
    put("Cafe\u{301}.md", b"NFD on the way in");
    drop(put);
    s.rename(&vp("Draft.md"), &vp("Projects/Final.md")).unwrap();
    let draft = want.remove("Draft.md").unwrap();
    want.insert("Projects/Final.md".into(), draft);
    let nfd = want.remove("Cafe\u{301}.md").unwrap();
    want.insert("Café.md".into(), nfd);

    // Final review C1: a folder another device made offline under the same
    // name (its own id). Both decrypt as `Shared`; a write into the one listed
    // as `Shared (duplicate 1)` lands in it.
    s.create_dir(&vp("Shared")).unwrap();
    s.replace_atomic(
        &vp("Shared/mine.md"),
        &mut &b"mine"[..],
        Replace::CreateOnly,
    )
    .unwrap();
    let header = VaultHeader::parse(&std::fs::read(root.join(HEADER_FILE)).unwrap()).unwrap();
    let u = header.unlock(Unlock::Passphrase(PASS)).unwrap();
    let codec = NameCodec::new(&u.subkeys().name, u.vault_id(), u.epoch());
    let theirs = codec
        .encrypt_folder(&FolderId::ROOT, &FolderId::random(), "Shared")
        .unwrap();
    std::fs::create_dir(root.join("d").join(theirs)).unwrap();
    s.children(&VaultPath::root()).unwrap();
    s.replace_atomic(
        &vp("Shared (duplicate 1)/theirs.md"),
        &mut &b"theirs"[..],
        Replace::CreateOnly,
    )
    .unwrap();
    want.insert("Shared/mine.md".into(), hex(b"mine"));
    want.insert("Shared/theirs.md".into(), hex(b"theirs"));

    // A recording-style take: streamed in pieces through `create_new`, then `finish`.
    s.create_dir(&vp("Recordings")).unwrap();
    let take: Vec<u8> = (0..150_000u32).map(|i| (i * 7 % 256) as u8).collect();
    let mut file = s.create_new(&vp("Recordings/clip.wav")).unwrap();
    for piece in take.chunks(4_096) {
        file.write_all(piece).unwrap();
        file.flush().unwrap();
    }
    file.finish().unwrap();
    want.insert("Recordings/clip.wav".into(), hex(&take));
    for folder in [
        "Shared",
        "Projects",
        "Projects/Résumé",
        "Recordings",
        &"F".repeat(160),
    ] {
        want.insert(folder.to_string(), "dir".into());
    }
    drop(s);

    let expected = dir.path().join("expected.json");
    std::fs::write(&expected, serde_json::to_vec(&want).unwrap()).unwrap();
    // The long names really took the §14.5 path.
    first_file_under(&root.join("d"), ".libern");

    let out = run(&py, &root, &expected);
    let text = |o: &Output| {
        format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    };
    match out.status.code() {
        Some(0) => print!("{}", text(&out)),
        Some(77) => return println!("SKIP: {}", text(&out).trim()),
        _ => panic!("xcheck failed ({}):\n{}", out.status, text(&out)),
    }

    // A real guard: one flipped ciphertext byte fails it.
    let victim = first_file_under(&root.join("d"), ".libere");
    let mut bytes = std::fs::read(&victim).unwrap();
    bytes[60] ^= 1;
    std::fs::write(&victim, bytes).unwrap();
    let out = run(&py, &root, &expected);
    assert!(
        !matches!(out.status.code(), Some(0) | Some(77)),
        "a flipped byte must fail:\n{}",
        text(&out)
    );
}
