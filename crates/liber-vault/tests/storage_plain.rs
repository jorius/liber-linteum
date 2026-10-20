//! E2 Task 1: `PlainStorage`'s read side behaves as today's `Vault` reads.

use liber_vault::{Child, Follow, Kind, PlainStorage, Reach, Storage, VaultError, VaultPath};
use std::io::{Read, Seek, SeekFrom};

fn p(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

#[test]
fn meta_reports_logical_len_and_physical_mtime() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "hello").unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    assert_eq!(s.name(), "plain");
    let meta = s.meta(&p("a.md"), Follow::No).unwrap().unwrap();
    assert_eq!((meta.kind, meta.len), (Kind::File, 5));
    assert!(meta.mtime_ns > 0, "{meta:?}");
    assert!(s.meta(&p("missing.md"), Follow::No).unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn meta_follow_inside_vault() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "twelve bytes").unwrap();
    std::os::unix::fs::symlink(dir.path().join("a.md"), dir.path().join("link.md")).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", dir.path().join("out.md")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("missing.md"), dir.path().join("gone.md")).unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let link = s.meta(&p("link.md"), Follow::No).unwrap().unwrap();
    assert_eq!(link.kind, Kind::Symlink);
    let followed = s.meta(&p("link.md"), Follow::InsideVault).unwrap().unwrap();
    assert_eq!((followed.kind, followed.len), (Kind::File, 12));
    for outside in ["out.md", "gone.md"] {
        let err = s.meta(&p(outside), Follow::InsideVault).unwrap_err();
        assert!(
            matches!(err, VaultError::OutsideVault(_)),
            "{outside}: {err:?}"
        );
    }
}

#[test]
fn children_lists_hidden_names_and_reports_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::create_dir(dir.path().join("B")).unwrap();
    std::fs::write(dir.path().join("a.md"), "a").unwrap();
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let bad = std::ffi::OsStr::from_bytes(b"bad\xff.md");
        std::fs::write(dir.path().join(bad), "x").unwrap();
    }
    let s = PlainStorage::open(dir.path()).unwrap();
    let mut entries = Vec::new();
    let mut unreadable = Vec::new();
    for child in s.children(&VaultPath::root()).unwrap() {
        match child {
            Child::Entry { name, meta } => entries.push((name, meta.kind)),
            Child::Unreadable(msg) => unreadable.push(msg),
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        entries,
        [
            (".liber".to_string(), Kind::Dir),
            ("B".to_string(), Kind::Dir),
            ("a.md".to_string(), Kind::File),
        ]
    );
    #[cfg(target_os = "linux")]
    assert!(
        unreadable.len() == 1 && unreadable[0].ends_with("bad\u{fffd}.md: name is not UTF-8"),
        "{unreadable:?}"
    );
    #[cfg(not(target_os = "linux"))]
    assert!(unreadable.is_empty(), "{unreadable:?}");
}

#[test]
fn read_and_open_read_return_the_same_bytes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "hello world").unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    assert_eq!(s.read(&p("a.md")).unwrap(), b"hello world");
    let mut reader = s.open_read(&p("a.md"), Reach::Any).unwrap();
    assert_eq!(reader.len, 11);
    reader.inner.seek(SeekFrom::Start(6)).unwrap();
    let mut buf = [0u8; 5];
    reader.inner.read_exact(&mut buf).unwrap();
    assert_eq!(&buf, b"world");
}

#[cfg(unix)]
#[test]
fn open_read_visible_refuses_hidden_real_target() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".secret")).unwrap();
    std::fs::write(dir.path().join(".secret/k.png"), "k").unwrap();
    std::os::unix::fs::symlink(dir.path().join(".secret/k.png"), dir.path().join("v.png")).unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s.open_read(&p("v.png"), Reach::Visible).err().unwrap();
    assert!(matches!(err, VaultError::OutsideVault(_)), "{err:?}");
    assert!(s.open_read(&p("v.png"), Reach::Any).is_ok());
}

#[cfg(unix)]
#[test]
fn resolve_refuses_parent_symlink_outside() {
    let dir = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    std::fs::write(elsewhere.path().join("x.md"), "x").unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), dir.path().join("sub")).unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s.read(&p("sub/x.md")).unwrap_err();
    assert!(matches!(err, VaultError::OutsideVault(_)), "{err:?}");
}
