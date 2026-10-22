//! A vault's home in `.liber/vault.json` (`home`): a page or the Global View.
//! A page home follows renames and moves (its folder's too), and is cleared on
//! delete and when it goes into the Trash or the Archive. Other keys are kept,
//! and an encrypted vault keeps it through the storage seam.

use liber_vault::{Home, Vault, seal_in_place};

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn page(path: &str) -> Home {
    Home::Page {
        path: path.to_string(),
    }
}

fn r(from: &str, to: &str) -> (String, String) {
    (from.to_string(), to.to_string())
}

fn s(items: &[&str]) -> Vec<String> {
    items.iter().map(|p| p.to_string()).collect()
}

#[test]
fn nothing_set_writes_nothing() {
    let (dir, vault) = fresh();
    assert_eq!(vault.home(), None);
    vault.set_home(None).unwrap();
    vault.forget_home(&s(&["A.md"])).unwrap();
    vault.remap_home_many(&[r("A", "B")]).unwrap();
    assert_eq!(vault.home(), None);
    assert!(!dir.path().join(".liber").exists());
}

#[test]
fn set_get_and_clear() {
    let (_dir, vault) = fresh();
    vault.set_home(Some(&page("Notes/Start.md"))).unwrap();
    assert_eq!(vault.home(), Some(page("Notes/Start.md")));
    vault.set_home(Some(&Home::GlobalView)).unwrap();
    assert_eq!(vault.home(), Some(Home::GlobalView));
    vault.set_home(None).unwrap();
    assert_eq!(vault.home(), None);
}

#[test]
fn the_stored_shape_and_other_keys_are_kept() {
    if liber_testkit::plain_disk_only() {
        return;
    }
    let (dir, vault) = fresh();
    let file = dir.path().join(".liber/vault.json");
    std::fs::create_dir_all(dir.path().join(".liber")).unwrap();
    std::fs::write(
        &file,
        r#"{"favorites":["A.md"],"someFutureKey":{"x":[1,2]},"folderIcons":{"F":"🌌"}}"#,
    )
    .unwrap();
    vault.set_home(Some(&page("A.md"))).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        json["home"],
        serde_json::json!({ "kind": "page", "path": "A.md" })
    );
    assert_eq!(json["someFutureKey"], serde_json::json!({ "x": [1, 2] }));
    assert_eq!(json["favorites"], serde_json::json!(["A.md"]));
    assert_eq!(vault.favorites(), s(&["A.md"]));
    vault.set_home(Some(&Home::GlobalView)).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(json["home"], serde_json::json!({ "kind": "globalView" }));
    // Clearing removes the key only.
    vault.set_home(None).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(json.get("home").is_none());
    assert_eq!(json["someFutureKey"], serde_json::json!({ "x": [1, 2] }));
    assert_eq!(json["folderIcons"], serde_json::json!({ "F": "🌌" }));
    // Hand-edited junk, or a kind a later version adds, reads as none.
    for junk in [
        r#"{"home":"A.md"}"#,
        r#"{"home":{"kind":"page"}}"#,
        r#"{"home":{"kind":"page","path":""}}"#,
        r#"{"home":{"kind":"calendar"}}"#,
    ] {
        std::fs::write(&file, junk).unwrap();
        assert_eq!(vault.home(), None, "{junk}");
    }
}

#[test]
fn a_page_home_follows_renames_and_moves() {
    let (_dir, vault) = fresh();
    vault.set_home(Some(&page("Lore/Dragons.md"))).unwrap();
    // Its own rename.
    vault
        .remap_home_many(&[r("Lore/Dragons.md", "Lore/Wyrms.md")])
        .unwrap();
    assert_eq!(vault.home(), Some(page("Lore/Wyrms.md")));
    // Its folder renamed; whole components only (`Lo` never touches `Lore`).
    vault
        .remap_home_many(&[r("Lo", "X"), r("Lore", "World")])
        .unwrap();
    assert_eq!(vault.home(), Some(page("World/Wyrms.md")));
    // A parent folder moved under another.
    vault
        .remap_home_many(&[r("World", "Campaign/World")])
        .unwrap();
    assert_eq!(vault.home(), Some(page("Campaign/World/Wyrms.md")));
    // The page moved to the vault root.
    vault
        .remap_home_many(&[r("Campaign/World/Wyrms.md", "Wyrms.md")])
        .unwrap();
    assert_eq!(vault.home(), Some(page("Wyrms.md")));
    // Someone else's rename leaves it alone.
    vault.remap_home_many(&[r("Other.md", "Else.md")]).unwrap();
    assert_eq!(vault.home(), Some(page("Wyrms.md")));
}

#[test]
fn into_the_trash_or_the_archive_clears_it() {
    let (_dir, vault) = fresh();
    vault.set_home(Some(&page("Lore/Dragons.md"))).unwrap();
    vault
        .remap_home_many(&[r("Lore/Dragons.md", ".trash/Dragons.md")])
        .unwrap();
    assert_eq!(vault.home(), None);
    // Restoring doesn't bring it back.
    vault
        .remap_home_many(&[r(".trash/Dragons.md", "Lore/Dragons.md")])
        .unwrap();
    assert_eq!(vault.home(), None);
    // Its folder archived.
    vault.set_home(Some(&page("Lore/Dragons.md"))).unwrap();
    vault
        .remap_home_many(&[r("Lore", ".archive/Lore")])
        .unwrap();
    assert_eq!(vault.home(), None);
}

#[test]
fn the_global_view_ignores_renames_and_deletes() {
    let (_dir, vault) = fresh();
    vault.set_home(Some(&Home::GlobalView)).unwrap();
    vault.remap_home_many(&[r("A", ".trash/A")]).unwrap();
    vault.forget_home(&s(&["A", "B.md"])).unwrap();
    assert_eq!(vault.home(), Some(Home::GlobalView));
}

#[test]
fn deleting_the_page_or_a_folder_above_it_clears_it() {
    let (_dir, vault) = fresh();
    vault.set_home(Some(&page("World/Dragons.md"))).unwrap();
    // Look-alikes don't count.
    vault
        .forget_home(&s(&["Worldly", "World/Dragons.md.bak", "World/Drag"]))
        .unwrap();
    assert_eq!(vault.home(), Some(page("World/Dragons.md")));
    vault.forget_home(&s(&["World"])).unwrap();
    assert_eq!(vault.home(), None);
    vault.set_home(Some(&page("A.md"))).unwrap();
    vault.forget_home(&s(&["A.md"])).unwrap();
    assert_eq!(vault.home(), None);
}

#[test]
fn an_encrypted_vault_keeps_its_home_through_the_seam() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("Start.md"), "# Start").unwrap();
    let vault = Vault::open_with(Box::new(seal_in_place(dir.path()).unwrap())).unwrap();
    assert!(vault.encrypted().is_some());
    vault.set_favorites(&s(&["Start.md"])).unwrap();
    vault.set_home(Some(&page("Start.md"))).unwrap();
    vault
        .remap_home_many(&[r("Start.md", "Notes/Start.md")])
        .unwrap();
    assert_eq!(vault.home(), Some(page("Notes/Start.md")));
    drop(vault);
    // Nothing of it is readable on disk: no plaintext `.liber/` folder.
    assert!(!dir.path().join(".liber").exists());
    let on_disk: Vec<u8> = walk(dir.path());
    assert!(
        !on_disk
            .windows(b"Notes/Start".len())
            .any(|w| w == b"Notes/Start"),
        "the home's path is never plaintext on disk"
    );
    // Unlocked again, it is still there, and so is the other key.
    let vault = Vault::open_with(Box::new(seal_in_place(dir.path()).unwrap())).unwrap();
    assert_eq!(vault.home(), Some(page("Notes/Start.md")));
    assert_eq!(vault.favorites(), s(&["Start.md"]));
    vault.set_home(Some(&Home::GlobalView)).unwrap();
    assert_eq!(vault.home(), Some(Home::GlobalView));
    vault.forget_home(&s(&["Notes"])).unwrap();
    assert_eq!(vault.home(), Some(Home::GlobalView));
    vault.set_home(Some(&page("Notes/Start.md"))).unwrap();
    vault.forget_home(&s(&["Notes"])).unwrap();
    assert_eq!(vault.home(), None);
}

/// Every byte of every file under `root`.
fn walk(root: &std::path::Path) -> Vec<u8> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(p) = stack.pop() {
        for entry in std::fs::read_dir(&p).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.extend(std::fs::read(&path).unwrap());
            }
        }
    }
    out
}
