//! Logical ↔ physical names (spec §4.3, format §14): each physical folder's listing is
//! decrypted once and cached under its logical path.

use liber_crypto::{FolderId, NameCodec, Unlocked};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// One decrypted entry: `folder` is `Some(id)` for a folder.
#[derive(Debug, Clone)]
pub(super) struct Entry {
    pub physical: PathBuf,
    pub folder: Option<FolderId>,
}

/// A physical folder's decrypted listing (the folder's own physical path and
/// id are in its [`Entry`]).
#[derive(Debug)]
pub(super) struct Listing {
    pub entries: HashMap<String, Entry>,
    /// `Child::Unreadable` messages, one per entry whose name won't decrypt.
    pub unreadable: Vec<String>,
}

impl Listing {
    /// `name`, else the first (by name) entry equal to it case-insensitively: a vault
    /// behaves as a case-insensitive file system on every OS.
    pub fn find(&self, name: &str) -> Option<(&str, &Entry)> {
        if let Some((k, e)) = self.entries.get_key_value(name) {
            return Some((k, e));
        }
        let want = fold(name);
        self.entries
            .iter()
            .filter(|(k, _)| fold(k) == want)
            .min_by(|a, b| a.0.cmp(b.0))
            .map(|(k, e)| (k.as_str(), e))
    }
}

/// A name's NFC, lower-cased form (stored names are NFC: format §14.3).
fn fold(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

/// The `.libern` side file of a long-named (`.liberl`) entry (format §14.5).
pub(super) fn side_file(physical: &Path) -> Option<PathBuf> {
    (physical.extension()? == "liberl").then(|| physical.with_extension("libern"))
}

#[derive(Debug, Default)]
pub(super) struct Cache {
    /// Keyed by logical folder path (`""` is the root).
    pub listings: HashMap<String, Listing>,
    /// Physical file → (mtime_ns, size, plaintext length).
    pub lens: HashMap<PathBuf, (i128, u64, u64)>,
}

/// Name codecs to try: the current epoch's, then (mid-rotation) the retiring one's.
fn codecs(u: &Unlocked) -> Vec<NameCodec<'_>> {
    let mut out = vec![NameCodec::new(&u.subkeys().name, u.vault_id(), u.epoch())];
    if let Some((epoch, keys)) = u.retiring() {
        out.push(NameCodec::new(&keys.name, u.vault_id(), epoch));
    }
    out
}

/// A decrypted name is used only as exactly one normal path component
/// (E1 hand-off §5: on Windows `C:x` would otherwise carry a prefix).
fn one_component(name: &str) -> bool {
    let mut c = Path::new(name).components();
    matches!((c.next(), c.next()), (Some(Component::Normal(_)), None))
}

/// Reads and decrypts the physical folder `physical`, whose folder id is `id`.
pub(super) fn list(u: &Unlocked, physical: &Path, id: FolderId) -> std::io::Result<Listing> {
    let codecs = codecs(u);
    let mut listing = Listing {
        entries: HashMap::new(),
        unreadable: Vec::new(),
    };
    let unreadable = |path: &Path, reason: &str| {
        format!("{}: couldn't read the name ({reason})", path.display())
    };
    let mut named: HashMap<String, Vec<Entry>> = HashMap::new();
    for item in std::fs::read_dir(physical)? {
        let item = item?;
        let path = item.path();
        let Some(on_disk) = item.file_name().to_str().map(str::to_owned) else {
            listing
                .unreadable
                .push(format!("{}: name is not UTF-8", path.display()));
            continue;
        };
        // Encoded names never start with `.`: these are OS files and in-flight temp files.
        if on_disk.starts_with('.') {
            continue;
        }
        let Ok(ft) = item.file_type() else { continue };
        let decrypted = if ft.is_dir() {
            first_ok(&codecs, |c| c.decrypt_folder(&id, &on_disk))
                .map(|(fid, name)| (name, Some(fid)))
        } else if ft.is_file() {
            first_ok(&codecs, |c| c.decrypt_file(&id, &on_disk)).map(|name| (name, None))
        } else {
            Err("not a file or folder".to_string())
        };
        match decrypted {
            Ok((name, _)) if !one_component(&name) => listing
                .unreadable
                .push(unreadable(&path, "not a single name")),
            Ok((name, folder)) => named.entry(name).or_default().push(Entry {
                physical: path,
                folder,
            }),
            Err(reason) => listing.unreadable.push(unreadable(&path, &reason)),
        }
    }
    // Two entries with one name: neither wins, so the result doesn't depend on `read_dir` order.
    for (name, mut found) in named {
        if found.len() == 1 {
            listing.entries.insert(name, found.remove(0));
        } else {
            let reason = format!("another entry is also named {name:?}");
            for e in found {
                listing.unreadable.push(unreadable(&e.physical, &reason));
            }
        }
    }
    listing.unreadable.sort();
    Ok(listing)
}

fn first_ok<T>(
    codecs: &[NameCodec<'_>],
    f: impl Fn(&NameCodec<'_>) -> liber_crypto::Result<T>,
) -> Result<T, String> {
    let mut last = String::new();
    for c in codecs {
        match f(c) {
            Ok(v) => return Ok(v),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::{fold, one_component, side_file};
    use std::path::Path;

    #[test]
    fn fold_ignores_case_and_normal_form() {
        assert_eq!(fold("Notes"), fold("nOTES"));
        assert_eq!(fold("Cafe\u{301}"), fold("CAFÉ"));
        assert_ne!(fold("a.md"), fold("b.md"));
        assert_eq!(
            side_file(Path::new("d/abc.liberl")).unwrap(),
            Path::new("d/abc.libern")
        );
        assert!(side_file(Path::new("d/abc.libere")).is_none());
    }

    #[test]
    fn only_single_normal_components_pass() {
        assert!(one_component("note.md"));
        assert!(one_component(".liber"));
        for bad in ["", ".", "..", "a/b", "/a"] {
            assert!(!one_component(bad), "{bad:?}");
        }
        #[cfg(windows)]
        assert!(!one_component("C:x"));
    }
}
