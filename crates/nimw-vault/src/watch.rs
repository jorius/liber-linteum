use crate::error::{Result, VaultError};
use crate::is_hidden_name;
use crate::path::VaultPath;
use crate::vault::Vault;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Debounce window for file-system events (arch §4.1).
pub const DEBOUNCE: Duration = Duration::from_millis(200);

/// A change observed on disk (VLT-04), classified by what exists on disk *now*.
/// Backends disagree on event kinds (macOS FSEvents merges created/removed
/// flags), so the watcher only says "this path changed" or "this path is gone";
/// the session decides created-vs-modified and detects renames by content hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// The path exists and may be new or modified.
    Changed(VaultPath),
    /// The path no longer exists.
    Removed(VaultPath),
    /// Events may have been lost: rescan everything.
    Overflow,
}

/// Active watch; dropping it stops watching.
pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Watcher")
    }
}

impl Vault {
    /// Watches the vault recursively. `callback` receives one batch per debounce
    /// tick (sorted, de-duplicated); hidden, excluded and outside paths are dropped.
    pub fn watch<F>(&self, callback: F) -> Result<Watcher>
    where
        F: Fn(Vec<WatchEvent>) + Send + 'static,
    {
        let filter = PathFilter {
            root: self.root.clone(),
            excludes: self.excludes.clone(),
        };
        let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            let batch = filter.translate(result);
            if !batch.is_empty() {
                callback(batch);
            }
        })
        .map_err(|e| VaultError::Watch(e.to_string()))?;
        debouncer
            .watcher()
            .watch(&self.root, RecursiveMode::Recursive)
            .map_err(|e| VaultError::Watch(e.to_string()))?;
        Ok(Watcher {
            _debouncer: debouncer,
        })
    }
}

struct PathFilter {
    root: PathBuf,
    excludes: globset::GlobSet,
}

impl PathFilter {
    fn translate(&self, result: DebounceEventResult) -> Vec<WatchEvent> {
        let events = match result {
            Ok(events) => events,
            Err(_) => return vec![WatchEvent::Overflow],
        };
        let mut out: Vec<WatchEvent> = events
            .iter()
            .filter_map(|ev| {
                let path = self.visible(&ev.path)?;
                Some(if ev.path.exists() {
                    WatchEvent::Changed(path)
                } else {
                    WatchEvent::Removed(path)
                })
            })
            .collect();
        out.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
        out.dedup();
        out
    }

    /// Vault path for `p` unless it is outside, the root, hidden or excluded.
    fn visible(&self, p: &Path) -> Option<VaultPath> {
        let canonical_parent = p.parent().and_then(|d| dunce::canonicalize(d).ok());
        let p = match (canonical_parent, p.file_name()) {
            (Some(dir), Some(name)) => dir.join(name),
            _ => p.to_path_buf(),
        };
        let vp = VaultPath::from_fs_path(&self.root, &p).ok()?;
        if vp.is_root()
            || vp.as_str().split('/').any(is_hidden_name)
            || self.excludes.is_match(vp.as_str())
        {
            return None;
        }
        Some(vp)
    }
}
