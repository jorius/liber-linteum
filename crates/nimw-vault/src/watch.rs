use crate::error::{Result, VaultError};
use crate::is_hidden_name;
use crate::path::VaultPath;
use crate::vault::Vault;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

/// Debounce window for file-system events (arch §4.1).
pub const DEBOUNCE: Duration = Duration::from_millis(200);

/// Longest a batch may keep growing under a continuous stream of events.
const MAX_BATCH_WAIT: Duration = Duration::from_secs(2);

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

/// Active watch; dropping it stops watching (the batching thread ends when
/// the backend watcher, and with it the event sender, is dropped).
pub struct Watcher {
    _watcher: RecommendedWatcher,
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Watcher")
    }
}

impl Vault {
    /// Watches the vault recursively. `callback` receives one batch per debounce
    /// tick (sorted, de-duplicated); hidden, excluded and outside paths are
    /// dropped. Backend errors, "rescan needed" signals (lost events, e.g. an
    /// inotify queue overflow) and events on the vault root become `Overflow`.
    ///
    /// The debouncing is done here rather than with a debouncer crate because
    /// `notify-debouncer-full` cancels macOS deletes and `notify-debouncer-mini`
    /// drops path-less rescan signals (final review I4).
    pub fn watch<F>(&self, callback: F) -> Result<Watcher>
    where
        F: Fn(Vec<WatchEvent>) + Send + 'static,
    {
        let filter = PathFilter {
            root: self.root.clone(),
            excludes: self.excludes.clone(),
        };
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| VaultError::Watch(e.to_string()))?;
        watcher
            .watch(&self.root, RecursiveMode::Recursive)
            .map_err(|e| VaultError::Watch(e.to_string()))?;
        std::thread::Builder::new()
            .name("nimw-watch".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let started = Instant::now();
                    let mut last = started;
                    let mut raw = vec![first];
                    let mut closed = false;
                    loop {
                        let wait = (last + DEBOUNCE).saturating_duration_since(Instant::now());
                        match rx.recv_timeout(wait) {
                            Ok(ev) => {
                                raw.push(ev);
                                last = Instant::now();
                                if last - started >= MAX_BATCH_WAIT {
                                    break;
                                }
                            }
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => {
                                closed = true;
                                break;
                            }
                        }
                    }
                    let batch = filter.translate(raw);
                    if !batch.is_empty() {
                        callback(batch);
                    }
                    if closed {
                        return;
                    }
                }
            })
            .map_err(|e| VaultError::Watch(e.to_string()))?;
        Ok(Watcher { _watcher: watcher })
    }
}

struct PathFilter {
    root: PathBuf,
    excludes: globset::GlobSet,
}

impl PathFilter {
    fn translate(&self, raw: Vec<notify::Result<Event>>) -> Vec<WatchEvent> {
        let mut out: Vec<WatchEvent> = Vec::new();
        for res in raw {
            let event = match res {
                Ok(event) => event,
                Err(_) => return vec![WatchEvent::Overflow],
            };
            if event.need_rescan() {
                return vec![WatchEvent::Overflow];
            }
            for p in &event.paths {
                if self.is_root(p) {
                    return vec![WatchEvent::Overflow];
                }
                if let Some(path) = self.visible(p) {
                    out.push(if p.exists() {
                        WatchEvent::Changed(path)
                    } else {
                        WatchEvent::Removed(path)
                    });
                }
            }
        }
        out.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
        out.dedup();
        out
    }

    fn is_root(&self, p: &Path) -> bool {
        dunce::canonicalize(p).is_ok_and(|c| c == self.root)
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, Flag};
    use notify::{Event, EventKind};

    fn filter(root: &Path) -> PathFilter {
        PathFilter {
            root: dunce::canonicalize(root).unwrap(),
            excludes: globset::GlobSet::empty(),
        }
    }

    /// Final review I4: a backend "rescan needed" signal (events were lost, no
    /// paths) must become `Overflow`, never be dropped.
    #[test]
    fn vlt_04_rescan_flag_becomes_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let f = filter(dir.path());
        let rescan = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(f.translate(vec![Ok(rescan)]), vec![WatchEvent::Overflow]);
        assert_eq!(
            f.translate(vec![Err(notify::Error::generic("queue overflow"))]),
            vec![WatchEvent::Overflow]
        );
    }

    /// An event on the vault root itself means "something in here changed"
    /// (e.g. FSEvents must-scan-subdirs): rescan.
    #[test]
    fn vlt_04_root_event_becomes_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let f = filter(dir.path());
        let root_ev = Event::new(EventKind::Create(CreateKind::Any)).add_path(f.root.clone());
        assert_eq!(f.translate(vec![Ok(root_ev)]), vec![WatchEvent::Overflow]);
    }

    #[test]
    fn vlt_04_file_events_are_classified_by_disk_state() {
        let dir = tempfile::tempdir().unwrap();
        let f = filter(dir.path());
        std::fs::write(f.root.join("a.md"), "x").unwrap();
        let ev =
            |p: &str| Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(f.root.join(p)));
        assert_eq!(
            f.translate(vec![
                ev("a.md"),
                ev("gone.md"),
                ev("a.md"),
                ev(".hidden/x.md")
            ]),
            vec![
                WatchEvent::Changed(VaultPath::new("a.md").unwrap()),
                WatchEvent::Removed(VaultPath::new("gone.md").unwrap()),
            ]
        );
    }
}
