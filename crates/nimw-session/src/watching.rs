use crate::error::Result;
use crate::events::SessionEvent;
use crate::session::{Loaded, VaultSession, folder_row, unchanged, write_loaded};
use nimw_index::FileKind;
use nimw_markdown::link_key;
use nimw_vault::{EntryKind, VaultPath, WatchEvent};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

impl VaultSession {
    /// Starts applying external changes (VLT-04). The watcher holds only a weak
    /// reference, so dropping the last `Arc` stops it.
    pub fn start_watching(self: &Arc<Self>) -> Result<()> {
        let weak = Arc::downgrade(self);
        let watcher = self.vault.watch(move |batch| {
            if let Some(session) = weak.upgrade()
                && let Err(e) = session.apply(batch)
            {
                session.emit_warning(e.to_string());
            }
        })?;
        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
        Ok(())
    }

    pub fn stop_watching(&self) {
        self.watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }

    fn emit_warning(&self, message: String) {
        self.emit(SessionEvent::Indexed(crate::events::IndexReport {
            warnings: vec![message],
            ..Default::default()
        }));
    }

    /// Applies one watcher batch (spec §6.5). Paths are re-checked on disk and
    /// their parent folders reconciled, because some backends drop events
    /// (e.g. the old name of a rename on macOS). A change whose stat matches the
    /// index — including the session's own writes, which update the index
    /// synchronously — is a no-op and is not reported.
    pub fn apply(&self, events: Vec<WatchEvent>) -> Result<()> {
        if events.contains(&WatchEvent::Overflow) {
            let (_, changes) = self.reindex_all()?;
            self.emit_changed(
                changes.created,
                changes.modified,
                changes.removed,
                Vec::new(),
            );
            return Ok(());
        }
        let stats = self.index().stats()?;
        let mut dirty: BTreeSet<VaultPath> = BTreeSet::new();
        for ev in &events {
            if let WatchEvent::Changed(p) | WatchEvent::Removed(p) = ev {
                dirty.insert(p.clone());
            }
        }
        let parents: BTreeSet<VaultPath> = dirty.iter().filter_map(VaultPath::parent).collect();
        for dir in parents {
            let Ok(on_disk) = self.vault.list_dir(&dir) else {
                continue;
            };
            let disk: BTreeSet<String> = on_disk.iter().map(|e| e.path.to_string()).collect();
            dirty.extend(
                on_disk
                    .into_iter()
                    .map(|e| e.path)
                    .filter(|p| !stats.contains_key(p.as_str())),
            );
            for indexed in stats.keys() {
                let child_of_dir = match indexed.rfind('/') {
                    Some(i) => &indexed[..i] == dir.as_str(),
                    None => dir.is_root(),
                };
                if child_of_dir
                    && !disk.contains(indexed)
                    && let Ok(p) = VaultPath::new(indexed)
                {
                    dirty.insert(p);
                }
            }
        }

        let mut removed: Vec<String> = Vec::new();
        let mut folders = Vec::new();
        let mut loaded: Vec<(Loaded, bool)> = Vec::new();
        let mut warnings = Vec::new();
        for path in dirty {
            let old = stats.get(path.as_str());
            match (self.vault.stat(&path)?, old) {
                (None, Some(_)) => removed.push(path.to_string()),
                (None, None) => {}
                (Some(entry), old) if entry.kind == EntryKind::Dir => {
                    if old.is_none_or(|s| s.kind != FileKind::Folder) {
                        folders.push(folder_row(&entry));
                        for child in self.vault.scan_from(&path)?.entries {
                            if child.kind == EntryKind::Dir {
                                folders.push(folder_row(&child));
                            } else if let Some(l) = self.load(&child, None, &mut warnings) {
                                loaded.push((l, true));
                            }
                        }
                    }
                }
                (Some(entry), Some(old)) if unchanged(old, &entry) => {}
                (Some(entry), old) => {
                    if let Some(l) =
                        self.load(&entry, old.and_then(|s| s.hash.as_deref()), &mut warnings)
                    {
                        loaded.push((l, old.is_none()));
                    }
                }
            }
        }

        // A removed file and a new file with the same content hash is a rename
        // made by another program: move the index rows, do not rewrite links.
        let mut renamed: Vec<(String, String)> = Vec::new();
        let mut by_hash: HashMap<&str, &str> = HashMap::new();
        for p in &removed {
            if let Some(h) = stats.get(p).and_then(|s| s.hash.as_deref()) {
                by_hash.entry(h).or_insert(p);
            }
        }
        for (l, is_new) in &loaded {
            if let (true, Loaded::Page(row, _) | Loaded::Attachment(row)) = (is_new, l)
                && let Some(from) = row.hash.as_deref().and_then(|h| by_hash.remove(h))
            {
                renamed.push((from.to_string(), row.path.clone()));
            }
        }
        removed.retain(|p| !renamed.iter().any(|(from, _)| from == p));

        let mut created = Vec::new();
        let mut modified = Vec::new();
        for (l, is_new) in &loaded {
            let (Loaded::Page(row, _) | Loaded::Attachment(row)) = l else {
                continue;
            };
            if renamed.iter().any(|(_, to)| to == &row.path) {
                continue;
            }
            if *is_new {
                created.push(row.path.clone());
            } else {
                modified.push(row.path.clone());
            }
        }

        let mut index = self.index();
        index.transaction(|tx| {
            for (from, to) in &renamed {
                tx.rename(from, to)?;
            }
            for p in &removed {
                tx.remove(p)?;
            }
            for f in &folders {
                tx.upsert_file(f)?;
            }
            for (l, _) in &loaded {
                write_loaded(tx, l)?;
            }
            Ok(())
        })?;
        let files = index.file_set()?;
        let keys: Vec<String> = created
            .iter()
            .chain(&removed)
            .chain(renamed.iter().flat_map(|(a, b)| [a, b]))
            .map(|p| link_key(p))
            .collect();
        index.resolve_affected(&files, &keys)?;
        for p in created
            .iter()
            .chain(&modified)
            .chain(renamed.iter().map(|(_, to)| to))
        {
            index.resolve_from(&files, p)?;
        }
        drop(index);
        for w in warnings {
            self.emit_warning(w);
        }
        self.emit_changed(created, modified, removed, renamed);
        Ok(())
    }

    fn emit_changed(
        &self,
        created: Vec<String>,
        modified: Vec<String>,
        removed: Vec<String>,
        renamed: Vec<(String, String)>,
    ) {
        if created.is_empty() && modified.is_empty() && removed.is_empty() && renamed.is_empty() {
            return;
        }
        self.emit(SessionEvent::Changed {
            created,
            modified,
            removed,
            renamed,
        });
    }
}
