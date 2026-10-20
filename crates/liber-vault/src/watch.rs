use crate::error::{Result, VaultError};
use crate::is_hidden_path;
use crate::path::VaultPath;
use crate::storage::{RawEvent, WatchGuard};
use crate::vault::Vault;
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
    _guard: WatchGuard,
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
        self.watch_with(true, callback)
    }

    /// [`Vault::watch`] for the root folder's own entries only, never the
    /// folders below it (M4c §3: a file opened on its own watches its folder).
    pub fn watch_folder<F>(&self, callback: F) -> Result<Watcher>
    where
        F: Fn(Vec<WatchEvent>) + Send + 'static,
    {
        self.watch_with(false, callback)
    }

    fn watch_with<F>(&self, recursive: bool, callback: F) -> Result<Watcher>
    where
        F: Fn(Vec<WatchEvent>) + Send + 'static,
    {
        let excludes = self.excludes.clone();
        let (tx, rx) = mpsc::channel::<RawEvent>();
        let guard = self.storage().watch(
            recursive,
            Box::new(move |ev| {
                let _ = tx.send(ev);
            }),
        )?;
        std::thread::Builder::new()
            .name("liber-watch".into())
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
                    let batch = batch(&excludes, raw);
                    if !batch.is_empty() {
                        callback(batch);
                    }
                    if closed {
                        return;
                    }
                }
            })
            .map_err(|e| VaultError::Watch(e.to_string()))?;
        Ok(Watcher { _guard: guard })
    }
}

/// One debounced batch: `Overflow` if any event says so, else the visible
/// paths (root, hidden and excluded ones dropped), sorted and de-duplicated.
pub(crate) fn batch(excludes: &globset::GlobSet, raw: Vec<RawEvent>) -> Vec<WatchEvent> {
    let visible = |p: &VaultPath| {
        !(p.is_root() || is_hidden_path(p.as_str()) || excludes.is_match(p.as_str()))
    };
    let mut out: Vec<WatchEvent> = Vec::new();
    for ev in raw {
        match ev {
            RawEvent::Overflow => return vec![WatchEvent::Overflow],
            RawEvent::Changed(p) if visible(&p) => out.push(WatchEvent::Changed(p)),
            RawEvent::Removed(p) if visible(&p) => out.push(WatchEvent::Removed(p)),
            _ => {}
        }
    }
    out.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
    out.dedup();
    out
}
