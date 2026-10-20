//! [`EncryptedStorage`]'s watch: `notify` events on `<root>/d`, each physical
//! path translated to its logical one through the name cache. A path the cache
//! can't map becomes [`RawEvent::Overflow`], so the session rescans.

use super::names::{self, Cache, is_side};
use super::write::forget;
use super::{DATA_DIR, EncryptedStorage, Keys, load, lock};
use crate::error::{Result, VaultError};
use crate::path::VaultPath;
use crate::storage::{RawEvent, WatchGuard};
use liber_crypto::{FolderId, Unlocked};
use notify::{Event, RecursiveMode, Watcher as _};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

pub(super) fn watch(
    s: &EncryptedStorage,
    recursive: bool,
    sink: Box<dyn Fn(RawEvent) + Send>,
) -> Result<WatchGuard> {
    let t = Translate {
        data: s.root.join(DATA_DIR),
        keys: Arc::clone(&s.keys),
        cache: Arc::clone(&s.cache),
    };
    let data = t.data.clone();
    let mut watcher = notify::recommended_watcher(move |res| {
        // Delivered with no lock held.
        for ev in t.translate(res) {
            sink(ev);
        }
    })
    .map_err(|e| VaultError::Watch(e.to_string()))?;
    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher
        .watch(&data, mode)
        .map_err(|e| VaultError::Watch(e.to_string()))?;
    Ok(WatchGuard(Box::new(watcher)))
}

struct Translate {
    /// `<root>/d`, the root canonical.
    data: PathBuf,
    keys: Arc<Mutex<Option<Keys>>>,
    cache: Arc<Mutex<Cache>>,
}

impl Translate {
    /// Lost events, backend errors, a locked vault and paths the cache can't map
    /// become `Overflow`; temp and side files are dropped.
    fn translate(&self, res: notify::Result<Event>) -> Vec<RawEvent> {
        let event = match res {
            Ok(event) if !event.need_rescan() => event,
            _ => return vec![RawEvent::Overflow],
        };
        // Keys, then cache (the storage's lock order).
        let keys = lock(&self.keys);
        let Some(keys) = keys.as_ref() else {
            return vec![RawEvent::Overflow];
        };
        let mut cache = lock(&self.cache);
        let mut out: Vec<RawEvent> = Vec::new();
        for p in &event.paths {
            let ev = self.one(&keys.unlocked, &mut cache, p);
            if let Some(ev) = ev.filter(|ev| !out.contains(ev)) {
                out.push(ev);
            }
        }
        out
    }

    /// `None` for a path to drop.
    fn one(&self, u: &Unlocked, cache: &mut Cache, p: &Path) -> Option<RawEvent> {
        // As canonical as the cache's paths (`/var` vs `/private/var` on macOS).
        let p = match (
            p.parent().and_then(|d| dunce::canonicalize(d).ok()),
            p.file_name(),
        ) {
            (Some(dir), Some(name)) => dir.join(name),
            _ => p.to_path_buf(),
        };
        let Ok(rel) = p.strip_prefix(&self.data) else {
            return Some(RawEvent::Overflow);
        };
        let mut parts = Vec::new();
        for c in rel.components() {
            match c.as_os_str().to_str() {
                Some(s) if matches!(c, Component::Normal(_)) => parts.push(s),
                _ => return Some(RawEvent::Overflow),
            }
        }
        // An event on `d/` itself is one on the vault root.
        let Some(last) = parts.pop() else {
            return Some(RawEvent::Overflow);
        };
        if last.starts_with('.') || is_side(last) {
            return None;
        }
        let Some(canon) = self.logical(u, cache, &parts, last) else {
            return Some(RawEvent::Overflow);
        };
        let Ok(path) = VaultPath::new(&canon) else {
            return Some(RawEvent::Overflow);
        };
        // Reads after this event must see the change.
        forget(cache, &canon);
        Some(if p.symlink_metadata().is_ok() {
            RawEvent::Changed(path)
        } else {
            RawEvent::Removed(path)
        })
    }

    /// The canonical logical path of `<d>/<dirs…>/<last>`: each folder through
    /// its (re-read if dropped) listing, `last` by decrypting its name.
    fn logical(
        &self,
        u: &Unlocked,
        cache: &mut Cache,
        dirs: &[&str],
        last: &str,
    ) -> Option<String> {
        let mut physical = self.data.clone();
        let mut id = FolderId::ROOT;
        let mut canon = String::new();
        for part in dirs {
            let listing = load(u, cache, &canon, &physical, id).ok()??;
            physical.push(part);
            let (name, e) = listing
                .entries
                .iter()
                .find(|(_, e)| e.physical == physical)?;
            id = e.folder?;
            canon = join(&canon, name);
        }
        let (name, _) = names::decode(&names::codecs(u), &physical, &id, last).ok()?;
        Some(join(&canon, &name))
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}
