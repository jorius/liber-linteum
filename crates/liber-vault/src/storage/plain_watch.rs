//! [`PlainStorage`](super::PlainStorage)'s watch: `notify` events on the
//! vault folder, translated to [`RawEvent`]s one OS path at a time.

use super::{RawEvent, WatchGuard};
use crate::error::{Result, VaultError};
use crate::path::VaultPath;
use notify::{Event, RecursiveMode, Watcher as _};
use std::path::{Path, PathBuf};

pub(crate) fn watch(
    root: &Path,
    recursive: bool,
    sink: Box<dyn Fn(RawEvent) + Send>,
) -> Result<WatchGuard> {
    let paths = Translate {
        root: root.to_path_buf(),
    };
    let mut watcher = notify::recommended_watcher(move |res| paths.translate(res, &*sink))
        .map_err(|e| VaultError::Watch(e.to_string()))?;
    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher
        .watch(root, mode)
        .map_err(|e| VaultError::Watch(e.to_string()))?;
    Ok(WatchGuard(Box::new(watcher)))
}

struct Translate {
    /// Canonical.
    root: PathBuf,
}

impl Translate {
    /// Backend errors, "rescan needed" signals (lost events, e.g. an inotify
    /// queue overflow) and events on the vault root become `Overflow`; other
    /// paths are classified by what exists on disk now.
    fn translate(&self, res: notify::Result<Event>, sink: &dyn Fn(RawEvent)) {
        let event = match res {
            Ok(event) if !event.need_rescan() => event,
            _ => return sink(RawEvent::Overflow),
        };
        for p in &event.paths {
            if self.is_root(p) {
                sink(RawEvent::Overflow);
            } else if let Some(path) = self.vault_path(p) {
                sink(if p.exists() {
                    RawEvent::Changed(path)
                } else {
                    RawEvent::Removed(path)
                });
            }
        }
    }

    fn is_root(&self, p: &Path) -> bool {
        dunce::canonicalize(p).is_ok_and(|c| c == self.root)
    }

    /// Vault path for `p` unless it is outside.
    fn vault_path(&self, p: &Path) -> Option<VaultPath> {
        let canonical_parent = p.parent().and_then(|d| dunce::canonicalize(d).ok());
        let p = match (canonical_parent, p.file_name()) {
            (Some(dir), Some(name)) => dir.join(name),
            _ => p.to_path_buf(),
        };
        VaultPath::from_fs_path(&self.root, &p).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::{WatchEvent, batch};
    use notify::event::{CreateKind, Flag};
    use notify::{Event, EventKind};

    fn filter(root: &Path) -> Translate {
        Translate {
            root: dunce::canonicalize(root).unwrap(),
        }
    }

    impl Translate {
        /// What `Vault::watch` delivers for these backend events.
        fn batch(&self, raw: Vec<notify::Result<Event>>) -> Vec<WatchEvent> {
            let out = std::sync::Mutex::new(Vec::new());
            for res in raw {
                self.translate(res, &|ev| out.lock().unwrap().push(ev));
            }
            batch(&globset::GlobSet::empty(), out.into_inner().unwrap())
        }
    }

    /// Final review I4: a backend "rescan needed" signal (events were lost, no
    /// paths) must become `Overflow`, never be dropped.
    #[test]
    fn vlt_04_rescan_flag_becomes_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let f = filter(dir.path());
        let rescan = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(f.batch(vec![Ok(rescan)]), vec![WatchEvent::Overflow]);
        assert_eq!(
            f.batch(vec![Err(notify::Error::generic("queue overflow"))]),
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
        assert_eq!(f.batch(vec![Ok(root_ev)]), vec![WatchEvent::Overflow]);
    }

    #[test]
    fn vlt_04_file_events_are_classified_by_disk_state() {
        let dir = tempfile::tempdir().unwrap();
        let f = filter(dir.path());
        std::fs::write(f.root.join("a.md"), "x").unwrap();
        let ev =
            |p: &str| Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(f.root.join(p)));
        assert_eq!(
            f.batch(vec![
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
