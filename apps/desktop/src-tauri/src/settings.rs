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

/// Editor mode remembered globally (M2a §3.2); Live Preview by default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorMode {
    #[default]
    LivePreview,
    Source,
    Split,
}

/// Colour palette (M2b §4); `Custom` derives one from `accent_color`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Palette {
    #[default]
    Lavender,
    Graphite,
    Rosewood,
    Saffron,
    Persimmon,
    Midnight,
    Sepia,
    Ink,
    Custom,
}

/// A `#rrggbb` colour, stored lower-case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct HexColor(String);

impl HexColor {
    pub fn parse(s: &str) -> Option<HexColor> {
        let ok =
            s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit());
        ok.then(|| HexColor(s.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for HexColor {
    fn default() -> HexColor {
        HexColor("#d1477a".into())
    }
}

impl TryFrom<String> for HexColor {
    type Error = String;
    fn try_from(s: String) -> Result<HexColor, String> {
        HexColor::parse(&s).ok_or_else(|| format!("not a #rrggbb colour: {s}"))
    }
}

impl From<HexColor> for String {
    fn from(c: HexColor) -> String {
        c.0
    }
}

/// Fonts bundled with the app (M2b §5): Live Preview faces, then Source faces;
/// `system-ui` / `system-mono` are the OS defaults.
pub const BUNDLED_FONTS: &[&str] = &[
    "atkinson-hyperlegible",
    "literata",
    "source-serif-4",
    "ibm-plex-sans",
    "plus-jakarta-sans",
    "system-ui",
    "jetbrains-mono",
    "ibm-plex-mono",
    "source-code-pro",
    "system-mono",
];

/// Prefix of a font installed on the computer, e.g. `system:Avenir Next`.
pub const SYSTEM_FONT_PREFIX: &str = "system:";
const MAX_FONT_CHOICE: usize = 200;

/// A bundled font id or `system:<Family Name>` (at most 200 characters, no
/// control characters).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct FontChoice(String);

impl FontChoice {
    pub fn parse(s: &str) -> Option<FontChoice> {
        let ok = if let Some(family) = s.strip_prefix(SYSTEM_FONT_PREFIX) {
            !family.trim().is_empty()
                && s.chars().count() <= MAX_FONT_CHOICE
                && !s.chars().any(char::is_control)
        } else {
            BUNDLED_FONTS.contains(&s)
        };
        ok.then(|| FontChoice(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn bundled(id: &str) -> FontChoice {
        FontChoice(id.to_string())
    }
}

impl TryFrom<String> for FontChoice {
    type Error = String;
    fn try_from(s: String) -> Result<FontChoice, String> {
        FontChoice::parse(&s).ok_or_else(|| format!("unknown font: {s}"))
    }
}

impl From<FontChoice> for String {
    fn from(c: FontChoice) -> String {
        c.0
    }
}

pub const MIN_FONT_SIZE: u8 = 13;
pub const MAX_FONT_SIZE: u8 = 20;

/// Editor text size in px, clamped to 13–20 (an out-of-range number is
/// clamped, not reset).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "u32", into = "u8")]
pub struct FontSize(u8);

impl FontSize {
    pub fn new(px: u32) -> FontSize {
        FontSize(px.clamp(u32::from(MIN_FONT_SIZE), u32::from(MAX_FONT_SIZE)) as u8)
    }

    pub fn get(self) -> u8 {
        self.0
    }
}

impl Default for FontSize {
    fn default() -> FontSize {
        FontSize(15)
    }
}

impl From<u32> for FontSize {
    fn from(px: u32) -> FontSize {
        FontSize::new(px)
    }
}

impl From<FontSize> for u8 {
    fn from(s: FontSize) -> u8 {
        s.0
    }
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
    pub editor_mode: EditorMode,
    pub palette: Palette,
    pub accent_color: HexColor,
    pub font_live_preview: FontChoice,
    pub font_source: FontChoice,
    pub font_size: FontSize,
    /// Formatting toolbar shown (M2b §6).
    pub toolbar: bool,
    /// Line numbers in the editor gutter (M2b §11, feedback round).
    pub line_numbers: bool,
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
            editor_mode: EditorMode::LivePreview,
            palette: Palette::Lavender,
            accent_color: HexColor::default(),
            font_live_preview: FontChoice::bundled("atkinson-hyperlegible"),
            font_source: FontChoice::bundled("jetbrains-mono"),
            font_size: FontSize::default(),
            toolbar: true,
            line_numbers: false,
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
    pub editor_mode: Option<EditorMode>,
    pub palette: Option<Palette>,
    pub accent_color: Option<HexColor>,
    pub font_live_preview: Option<FontChoice>,
    pub font_source: Option<FontChoice>,
    pub font_size: Option<FontSize>,
    pub toolbar: Option<bool>,
    pub line_numbers: Option<bool>,
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

/// Parses settings field by field (final review I3): a value this build does
/// not understand — e.g. a theme added by a newer version — resets only that
/// field; everything else, including unknown keys, survives. Returns the
/// settings and the names of the fields that were reset. Fails only when the
/// text is not a JSON object.
fn parse_lenient(text: &str) -> Result<(Settings, Vec<String>), serde_json::Error> {
    use serde::de::Error as _;
    use serde_json::Value;
    let Value::Object(mut map) = serde_json::from_str::<Value>(text)? else {
        return Err(serde_json::Error::custom("settings must be a JSON object"));
    };
    let mut settings = Settings::default();
    let mut reset = Vec::new();
    macro_rules! field {
        ($key:literal, $field:ident) => {
            if let Some(v) = map.remove($key) {
                match serde_json::from_value(v) {
                    Ok(x) => settings.$field = x,
                    Err(_) => reset.push($key.to_string()),
                }
            }
        };
    }
    field!("version", version);
    field!("language", language);
    field!("theme", theme);
    field!("rewriteLinks", rewrite_links);
    field!("confirmDelete", confirm_delete);
    field!("editorMode", editor_mode);
    field!("palette", palette);
    field!("accentColor", accent_color);
    field!("fontLivePreview", font_live_preview);
    field!("fontSource", font_source);
    field!("fontSize", font_size);
    field!("toolbar", toolbar);
    field!("lineNumbers", line_numbers);
    match map.remove("recentVaults") {
        None => {}
        Some(Value::Array(items)) => {
            let total = items.len();
            settings.recent_vaults = items
                .into_iter()
                .filter_map(|v| serde_json::from_value::<RecentVault>(v).ok())
                .collect();
            if settings.recent_vaults.len() < total {
                reset.push("recentVaults (some entries)".to_string());
            }
        }
        Some(_) => reset.push("recentVaults".to_string()),
    }
    settings.extra = map;
    Ok((settings, reset))
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
            Ok(text) => match parse_lenient(&text) {
                Ok((s, reset)) if reset.is_empty() => (s, None),
                Ok((s, reset)) => (
                    s,
                    Some(format!(
                        "{FILE_NAME}: unrecognised values reset to defaults: {}",
                        reset.join(", ")
                    )),
                ),
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
        if let Some(v) = patch.editor_mode {
            next.editor_mode = v;
        }
        if let Some(v) = patch.palette {
            next.palette = v;
        }
        if let Some(v) = patch.accent_color {
            next.accent_color = v;
        }
        if let Some(v) = patch.font_live_preview {
            next.font_live_preview = v;
        }
        if let Some(v) = patch.font_source {
            next.font_source = v;
        }
        if let Some(v) = patch.font_size {
            next.font_size = v;
        }
        if let Some(v) = patch.toolbar {
            next.toolbar = v;
        }
        if let Some(v) = patch.line_numbers {
            next.line_numbers = v;
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
