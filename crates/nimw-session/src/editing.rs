//! Editing support for the M2a editor (spec §3.1): compare-and-swap page
//! writes, conflict copies and link resolution against the live file set.

use crate::error::{Result, SessionError};
use crate::session::VaultSession;
use nimw_markdown::{LinkKind, resolve};
use nimw_vault::{Hash, VaultError, VaultPath};

impl VaultSession {
    /// Writes a page's full text if the file still has `expected` as its hash
    /// (ED-08), then re-indexes it. A changed file returns
    /// `SessionError::Vault(VaultError::Conflict { current, .. })` and nothing
    /// is written.
    pub fn write_page(&self, path: &VaultPath, text: &str, expected: Hash) -> Result<Hash> {
        let hash = self
            .vault
            .write_cas(path, text.as_bytes(), Some(expected))?;
        self.reindex_written(path, text, hash)?;
        let mut index = self.index();
        let files = index.file_set()?;
        index.resolve_from(&files, path.as_str())?;
        Ok(hash)
    }

    /// Saves `text` next to `path` as `<stem> (conflict).md`, then
    /// `(conflict 2)`, … and returns the new page's path.
    pub fn create_conflict_copy(&self, path: &VaultPath, text: &str) -> Result<VaultPath> {
        let dir = path.parent().unwrap_or_else(VaultPath::root);
        let stem = path.stem();
        for n in 1.. {
            let name = if n == 1 {
                format!("{stem} (conflict)")
            } else {
                format!("{stem} (conflict {n})")
            };
            match self.create_page(&dir, &name) {
                Ok(copy) => {
                    self.write_page(&copy, text, Hash::of(b""))?;
                    return Ok(copy);
                }
                Err(SessionError::Vault(VaultError::AlreadyExists(_))) => continue,
                Err(e) => return Err(e),
            }
        }
        unreachable!("the loop only ends by returning")
    }

    /// Resolves link targets as seen from `source` (PG-05), using the current
    /// file set — new and renamed pages are taken into account immediately.
    pub fn resolve_links(
        &self,
        source: &VaultPath,
        targets: &[(LinkKind, String)],
    ) -> Result<Vec<Option<String>>> {
        let files = self.index().file_set()?;
        Ok(targets
            .iter()
            .map(|(kind, target)| resolve(*kind, target, source.as_str(), &files))
            .collect())
    }
}
