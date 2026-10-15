//! M4b part 3 §9: links to files outside the vault. The app may show or open
//! such a file only when an indexed page links to it (the allow-list), only a
//! regular file, and never one with a hidden component — before or after
//! symlinks.

use nimw_markdown::LinkKind;
use nimw_session::{ExternalFile, SessionError, SessionEvent, VaultSession, file_url};
use nimw_vault::{VaultError, VaultPath};
use std::path::{Path, PathBuf};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

/// A temp dir whose name isn't hidden (`tempdir()` names start with `.tmp`).
fn visible_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("nimw-ext")
        .tempdir()
        .unwrap()
}

/// `base/Vault` with one page, opened; `base` holds the "outside" files.
struct World {
    base: tempfile::TempDir,
    _cache: tempfile::TempDir,
    s: VaultSession,
}

impl World {
    fn new() -> World {
        let base = visible_dir();
        std::fs::create_dir_all(base.path().join("Vault/Notes")).unwrap();
        std::fs::write(base.path().join("Vault/Notes/a.md"), "# A\n").unwrap();
        std::fs::create_dir_all(base.path().join("Pics/folder")).unwrap();
        std::fs::write(base.path().join("Pics/x.png"), b"\x89PNG").unwrap();
        std::fs::create_dir_all(base.path().join("Pics/.secret")).unwrap();
        std::fs::write(base.path().join("Pics/.secret/key.png"), b"key").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(
            &base.path().join("Vault"),
            cache.path(),
            |_: SessionEvent| {},
        )
        .unwrap();
        World {
            base,
            _cache: cache,
            s,
        }
    }

    /// The outside dir, as the OS spells it (canonical: `/private/var/…` on macOS).
    fn outside(&self, rel: &str) -> PathBuf {
        dunce::canonicalize(self.base.path()).unwrap().join(rel)
    }

    fn write(&self, text: &str) {
        let path = vp("Notes/a.md");
        let (_, hash) = self.s.vault().read_to_string(&path).unwrap();
        self.s.write_page(&path, text, hash).unwrap();
    }

    fn external(&self, kind: LinkKind, target: &str) -> Option<ExternalFile> {
        self.s
            .externals(&vp("Notes/a.md"), &[(kind, target.to_string())])
            .unwrap()
            .remove(0)
    }
}

fn s(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

#[test]
fn an_outside_file_is_listed_once_an_indexed_page_links_it() {
    let w = World::new();
    let pic = s(&w.outside("Pics/x.png"));
    // Not looked up on disk until a saved page links it (no existence
    // oracle; final review C1).
    let before = w.external(LinkKind::Embed, &pic).unwrap();
    assert_eq!(
        before,
        ExternalFile {
            path: pic.clone(),
            exists: false,
            listed: false,
            network: false,
            ask_first: false,
        }
    );
    assert!(matches!(
        w.s.external_file(&pic),
        Err(SessionError::NotPermitted(_))
    ));
    w.write(&format!("# A\n\n![[{pic}]]\n"));
    let after = w.external(LinkKind::Embed, &pic).unwrap();
    assert!(after.listed && after.exists);
    assert_eq!(w.s.external_file(&pic).unwrap(), PathBuf::from(&pic));
    // Unlinked again: refused again.
    w.write("# A\n");
    assert!(w.s.external_file(&pic).is_err());
}

#[test]
fn markdown_and_file_url_forms_are_listed_too() {
    let w = World::new();
    let pic = s(&w.outside("Pics/x.png"));
    let url = file_url(&pic);
    w.write(&format!("# A\n\n![]({url})\n"));
    assert!(w.s.external_allowed(&pic).unwrap());
    // A wiki `file:` URL is %-decoded (and keyed decoded, so it's found).
    std::fs::write(w.outside("Pics/a b.png"), b"\x89PNG").unwrap();
    let spaced = s(&w.outside("Pics/a b.png"));
    w.write(&format!("# A\n\n![[{}]]\n", file_url(&spaced)));
    assert!(
        w.s.external_allowed(&spaced).unwrap(),
        "{}",
        file_url(&spaced)
    );
    assert!(w.s.external_file(&spaced).is_ok());
}

#[test]
fn relative_links_above_the_vault_root() {
    let w = World::new();
    w.write("# A\n\n![](../../Pics/x.png)\n");
    let got = w
        .external(LinkKind::MarkdownImage, "../../Pics/x.png")
        .unwrap();
    assert_eq!(got.path, s(&w.outside("Pics/x.png")));
    assert!(got.exists && got.listed);
    // A relative link that stays inside the vault is a vault link (missing).
    assert_eq!(w.external(LinkKind::MarkdownImage, "../x.png"), None);
}

#[test]
fn vault_targets_are_not_external() {
    let w = World::new();
    assert_eq!(w.external(LinkKind::Wiki, "a"), None);
    assert_eq!(w.external(LinkKind::Wiki, "/Notes/a"), None);
    assert_eq!(w.external(LinkKind::Embed, "nowhere.png"), None);
}

#[test]
fn hidden_components_are_refused_even_when_linked() {
    let w = World::new();
    let key = s(&w.outside("Pics/.secret/key.png"));
    w.write(&format!("# A\n\n![[{key}]]\n"));
    let got = w.external(LinkKind::Embed, &key).unwrap();
    assert!(got.listed && !got.exists, "{got:?}");
    assert!(matches!(
        w.s.external_file(&key),
        Err(SessionError::NotPermitted(_))
    ));
}

#[cfg(unix)]
#[test]
fn a_symlink_into_a_hidden_folder_is_refused() {
    let w = World::new();
    let link = w.outside("Pics/innocent.png");
    std::os::unix::fs::symlink(w.outside("Pics/.secret/key.png"), &link).unwrap();
    let link = s(&link);
    w.write(&format!("# A\n\n![[{link}]]\n"));
    assert!(!w.external(LinkKind::Embed, &link).unwrap().exists);
    assert!(matches!(
        w.s.external_file(&link),
        Err(SessionError::NotPermitted(_))
    ));
}

#[test]
fn folders_and_missing_files_are_not_served() {
    let w = World::new();
    let folder = s(&w.outside("Pics/folder"));
    let missing = s(&w.outside("Pics/gone.png"));
    w.write(&format!("# A\n\n![[{folder}]] ![[{missing}]]\n"));
    assert!(!w.external(LinkKind::Embed, &folder).unwrap().exists);
    assert!(matches!(
        w.s.external_file(&folder),
        Err(SessionError::NotAFile(_))
    ));
    let gone = w.external(LinkKind::Embed, &missing).unwrap();
    assert!(gone.listed && !gone.exists);
    assert!(matches!(
        w.s.external_file(&missing),
        Err(SessionError::Vault(VaultError::NotFound(_)))
    ));
}

#[test]
fn dot_dot_is_resolved_in_the_link_and_refused_in_a_request() {
    let w = World::new();
    let pic = s(&w.outside("Pics/x.png"));
    let roundabout = s(&w.outside("Pics/folder/../x.png"));
    w.write(&format!("# A\n\n![[{roundabout}]]\n"));
    let got = w.external(LinkKind::Embed, &roundabout).unwrap();
    assert_eq!(got.path, pic, "the link's path is normalised");
    assert!(w.s.external_allowed(&pic).unwrap());
    // A request spelled with `..` is not on the list, whatever it resolves to.
    assert!(w.s.external_file(&roundabout).is_err());
    let key = format!("{}/../.secret/key.png", s(&w.outside("Pics/folder")));
    assert!(w.s.external_file(&key).is_err());
}

#[test]
fn paths_of_the_other_os_are_never_read() {
    let w = World::new();
    let other = if cfg!(windows) {
        "/Users/jose/x.png"
    } else {
        r"C:\Pics\x.png"
    };
    w.write(&format!("# A\n\n![[{other}]]\n"));
    let got = w.external(LinkKind::Embed, other).unwrap();
    assert_eq!(got.path, other);
    assert!(got.listed && !got.exists);
    assert!(matches!(
        w.s.external_file(other),
        Err(SessionError::Vault(VaultError::NotFound(_)))
    ));
}

#[test]
fn file_urls_for_every_form() {
    assert_eq!(
        file_url(r"D:\Docs\my file.pdf"),
        "file:///D:/Docs/my%20file.pdf"
    );
    assert_eq!(
        file_url(r"\\server\share\x #1.pdf"),
        "file://server/share/x%20%231.pdf"
    );
    assert_eq!(
        file_url("/Users/jose/100% (final)?.png"),
        "file:///Users/jose/100%25%20%28final%29%3F.png"
    );
    assert_eq!(
        file_url("/Users/jose/café.png"),
        "file:///Users/jose/caf%C3%A9.png"
    );
}
