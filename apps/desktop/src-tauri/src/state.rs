//! Per-window app state (M1b spec §2.2).

use crate::decrypted_copies::DecryptedCopies;
use crate::drops::DropGrants;
use crate::error::CommandError;
use crate::settings::SettingsStore;
use liber_session::VaultSession;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

/// Chooses a cover file (M2c §7.4). Tests replace the native dialog with this.
pub type CoverPicker = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// Chooses files for the Attach button (M4b part 3 §7). Tests replace the
/// native dialog with this.
pub type FilePicker = Arc<dyn Fn() -> Vec<PathBuf> + Send + Sync>;

/// Opens a file in its default app. Tests replace the OS opener with this.
pub type Opener = Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>;

/// Where a merged copy of an encrypted vault's header goes.
pub type Discard = fn(&Path) -> std::io::Result<()>;

pub struct AppState {
    session: Mutex<Option<Arc<VaultSession>>>,
    pub settings: SettingsStore,
    /// OS cache dir; index databases live under `<cache_dir>/liber/…`.
    pub cache_dir: PathBuf,
    /// Paths the OS dropped onto the window, importable once (M2c §8).
    drop_grants: Mutex<DropGrants>,
    cover_picker: Mutex<Option<CoverPicker>>,
    file_picker: Mutex<Option<FilePicker>>,
    /// The open vault's root when it opened as the global Scratchpad; kept
    /// for the session, so Change… doesn't turn it into a vault (M4c final
    /// review M9).
    scratchpad_root: Mutex<Option<PathBuf>>,
    /// Plaintext copies of an encrypted vault's attachments (spec §5.5).
    pub copies: DecryptedCopies,
    opener: Mutex<Option<Opener>>,
    pub discard_header_copy: Discard,
}

impl AppState {
    /// The app's state: decrypted copies under the OS temp folder, merged
    /// header copies to the OS trash.
    pub fn new(settings: SettingsStore, cache_dir: PathBuf) -> AppState {
        let copies = DecryptedCopies::new(&std::env::temp_dir());
        AppState::with(settings, cache_dir, copies, liber_vault::trash_header_copy)
    }

    /// Tests (which pass their own dirs): decrypted copies under the cache
    /// dir, and merged header copies deleted, never sent to the OS trash.
    pub fn for_tests(settings: SettingsStore, cache_dir: PathBuf) -> AppState {
        let copies = DecryptedCopies::new(&cache_dir);
        AppState::with(settings, cache_dir, copies, |p| std::fs::remove_file(p)) // seam: outside (a test's header copy)
    }

    fn with(
        settings: SettingsStore,
        cache_dir: PathBuf,
        copies: DecryptedCopies,
        discard_header_copy: Discard,
    ) -> AppState {
        AppState {
            copies,
            opener: Mutex::new(None),
            discard_header_copy,
            session: Mutex::new(None),
            scratchpad_root: Mutex::new(None),
            settings,
            cache_dir,
            drop_grants: Mutex::new(DropGrants::default()),
            cover_picker: Mutex::new(None),
            file_picker: Mutex::new(None),
        }
    }

    /// Records paths from a native file drop.
    pub fn grant_drops(&self, paths: &[PathBuf]) {
        lock(&self.drop_grants).grant(paths, Instant::now());
    }

    /// Uses up the grant for `path`; `false` if no recent drop granted it.
    pub fn take_drop_grant(&self, path: &Path) -> bool {
        lock(&self.drop_grants).take(path, Instant::now())
    }

    /// Replaces the native cover dialog (tests); `None` restores it.
    pub fn set_cover_picker(&self, picker: Option<CoverPicker>) {
        *lock(&self.cover_picker) = picker;
    }

    pub fn cover_picker(&self) -> Option<CoverPicker> {
        lock(&self.cover_picker).clone()
    }

    /// Replaces the Attach button's file dialog (tests); `None` restores it.
    pub fn set_file_picker(&self, picker: Option<FilePicker>) {
        *lock(&self.file_picker) = picker;
    }

    pub fn file_picker(&self) -> Option<FilePicker> {
        lock(&self.file_picker).clone()
    }

    /// Replaces the OS opener for decrypted copies (tests); `None` restores it.
    pub fn set_opener(&self, opener: Option<Opener>) {
        *lock(&self.opener) = opener;
    }

    pub fn opener(&self) -> Option<Opener> {
        lock(&self.opener).clone()
    }

    /// The open vault, or `noVault`.
    pub fn session(&self) -> Result<Arc<VaultSession>, CommandError> {
        self.slot().clone().ok_or_else(CommandError::no_vault)
    }

    /// Replaces the open vault (dropping the previous session stops its
    /// watcher). An encrypted vault is locked, whoever else still holds it,
    /// and its decrypted copies go with it: on lock, on close, or when
    /// another vault opens (spec §5.5, review M4).
    pub fn set_session(&self, session: Option<Arc<VaultSession>>) {
        let old = std::mem::replace(&mut *self.slot(), session);
        if let Some(old) = old {
            old.stop_watching();
            if old.vault().encrypted().is_some() {
                old.lock();
                self.copies.wipe();
            }
        }
    }

    /// Records whether the vault at `root`, just opened, is the Scratchpad.
    pub fn set_scratchpad_root(&self, root: Option<PathBuf>) {
        *lock(&self.scratchpad_root) = root;
    }

    /// The vault at `root` opened as the Scratchpad.
    pub fn opened_as_scratchpad(&self, root: &Path) -> bool {
        lock(&self.scratchpad_root).as_deref() == Some(root)
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<VaultSession>>> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
