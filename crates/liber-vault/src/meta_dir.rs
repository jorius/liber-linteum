//! The vault's own folder of settings, and its one-time move from the name
//! it had before the rename to Liber Linteum. The old folder is renamed in
//! place: never copied, merged or deleted.

use std::path::Path;

/// The vault's settings folder (vault.json, trash.json, archive.json, …).
pub const META_DIR: &str = ".liber";
/// Its name before the rename (Notes In My Way).
pub const LEGACY_META_DIR: &str = ".nimw";

/// Moves `root/.nimw` to `root/.liber` when only the old folder exists. A
/// failed move (read-only media) or a vault holding both leaves everything as
/// it is and says so in `warnings`; a vault with neither gets nothing (VLT-02).
pub(crate) fn migrate(root: &Path, warnings: &mut Vec<String>) {
    let new = root.join(META_DIR);
    let old = root.join(LEGACY_META_DIR);
    if new.is_dir() {
        if old.is_dir() {
            warnings.push(format!(
                "{LEGACY_META_DIR} and {META_DIR} both exist: using {META_DIR}, {LEGACY_META_DIR} left untouched"
            ));
        }
    } else if old.is_dir()
        && let Err(e) = std::fs::rename(&old, &new)
    {
        warnings.push(format!(
            "{LEGACY_META_DIR} could not become {META_DIR} ({e}); it moves on the next writable open"
        ));
    }
}
