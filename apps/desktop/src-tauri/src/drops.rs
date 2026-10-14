//! Native file drops (M2c §8). The OS tells Rust which paths were dropped; the
//! page may import those paths, each once, for two minutes. Any other path the
//! page names is refused, so a compromised page cannot copy arbitrary files
//! (e.g. `~/.ssh/…`) into the vault and read them back.

use crate::state::AppState;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{DragDropEvent, Manager, Runtime, Webview, WebviewEvent, Window, WindowEvent};

/// How long a dropped path stays importable.
pub const GRANT_TTL: Duration = Duration::from_secs(120);
/// Most grants kept; the oldest go first.
pub const MAX_GRANTS: usize = 1000;

#[derive(Debug, Default)]
pub struct DropGrants {
    entries: VecDeque<(PathBuf, Instant)>,
}

impl DropGrants {
    pub fn grant(&mut self, paths: &[PathBuf], now: Instant) {
        self.prune(now);
        for path in paths {
            self.entries.push_back((path.clone(), now));
        }
        while self.entries.len() > MAX_GRANTS {
            self.entries.pop_front();
        }
    }

    /// Uses up the grant for `path`.
    pub fn take(&mut self, path: &Path, now: Instant) -> bool {
        self.prune(now);
        match self.entries.iter().position(|(p, _)| p == path) {
            Some(i) => {
                self.entries.remove(i);
                true
            }
            None => false,
        }
    }

    fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|(_, at)| now.saturating_duration_since(*at) < GRANT_TTL);
    }
}

/// Registered with `.on_window_event` (webview windows report drops here).
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event
        && let Some(state) = window.try_state::<AppState>()
    {
        state.grant_drops(paths);
    }
}

/// Registered with `.on_webview_event` (child webviews report drops here).
pub fn on_webview_event<R: Runtime>(webview: &Webview<R>, event: &WebviewEvent) {
    if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event
        && let Some(state) = webview.try_state::<AppState>()
    {
        state.grant_drops(paths);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_expire_are_used_once_and_are_capped() {
        let t0 = Instant::now();
        let mut g = DropGrants::default();
        let a = PathBuf::from("/tmp/a.png");
        let b = PathBuf::from("/tmp/b.png");
        g.grant(&[a.clone(), b.clone()], t0);
        assert!(g.take(&a, t0 + Duration::from_secs(1)));
        assert!(!g.take(&a, t0 + Duration::from_secs(2)), "used once");
        assert!(!g.take(&b, t0 + GRANT_TTL), "expired");
        let many: Vec<PathBuf> = (0..MAX_GRANTS + 5)
            .map(|i| PathBuf::from(format!("/tmp/{i}")))
            .collect();
        g.grant(&many, t0);
        assert!(!g.take(&many[0], t0), "oldest dropped past the cap");
        assert!(g.take(&many[MAX_GRANTS + 4], t0));
    }
}
