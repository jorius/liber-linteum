//! Per-window app state (M1b spec §2.2).

use crate::error::CommandError;
use crate::settings::SettingsStore;
use nimw_session::VaultSession;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct AppState {
    session: Mutex<Option<Arc<VaultSession>>>,
    pub settings: SettingsStore,
    /// OS cache dir; index databases live under `<cache_dir>/nimw/…`.
    pub cache_dir: PathBuf,
}

impl AppState {
    pub fn new(settings: SettingsStore, cache_dir: PathBuf) -> AppState {
        AppState {
            session: Mutex::new(None),
            settings,
            cache_dir,
        }
    }

    /// The open vault, or `noVault`.
    pub fn session(&self) -> Result<Arc<VaultSession>, CommandError> {
        self.slot().clone().ok_or_else(CommandError::no_vault)
    }

    /// Replaces the open vault (dropping the previous session stops its watcher).
    pub fn set_session(&self, session: Option<Arc<VaultSession>>) {
        let old = std::mem::replace(&mut *self.slot(), session);
        if let Some(old) = old {
            old.stop_watching();
        }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<VaultSession>>> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }
}
