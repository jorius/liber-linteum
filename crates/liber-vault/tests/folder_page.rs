//! A folder's own page, `X/X.md`, also matched when only the letter case
//! differs; an exact name wins (round 3 spec §9).
use liber_vault::{Vault, VaultPath};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn vault_with(files: &[&str]) -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    for f in files {
        let p = dir.path().join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "").unwrap();
    }
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

#[test]
fn subpages_exact_folder_page() {
    let (_d, v) = vault_with(&["X/X.md", "X/Other.md"]);
    assert_eq!(v.folder_page_of(&vp("X")), Some(vp("X/X.md")));
    assert_eq!(v.folder_page_of(&vp("X/Other.md")), None);
    assert_eq!(v.folder_page_of(&VaultPath::root()), None);
}

#[test]
fn subpages_case_variant_folder_page() {
    let (_d, v) = vault_with(&["MyProject/Myproject.md", "Árbol/árbol.md"]);
    assert_eq!(
        v.folder_page_of(&vp("MyProject")),
        Some(vp("MyProject/Myproject.md"))
    );
    assert_eq!(v.folder_page_of(&vp("Árbol")), Some(vp("Árbol/árbol.md")));
}

#[test]
fn subpages_folder_named_like_its_page_is_not_a_page() {
    let (_d, v) = vault_with(&["X/X.md/inner.md"]);
    assert_eq!(v.folder_page_of(&vp("X")), None);
}

#[test]
fn subpages_exact_page_wins_over_a_case_variant() {
    let (dir, v) = vault_with(&["X/X.md"]);
    // Only possible on a case-sensitive file system.
    if std::fs::write(dir.path().join("X/x.md"), "").is_err()
        || std::fs::read_dir(dir.path().join("X")).unwrap().count() < 2
    {
        return;
    }
    assert_eq!(v.folder_page_of(&vp("X")), Some(vp("X/X.md")));
}

#[test]
fn subpages_child_named_finds_any_case() {
    let (_d, v) = vault_with(&["Notes/a.md"]);
    assert_eq!(
        v.child_named(&VaultPath::root(), "notes").unwrap(),
        Some(vp("Notes"))
    );
    assert_eq!(
        v.child_named(&VaultPath::root(), "Notes").unwrap(),
        Some(vp("Notes"))
    );
    assert_eq!(v.child_named(&VaultPath::root(), "Missing").unwrap(), None);
}
