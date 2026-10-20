//! E2 Tasks 1–2: `PlainStorage` behaves as today's `Vault` reads and writes.

use liber_vault::{
    Child, Follow, Kind, OsUse, PlainStorage, Reach, Replace, Storage, VaultError, VaultPath,
};
use std::io::{Read, Seek, SeekFrom, Write};

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

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn replace_atomic_overwrites_and_leaves_no_temp() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "old").unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    s.replace_atomic(&p("a.md"), &mut &b"new bytes"[..], Replace::Overwrite)
        .unwrap();
    assert_eq!(names(dir.path()), ["a.md"]);
    assert_eq!(
        std::fs::read(dir.path().join("a.md")).unwrap(),
        b"new bytes"
    );
}

#[test]
fn replace_atomic_create_only_refuses_existing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "old").unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s
        .replace_atomic(&p("a.md"), &mut &b"new"[..], Replace::CreateOnly)
        .unwrap_err();
    assert!(matches!(err, VaultError::AlreadyExists(_)), "{err:?}");
    assert_eq!(std::fs::read(dir.path().join("a.md")).unwrap(), b"old");
}

#[test]
fn replace_atomic_missing_parent_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s
        .replace_atomic(&p("nope/a.md"), &mut &b"x"[..], Replace::CreateOnly)
        .unwrap_err();
    assert!(
        matches!(&err, VaultError::NotFound(p) if p == "nope"),
        "{err:?}"
    );
}

#[cfg(unix)]
#[test]
fn replace_atomic_keeps_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.md");
    std::fs::write(&file, "old").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o750)).unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    s.replace_atomic(&p("a.md"), &mut &b"new"[..], Replace::Overwrite)
        .unwrap();
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o750);
}

#[test]
fn create_new_streams_and_refuses_existing() {
    let dir = tempfile::tempdir().unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let mut w = s.create_new(&p("a.bin")).unwrap();
    w.write_all(b"ab").unwrap();
    w.write_all(b"cd").unwrap();
    drop(w);
    assert_eq!(s.read(&p("a.bin")).unwrap(), b"abcd");
    let err = s.create_new(&p("a.bin")).err().unwrap();
    assert!(matches!(err, VaultError::AlreadyExists(_)), "{err:?}");
}

#[test]
fn remove_empty_dir_refuses_non_empty() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("d")).unwrap();
    std::fs::write(dir.path().join("d/a.md"), "a").unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s.remove_empty_dir(&p("d")).unwrap_err();
    assert!(matches!(err, VaultError::Io { .. }), "{err:?}");
    assert!(dir.path().join("d").is_dir());
}

#[test]
fn rename_refuses_existing_target() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "a").unwrap();
    std::fs::write(dir.path().join("b.md"), "b").unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s.rename(&p("a.md"), &p("b.md")).unwrap_err();
    assert!(matches!(err, VaultError::AlreadyExists(_)), "{err:?}");
    assert_eq!(std::fs::read(dir.path().join("b.md")).unwrap(), b"b");
}

#[test]
fn rename_missing_source_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s.rename(&p("gone.md"), &p("z.md")).unwrap_err();
    assert!(matches!(err, VaultError::NotFound(_)), "{err:?}");
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn rename_case_only() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "a").unwrap();
    if !dir.path().join("A.md").exists() {
        eprintln!("skipped: the temp volume is case-sensitive");
        return;
    }
    let s = PlainStorage::open(dir.path()).unwrap();
    s.rename(&p("a.md"), &p("A.md")).unwrap();
    assert_eq!(names(dir.path()), ["A.md"]);
}

#[test]
fn trash_os_missing_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let err = s.trash_os(&p("gone.md")).unwrap_err();
    assert!(matches!(err, VaultError::NotFound(_)), "{err:?}");
}

#[test]
fn os_path_matches_resolve_for_every_use() {
    let dir = tempfile::tempdir().unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    for use_ in [OsUse::Open, OsUse::Reveal, OsUse::FileUrl] {
        assert_eq!(
            s.os_path(&p("a.md"), use_).unwrap(),
            s.location().join("a.md")
        );
    }
}

#[test]
fn vault_path_of_maps_inside_and_rejects_outside() {
    let dir = tempfile::tempdir().unwrap();
    let s = PlainStorage::open(dir.path()).unwrap();
    let inside = s.location().join("x").join("y.md");
    assert_eq!(s.vault_path_of(&inside), Some(p("x/y.md")));
    assert_eq!(s.vault_path_of(std::path::Path::new("/tmp/z")), None);
}
