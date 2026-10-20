//! The vault's own folder of settings, and its one-time move from the name
//! it had before the rename to Liber Linteum. The old folder is renamed in
//! place: never copied, merged or deleted.

use crate::path::VaultPath;
use crate::storage::{Follow, Kind, Storage};

/// The vault's settings folder (vault.json, trash.json, archive.json, …).
pub const META_DIR: &str = ".liber";
/// Its name before the rename (Notes In My Way).
pub const LEGACY_META_DIR: &str = ".nimw";

/// Warning codes the UI translates (rename review M6): both folders exist;
/// the move failed (followed by the error's text).
pub const WARN_BOTH: &str = "metaDir.both";
pub const WARN_UNMOVED: &str = "metaDir.unmoved:";

/// `rel` in the folder that holds the vault's settings now. While the move
/// hasn't happened (`.liber/` absent, `.nimw/` a folder: read-only media, a
/// folder held open on Windows), `.liber/…` reads and writes go to `.nimw/…`,
/// so nothing reads as empty and nothing is split across both folders.
pub(crate) fn resolve(storage: &dyn Storage, rel: &str) -> String {
    match rel.strip_prefix(META_DIR).and_then(|r| r.strip_prefix('/')) {
        Some(rest)
            if kind(storage, META_DIR, Follow::No).is_none()
                && is_dir(storage, LEGACY_META_DIR) =>
        {
            format!("{LEGACY_META_DIR}/{rest}")
        }
        _ => rel.to_string(),
    }
}

/// Moves `.nimw` to `.liber` when only the old folder exists. A
/// failed move (read-only media) or a vault holding both leaves everything as
/// it is and says so in `warnings`; a vault with neither gets nothing (VLT-02).
/// True when the settings were found in the legacy folder.
pub(crate) fn migrate(storage: &dyn Storage, warnings: &mut Vec<String>) -> bool {
    let new = is_dir(storage, META_DIR);
    let old = is_dir(storage, LEGACY_META_DIR);
    if new {
        if old {
            warnings.push(WARN_BOTH.to_string());
        }
    } else if old && let Err(e) = storage.rename(&dir_path(LEGACY_META_DIR), &dir_path(META_DIR)) {
        warnings.push(format!("{WARN_UNMOVED}{e}"));
    }
    !new && old
}

fn dir_path(name: &str) -> VaultPath {
    VaultPath::new(name).expect("a valid name")
}

/// What sits at `name`; `None` when nothing does or it can't be checked.
fn kind(storage: &dyn Storage, name: &str, follow: Follow) -> Option<Kind> {
    let meta = storage.meta(&dir_path(name), follow).ok()??;
    Some(meta.kind)
}

/// A folder, or a link to one inside the vault (as `try_update_json_object`).
fn is_dir(storage: &dyn Storage, name: &str) -> bool {
    kind(storage, name, Follow::InsideVault) == Some(Kind::Dir)
}
