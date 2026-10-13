//! App settings persisted in `<app_config_dir>/settings.json` (M1b spec §2.3).
//! Loading never writes; saving is atomic. Keys written by a newer app version
//! are kept on save.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const SETTINGS_VERSION: u32 = 1;
pub const MAX_RECENT: usize = 10;
const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    /// `None` = follow the OS (Q-I18N-1).
    pub language: Option<String>,
    pub theme: Theme,
    pub rewrite_links: bool,
    pub confirm_delete: bool,
    pub recent_vaults: Vec<RecentVault>,
    /// Keys this build does not know (written by a newer version); kept on save.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            version: SETTINGS_VERSION,
            language: None,
            theme: Theme::System,
            rewrite_links: true,
            confirm_delete: true,
            recent_vaults: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// Partial update from the UI. `language: "system"` means follow the OS.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub language: Option<String>,
    pub theme: Option<Theme>,
    pub rewrite_links: Option<bool>,
    pub confirm_delete: Option<bool>,
}

/// A recent vault as shown on the welcome screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVaultDto {
    pub path: String,
    pub name: String,
    pub opened_at: String,
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingsDto {
    pub settings: Settings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
    warning: Mutex<Option<String>>,
}

impl SettingsStore {
    /// Reads `dir/settings.json`. Missing → defaults. Unreadable or invalid →
    /// defaults, a warning, and a one-time copy at `settings.json.bad`; the bad
    /// file itself is left until the next successful save.
    pub fn load(dir: &Path) -> SettingsStore {
        let path = dir.join(FILE_NAME);
        let (settings, warning) = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(s) => (s, None),
                Err(e) => {
                    let bad = dir.join(format!("{FILE_NAME}.bad"));
                    if !bad.exists() {
                        let _ = std::fs::write(&bad, &text);
                    }
                    (
                        Settings::default(),
                        Some(format!(
                            "{FILE_NAME} could not be read ({e}); using defaults"
                        )),
                    )
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Settings::default(), None),
            Err(e) => (
                Settings::default(),
                Some(format!(
                    "{FILE_NAME} could not be read ({e}); using defaults"
                )),
            ),
        };
        SettingsStore {
            path,
            inner: Mutex::new(settings),
            warning: Mutex::new(warning),
        }
    }

    pub fn get(&self) -> (Settings, Option<String>) {
        (
            self.lock().clone(),
            self.warning
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        )
    }

    pub fn dto(&self) -> SettingsDto {
        let (settings, warning) = self.get();
        SettingsDto { settings, warning }
    }

    pub fn update(&self, patch: SettingsPatch) -> std::io::Result<Settings> {
        let mut s = self.lock();
        let mut next = s.clone();
        if let Some(lang) = patch.language {
            next.language = (lang != "system").then_some(lang);
        }
        if let Some(theme) = patch.theme {
            next.theme = theme;
        }
        if let Some(v) = patch.rewrite_links {
            next.rewrite_links = v;
        }
        if let Some(v) = patch.confirm_delete {
            next.confirm_delete = v;
        }
        self.save(&next)?;
        *s = next.clone();
        Ok(next)
    }

    /// Records `root` (canonical) as most recently opened.
    pub fn push_recent(&self, root: &Path, name: &str) -> std::io::Result<()> {
        let mut s = self.lock();
        let mut next = s.clone();
        let path = root.to_string_lossy().into_owned();
        next.recent_vaults.retain(|r| r.path != path);
        next.recent_vaults.insert(
            0,
            RecentVault {
                path,
                name: name.to_string(),
                opened_at: rfc3339_utc(now_secs()),
            },
        );
        next.recent_vaults.truncate(MAX_RECENT);
        self.save(&next)?;
        *s = next;
        Ok(())
    }

    pub fn recent(&self) -> Vec<RecentVaultDto> {
        self.lock()
            .recent_vaults
            .iter()
            .map(|r| RecentVaultDto {
                path: r.path.clone(),
                name: r.name.clone(),
                opened_at: r.opened_at.clone(),
                missing: !Path::new(&r.path).is_dir(),
            })
            .collect()
    }

    pub fn forget(&self, path: &str) -> std::io::Result<()> {
        let mut s = self.lock();
        let mut next = s.clone();
        next.recent_vaults.retain(|r| r.path != path);
        self.save(&next)?;
        *s = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Atomic write: temp file in the same folder → fsync → rename.
    fn save(&self, settings: &Settings) -> std::io::Result<()> {
        let dir = self.path.parent().expect("settings path has a parent");
        std::fs::create_dir_all(dir)?;
        let mut out = settings.clone();
        out.version = out.version.max(SETTINGS_VERSION);
        let json = serde_json::to_vec_pretty(&out).map_err(std::io::Error::other)?;
        let tmp = dir.join(format!(".{FILE_NAME}.tmp-{}", std::process::id()));
        let result = (|| {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        } else {
            *self.warning.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        result
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `secs` since the Unix epoch as RFC 3339 UTC (`2026-10-12T16:00:00Z`).
pub fn rfc3339_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
