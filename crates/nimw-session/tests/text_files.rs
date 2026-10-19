//! M4b part 2 §6: plain-text and code files open in the app — by name, and
//! only when the content is UTF-8 without NUL bytes and at most 2 MB; written
//! by compare-and-swap and indexed as attachments, never as pages.

use nimw_index::FileKind;
use nimw_session::{SessionError, SessionEvent, TEXT_MAX_BYTES, VaultSession, is_text_path};
use nimw_vault::{Hash, VaultError, VaultPath};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn session_with(files: &[(&str, &[u8])]) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
    let vault = tempfile::tempdir().unwrap();
    for (path, bytes) in files {
        let full = vault.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, bytes).unwrap();
    }
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    (vault, cache, s)
}

#[test]
fn text_names_by_extension_and_whole_name() {
    for yes in [
        "a.txt",
        "dir/b.JSON",
        "c.yml",
        "d.tsx",
        "e.rs",
        "f.ps1",
        "g.svelte",
        "Dockerfile",
        "x/Makefile",
        ".gitignore",
        "y/.editorconfig",
    ] {
        assert!(is_text_path(yes), "{yes}");
    }
    for no in [
        "a.md",
        "b.png",
        "c.pdf",
        "README",
        "d.txt.bak",
        "dockerfile.png",
    ] {
        assert!(!is_text_path(no), "{no}");
    }
}

#[test]
fn read_and_write_text_with_compare_and_swap() {
    let (dir, _c, s) = session_with(&[("conf/app.json", b"{\"a\": 1}\n")]);
    let path = vp("conf/app.json");
    let (text, hash) = s.read_text(&path).unwrap();
    assert_eq!(text, "{\"a\": 1}\n");
    let new_hash = s.write_text(&path, "{\"a\": 2}\n", hash).unwrap();
    assert_eq!(new_hash, Hash::of(b"{\"a\": 2}\n"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("conf/app.json")).unwrap(),
        "{\"a\": 2}\n"
    );
    // Indexed as an attachment with the new hash, never as a page.
    let tree = s.tree().unwrap();
    let node = tree.iter().find(|n| n.path == "conf/app.json").unwrap();
    assert_eq!(node.kind, FileKind::Attachment);
    assert!(s.page(&path).unwrap().is_none());
    // A stale hash is refused and nothing is written.
    let err = s.write_text(&path, "lost", hash).unwrap_err();
    assert!(
        matches!(err, SessionError::Vault(VaultError::Conflict { current, .. }) if current == new_hash),
        "{err:?}"
    );
}

#[test]
fn only_eligible_text_files() {
    let big = vec![b'a'; TEXT_MAX_BYTES + 1];
    let (_d, _c, s) = session_with(&[
        ("nul.txt", b"a\0b"),
        ("latin1.txt", b"caf\xe9"),
        ("big.log", &big),
        ("page.md", b"# Page\n"),
        ("pic.png", b"not really"),
        ("ok.txt", b"fine\n"),
        (".hidden/x.txt", b"hidden\n"),
    ]);
    for path in ["nul.txt", "latin1.txt", "big.log", "page.md", "pic.png"] {
        let err = s.read_text(&vp(path)).unwrap_err();
        assert!(matches!(err, SessionError::NotAText(_)), "{path}: {err:?}");
    }
    // Not in the vault's index (hidden, missing): not found.
    for path in [".hidden/x.txt", "missing.txt"] {
        let err = s.read_text(&vp(path)).unwrap_err();
        assert!(
            matches!(err, SessionError::NotIndexed(_)),
            "{path}: {err:?}"
        );
    }
    // Text that would no longer be eligible isn't written.
    let (_, hash) = s.read_text(&vp("ok.txt")).unwrap();
    let err = s.write_text(&vp("ok.txt"), "a\0", hash).unwrap_err();
    assert!(matches!(err, SessionError::NotAText(_)), "{err:?}");
    let err = s.write_text(&vp("page.md"), "# x", hash).unwrap_err();
    assert!(matches!(err, SessionError::NotAText(_)), "{err:?}");
}

fn kind_of(s: &VaultSession, path: &str) -> Option<FileKind> {
    s.tree()
        .unwrap()
        .into_iter()
        .find(|n| n.path == path)
        .map(|n| n.kind)
}

/// Final review I6: an unclean merge on `data.csv` saves their version as
/// `data (conflict).csv` — still a text file, never a page holding CSV.
#[test]
fn a_text_files_conflict_copy_keeps_its_type() {
    let (dir, _c, s) = session_with(&[("data/data.csv", b"a,b\n"), ("Dockerfile", b"FROM x\n")]);
    let first = s
        .create_conflict_copy(&vp("data/data.csv"), "theirs 1\n")
        .unwrap();
    let second = s
        .create_conflict_copy(&vp("data/data.csv"), "theirs 2\n")
        .unwrap();
    assert_eq!(first.as_str(), "data/data (conflict).csv");
    assert_eq!(second.as_str(), "data/data (conflict 2).csv");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("data/data (conflict 2).csv")).unwrap(),
        "theirs 2\n"
    );
    assert_eq!(kind_of(&s, second.as_str()), Some(FileKind::Attachment));
    assert!(s.page(&second).unwrap().is_none());
    assert_eq!(s.read_text(&second).unwrap().0, "theirs 2\n");
    // A text file known by its whole name has no extension to keep: its
    // copy isn't a page either.
    let copy = s
        .create_conflict_copy(&vp("Dockerfile"), "FROM y\n")
        .unwrap();
    assert_eq!(copy.as_str(), "Dockerfile (conflict)");
    assert_eq!(kind_of(&s, copy.as_str()), Some(FileKind::Attachment));
}

/// Final review I6: "Save as new" for a text file deleted outside the app
/// creates a text file again (`notes.json`, not `notes.json.md`).
#[test]
fn create_text_file_keeps_the_name_and_refuses_taken_or_other_names() {
    let (dir, _c, s) = session_with(&[("conf/app.json", b"{}\n")]);
    let made = s.create_text_file(&vp("conf"), "notes.json").unwrap();
    assert_eq!(made.as_str(), "conf/notes.json");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("conf/notes.json")).unwrap(),
        ""
    );
    assert_eq!(kind_of(&s, "conf/notes.json"), Some(FileKind::Attachment));
    let (_, hash) = s.read_text(&made).unwrap();
    s.write_text(&made, "{\"kept\": true}\n", hash).unwrap();
    let err = s.create_text_file(&vp("conf"), "app.json").unwrap_err();
    assert!(
        matches!(err, SessionError::Vault(VaultError::AlreadyExists(_))),
        "{err:?}"
    );
    for name in ["page.md", "pic.png", "README"] {
        let err = s.create_text_file(&vp("conf"), name).unwrap_err();
        assert!(matches!(err, SessionError::NotAText(_)), "{name}: {err:?}");
    }
    let err = s.create_text_file(&vp("conf"), "a/b.txt").unwrap_err();
    assert!(matches!(err, SessionError::InvalidName(_)), "{err:?}");
}
