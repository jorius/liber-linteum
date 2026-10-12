use std::time::Duration;

/// Summary of a full (incremental) index pass.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IndexReport {
    /// Visible entries in the vault (files + folders).
    pub files: usize,
    pub pages: usize,
    /// Files read and parsed (new or changed content).
    pub parsed: usize,
    /// Files whose stat matched the index and were not read.
    pub skipped_unchanged: usize,
    pub removed: usize,
    pub warnings: Vec<String>,
    pub duration: Duration,
}

/// Notifications for the UI layer (M1b forwards them as Tauri events).
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    Progress {
        done: usize,
        total: usize,
    },
    Indexed(IndexReport),
    /// External changes applied from the watcher (one event per batch).
    Changed {
        created: Vec<String>,
        modified: Vec<String>,
        removed: Vec<String>,
        renamed: Vec<(String, String)>,
    },
}

/// Result of [`crate::VaultSession::rename`] (EXP-02, EXP-04).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenameOutcome {
    /// Every file that moved (old, new); one entry per file inside a moved folder.
    pub moved: Vec<(String, String)>,
    /// Files whose links were rewritten (paths after the move).
    pub updated_files: Vec<String>,
    pub updated_links: usize,
    /// Files that could not be rewritten (path, reason); the move itself succeeded.
    pub failed: Vec<(String, String)>,
}
