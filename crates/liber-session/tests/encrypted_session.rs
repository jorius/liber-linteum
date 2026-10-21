//! E3: a session over an unlocked encrypted vault keeps its index in memory
//! (spec §5.1), and `lock` ends every read (spec §6.2).

use liber_session::{SearchQuery, SessionError, SessionEvent, VaultSession};
use liber_vault::{
    Reach, Replace, Storage, Vault, VaultError, VaultPath, WatchEvent, seal_in_place,
};
use std::io::Read;
use std::time::Duration;

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
    assert_eq!(
        s.index_file().unwrap(),
        "",
        "PRAGMA database_list: in memory"
    );
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
    // The index is gone: nothing decrypted stays in memory.
    assert!(locked(s.search(&canary())));
}

fn canary() -> SearchQuery {
    SearchQuery {
        text: "canary".into(),
        ..SearchQuery::default()
    }
}

fn locked<T: std::fmt::Debug>(r: Result<T, SessionError>) -> bool {
    matches!(r, Err(SessionError::Vault(VaultError::Locked)))
}

#[test]
fn index_backed_calls_are_locked_after_lock() {
    let dir = sealed(&[("Canary.md", "canary-7f3a #tag")]);
    let s = open(&dir);
    let path = VaultPath::new("Canary.md").unwrap();
    assert!(s.page(&path).unwrap().is_some());
    s.lock();
    assert!(locked(s.search(&canary())));
    assert!(locked(s.tree()));
    assert!(locked(s.page(&path)));
    assert!(locked(s.backlinks(&path)));
}

#[test]
fn a_watcher_batch_or_save_after_lock_writes_no_rows() {
    let dir = sealed(&[("Canary.md", "canary-7f3a #tag")]);
    let s = open(&dir);
    let path = VaultPath::new("Canary.md").unwrap();
    let (_, hash) = s.vault().read(&path).unwrap();
    s.lock();
    // A batch the watcher had in flight, and a save, both landing after the lock.
    assert!(locked(s.apply(vec![WatchEvent::Changed(path.clone())])));
    assert!(locked(s.apply(vec![WatchEvent::Overflow])));
    assert!(locked(s.write_page(&path, "canary-7f3a again", hash)));
    assert!(locked(s.search(&canary())));
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

#[test]
fn a_plain_session_keeps_its_index_in_the_cache_folder() {
    let dir = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(dir.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    assert!(s.index_file().unwrap().ends_with("index.sqlite"));
}

/// Another app instance (a second unlock of the same vault) writes a note:
/// the session's watcher translates it and search finds it.
#[test]
fn a_note_written_elsewhere_reaches_search_through_the_watcher() {
    let dir = sealed(&[("Canary.md", "canary-7f3a")]);
    let s = std::sync::Arc::new(open(&dir));
    s.start_watching().unwrap();
    let elsewhere = seal_in_place(dir.path()).unwrap();
    elsewhere
        .replace_atomic(
            &VaultPath::new("Later.md").unwrap(),
            &mut &b"zebra-91c"[..],
            Replace::CreateOnly,
        )
        .unwrap();
    let zebra = SearchQuery {
        text: "zebra".into(),
        ..SearchQuery::default()
    };
    let found = liber_testkit::wait_until(Duration::from_secs(10), || {
        s.search(&zebra)
            .is_ok_and(|p| p.results.iter().any(|h| h.path == "Later.md"))
    });
    assert!(found, "the watcher never indexed Later.md");
}
