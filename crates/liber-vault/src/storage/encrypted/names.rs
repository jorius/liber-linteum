//! Logical ↔ physical names (spec §4.3, format §14): each physical folder's listing is
//! decrypted once and cached under its logical path.

use liber_crypto::{FolderId, NameCodec, Unlocked};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

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
        let entry = match decrypted {
            Ok((name, _)) if !one_component(&name) => Err("not a single name".to_string()),
            Ok((name, _)) if listing.entries.contains_key(&name) => {
                Err(format!("another entry is also named {name:?}"))
            }
            other => other,
        };
        match entry {
            Ok((name, folder)) => {
                listing.entries.insert(
                    name,
                    Entry {
                        physical: path,
                        folder,
                    },
                );
            }
            Err(reason) => listing.unreadable.push(format!(
                "{}: couldn't read the name ({reason})",
                path.display()
            )),
        }
    }
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
    use super::one_component;

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
