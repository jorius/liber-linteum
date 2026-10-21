//! Logical ↔ physical names (spec §4.3, format §14): each physical folder's listing is
//! decrypted once and cached under its logical path.

use liber_crypto::{FolderId, NameCodec, Unlocked, shorten, strip_conflict};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
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
    /// Each entry whose name won't decrypt: its physical path and why.
    pub unreadable: Vec<(PathBuf, String)>,
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

/// Shared by every reader, writer and the watcher, and never locked across disk
/// I/O or decryption: a listing is read unlocked and cached after, unless the
/// cache was invalidated meanwhile (`generation`).
#[derive(Debug, Default)]
pub(super) struct Cache {
    /// Keyed by logical folder path (`""` is the root).
    pub listings: HashMap<String, Arc<Listing>>,
    /// Physical file → (mtime_ns, size, plaintext length).
    pub lens: HashMap<PathBuf, (i128, u64, u64)>,
    /// Physical folder → its last listing's unreadable entries. Kept when the
    /// listing itself is dropped, so writes elsewhere don't hide them.
    pub unreadable: BTreeMap<PathBuf, Vec<(PathBuf, String)>>,
    /// Bumped by every invalidation, so what was read before one isn't cached after it.
    pub generation: u64,
    /// Locked: a call that took the keys just before caches nothing after.
    closed: bool,
}

impl Cache {
    /// Caches `listing`, read from the physical folder `physical` as the folder
    /// `dir` after the cache was at generation `since`; dropped if stale.
    pub fn insert(&mut self, since: u64, dir: String, physical: &Path, listing: Arc<Listing>) {
        if self.closed || since != self.generation {
            return;
        }
        self.unreadable
            .insert(physical.to_path_buf(), listing.unreadable.clone());
        self.listings.insert(dir, listing);
    }

    /// Caches a file's plaintext length, read after generation `since`.
    pub fn insert_len(&mut self, since: u64, physical: &Path, stat: (i128, u64, u64)) {
        if !self.closed && since == self.generation {
            self.lens.insert(physical.to_path_buf(), stat);
        }
    }

    /// Drops the folder `dir`'s listing after a change in it.
    pub fn drop_listing(&mut self, dir: &str) {
        self.generation += 1;
        self.listings.remove(dir);
    }

    /// Drops what the cache knows of the entry `canon` after it moved or went:
    /// its parent's listing and, for a folder, every listing under it.
    pub fn forget(&mut self, canon: &str) {
        self.drop_listing(canon.rsplit_once('/').map_or("", |(dir, _)| dir));
        let below = format!("{canon}/");
        self.listings
            .retain(|k, _| k != canon && !k.starts_with(&below));
    }

    /// Everything decrypted goes, for good (lock: a new unlock makes a new storage).
    pub fn close(&mut self) {
        *self = Cache {
            closed: true,
            ..Cache::default()
        };
    }
}

/// Name codecs to try: the current epoch's, then (mid-rotation) the retiring one's.
pub(super) fn codecs(u: &Unlocked) -> Vec<NameCodec<'_>> {
    let mut out = vec![NameCodec::new(&u.subkeys().name, u.vault_id(), u.epoch())];
    if let Some((epoch, keys)) = u.retiring() {
        out.push(NameCodec::new(&keys.name, u.vault_id(), epoch));
    }
    out
}

/// A name is used only as exactly one normal path component (E1 hand-off §5: on
/// Windows `C:x` would otherwise carry a prefix), and never with a `:`, so a vault
/// lists the same on every OS.
pub(super) fn one_component(name: &str) -> bool {
    let mut c = Path::new(name).components();
    matches!((c.next(), c.next()), (Some(Component::Normal(_)), None)) && !name.contains(':')
}

/// For a long name's side file (or a sync copy of one), which is never an entry
/// itself: the long-named entry it belongs to (`h.libern` → `h.liberl`).
pub(super) fn side_owner(on_disk: &str) -> Option<String> {
    let base = strip_conflict(on_disk).map_or_else(|| on_disk.to_string(), |c| c.original);
    Some(format!("{}.liberl", base.strip_suffix(".libern")?))
}

/// Whether the physical name `x` is the long-named entry `owner` or a sync copy
/// of it: either reads `owner`'s side file.
pub(super) fn serves(x: &str, owner: &str) -> bool {
    x == owner || strip_conflict(x).is_some_and(|c| c.original == owner)
}

/// Side files longer than this are unreadable (format §14.5: bounded before reading).
const SIDE_MAX: u64 = 2048;

/// The decrypted name and, for a folder, its id behind `on_disk` in the physical
/// folder `dir` whose id is `id`; else why not. A sync conflict copy decrypts as
/// its original, named `<stem> (conflict <label>)<.ext>`.
pub(super) fn decode(
    codecs: &[NameCodec<'_>],
    dir: &Path,
    id: &FolderId,
    on_disk: &str,
) -> Result<(String, Option<FolderId>), String> {
    let (name, folder) = match decode_exact(codecs, dir, id, on_disk) {
        Err(reason) => {
            let c = strip_conflict(on_disk).ok_or(reason.clone())?;
            let (name, folder) = decode_exact(codecs, dir, id, &c.original).map_err(|_| reason)?;
            (conflict_name(&name, &c.label, folder.is_none()), folder)
        }
        ok => ok?,
    };
    if !one_component(&name) {
        return Err("not a single name".into());
    }
    Ok((name, folder))
}

/// `decode` without conflict suffixes: the kind comes from the encoded name
/// (a file's ends in `.libere`).
fn decode_exact(
    codecs: &[NameCodec<'_>],
    dir: &Path,
    id: &FolderId,
    on_disk: &str,
) -> Result<(String, Option<FolderId>), String> {
    let encoded = match on_disk.strip_suffix(".liberl") {
        Some(_) => read_side(dir, on_disk)?,
        None => on_disk.to_string(),
    };
    if encoded.ends_with(".libere") {
        first_ok(codecs, |c| c.decrypt_file(id, &encoded)).map(|name| (name, None))
    } else {
        first_ok(codecs, |c| c.decrypt_folder(id, &encoded)).map(|(fid, name)| (name, Some(fid)))
    }
}

/// The encoded name in `on_disk`'s side file, which must hash to `on_disk` (format §14.5).
fn read_side(dir: &Path, on_disk: &str) -> Result<String, String> {
    let side = side_file(&dir.join(on_disk)).ok_or("not a long name")?;
    // Never follow a link.
    if !side.symlink_metadata().is_ok_and(|m| m.is_file()) {
        return Err("side file missing".into());
    }
    let mut buf = Vec::new();
    std::fs::File::open(&side)
        .and_then(|f| f.take(SIDE_MAX + 1).read_to_end(&mut buf))
        .map_err(|e| format!("side file: {e}"))?;
    if buf.len() as u64 > SIDE_MAX {
        return Err("side file too large".into());
    }
    let encoded = String::from_utf8(buf).map_err(|_| "side file is not text")?;
    if shorten(&encoded).is_none_or(|s| s.on_disk != on_disk) {
        return Err("side file does not match its entry".into());
    }
    Ok(encoded)
}

/// `n.md` → `n (conflict <label>).md`; a folder's name keeps any dot as is.
fn conflict_name(name: &str, label: &str, file: bool) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if file && i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    format!("{stem} (conflict {label}){ext}")
}

/// Reads and decrypts the physical folder `physical`, whose folder id is `id`.
pub(super) fn list(u: &Unlocked, physical: &Path, id: FolderId) -> std::io::Result<Listing> {
    let codecs = codecs(u);
    let mut listing = Listing {
        entries: HashMap::new(),
        unreadable: Vec::new(),
    };
    let mut named: HashMap<String, Vec<Entry>> = HashMap::new();
    let items = std::fs::read_dir(physical)?.collect::<std::io::Result<Vec<_>>>()?;
    let all: Vec<String> = items
        .iter()
        .filter_map(|i| i.file_name().into_string().ok())
        .collect();
    for item in items {
        let path = item.path();
        let Some(on_disk) = item.file_name().to_str().map(str::to_owned) else {
            listing.unreadable.push((path, "name is not UTF-8".into()));
            continue;
        };
        // Encoded names never start with `.`: these are OS files and in-flight temp files.
        if on_disk.starts_with('.') {
            continue;
        }
        if let Some(owner) = side_owner(&on_disk) {
            // Listed so a folder that won't go away (`NotEmpty`) explains itself.
            if !all.iter().any(|x| serves(x, &owner)) {
                listing
                    .unreadable
                    .push((path, "side file without its entry".into()));
            }
            continue;
        }
        let Ok(ft) = item.file_type() else { continue };
        let decoded = if ft.is_dir() || ft.is_file() {
            decode(&codecs, physical, &id, &on_disk).and_then(|(name, folder)| {
                (folder.is_some() == ft.is_dir())
                    .then_some((name, folder))
                    .ok_or_else(|| "a file named as a folder, or the reverse".into())
            })
        } else {
            Err("not a file or folder".into())
        };
        match decoded {
            Ok((name, folder)) => named.entry(name).or_default().push(Entry {
                physical: path,
                folder,
            }),
            Err(reason) => listing.unreadable.push((path, reason)),
        }
    }
    // Two entries with one name: neither wins, so the result doesn't depend on `read_dir` order.
    for (name, mut found) in named {
        if found.len() == 1 {
            listing.entries.insert(name, found.remove(0));
        } else {
            let reason = format!("another entry is also named {name:?}");
            for e in found {
                listing.unreadable.push((e.physical, reason.clone()));
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
    use super::{Cache, Listing, fold, one_component, side_file};
    use std::path::Path;
    use std::sync::Arc;

    #[test]
    fn a_listing_read_before_an_invalidation_or_lock_is_not_cached() {
        let empty = || {
            Arc::new(Listing {
                entries: Default::default(),
                unreadable: Vec::new(),
            })
        };
        let mut c = Cache::default();
        let since = c.generation;
        c.drop_listing("x");
        c.insert(since, "x".into(), Path::new("d/x"), empty());
        assert!(c.listings.is_empty(), "stale");
        c.insert(c.generation, "x".into(), Path::new("d/x"), empty());
        assert_eq!(c.listings.len(), 1);
        c.close();
        c.insert(c.generation, "x".into(), Path::new("d/x"), empty());
        c.insert_len(c.generation, Path::new("d/x/f"), (0, 0, 0));
        assert!(c.listings.is_empty() && c.lens.is_empty() && c.unreadable.is_empty());
    }

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
