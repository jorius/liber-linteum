//! Search (M5 §3): the index answers; the session says whether a full
//! re-index is running.

use crate::error::Result;
use crate::session::VaultSession;
use liber_index::{SearchPage, SearchQuery};
use std::sync::atomic::Ordering;

impl VaultSession {
    /// One page of results with facets (M5 §3, §10).
    pub fn search(&self, query: &SearchQuery) -> Result<SearchPage> {
        let mut page = self.index().search(query)?;
        page.indexing = self.indexing.load(Ordering::Relaxed);
        Ok(page)
    }
}
