//! E3: a session over an unlocked encrypted vault keeps its index in memory
//! (spec §5.1), and `lock` ends every read (spec §6.2).

use liber_session::{SearchQuery, SessionEvent, VaultSession};
use liber_vault::{Reach, Vault, VaultError, VaultPath, seal_in_place};
use std::io::Read;

fn sealed(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (name, text) in files {
        std::fs::write(dir.path().join(name), text).unwrap();
    }
    drop(seal_in_place(dir.path()).unwrap());
    dir
}

fn open(dir: &tempfile::TempDir) -> VaultSession {
    let storage = seal_in_place(dir.path()).unwrap();
    VaultSession::open_encrypted(storage, |_: SessionEvent| {})
        .unwrap()
        .0
}

#[test]
fn encrypted_session_indexes_in_memory_only() {
    let dir = sealed(&[("Canary.md", "canary-7f3a #tag")]);
    let cache = tempfile::tempdir().unwrap();
    let s = open(&dir);
    let q = SearchQuery {
        text: "canary".into(),
        ..SearchQuery::default()
    };
    let hits: Vec<String> = s
        .search(&q)
        .unwrap()
        .results
        .into_iter()
        .map(|h| h.path)
        .collect();
    assert_eq!(hits, vec!["Canary.md"]);
    // No cache root was given, and nothing was written to one.
    assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    // Nothing next to the vault either: only its own files.
    let mut top: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    top.sort();
    assert_eq!(top, ["README.txt", "d", "liber-vault.json"]);
}

#[test]
fn lock_mid_read_returns_locked() {
    let dir = sealed(&[("Canary.md", "canary-7f3a #tag")]);
    let s = open(&dir);
    let path = VaultPath::new("Canary.md").unwrap();
    let mut reader = s.vault().open_read(&path, Reach::Any).unwrap();
    s.lock();
    let mut buf = Vec::new();
    let err = reader.inner.read_to_end(&mut buf).unwrap_err();
    assert!(buf.is_empty(), "no bytes after lock");
    let inner = err.get_ref().and_then(|e| e.downcast_ref::<VaultError>());
    assert!(matches!(inner, Some(VaultError::Locked)), "{err:?}");
    // What page_get reads.
    let err = s.vault().read(&path).unwrap_err();
    assert!(matches!(err, VaultError::Locked), "{err:?}");
    // The index is empty: nothing decrypted stays in memory.
    let q = SearchQuery {
        text: "canary".into(),
        ..SearchQuery::default()
    };
    assert!(s.search(&q).unwrap().results.is_empty());
}

#[test]
fn plain_open_of_encrypted_folder_is_locked() {
    // On the encrypted switch, `Vault::open` unlocks a sealed folder by design.
    if liber_testkit::plain_disk_only() {
        return;
    }
    let dir = sealed(&[("Canary.md", "canary-7f3a")]);
    let err = Vault::open(dir.path()).unwrap_err();
    assert!(matches!(err, VaultError::Locked), "{err:?}");
}
