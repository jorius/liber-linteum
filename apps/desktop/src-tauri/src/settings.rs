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

/// Colour palette (M2b §4); `Custom` is the theme in `custom_theme`.
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

/// How wide pages read by default (M4b part 2 §1); vaults and pages can
/// override it in `.liber/vault.json`.
pub use liber_vault::PageWidth;

/// How a Global View click opens the next level (M3a §5, GV-13).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlobalViewMode {
    /// The next level replaces the canvas (breadcrumb back).
    #[default]
    Drill,
    /// The next level is added beside the clicked card.
    Expand,
}

/// Where the floating action button sits (M5b §2.2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionButton {
    #[default]
    BottomRight,
    BottomLeft,
    TopRight,
}

/// Which Global View edge kinds are shown (M3a §6, GV-21); a missing key
/// means shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GlobalViewEdges {
    pub links: bool,
    pub tree: bool,
    pub manual: bool,
    /// "Links from inside folders" (GV-25).
    pub aggregated: bool,
}

impl Default for GlobalViewEdges {
    fn default() -> GlobalViewEdges {
        GlobalViewEdges {
            links: true,
            tree: true,
            manual: true,
            aggregated: true,
        }
    }
}

/// The element kinds that span the editor when a page's width is `wide`
/// (M4b part 3, wide elements §2); a missing key takes its default, and
/// keys this build does not know are kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WideElements {
    pub tables: bool,
    pub code: bool,
    /// Mermaid diagrams.
    pub diagrams: bool,
    pub images: bool,
    /// `$$` maths blocks.
    pub maths: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for WideElements {
    fn default() -> WideElements {
        WideElements {
            tables: true,
            code: false,
            diagrams: true,
            images: false,
            maths: false,
            extra: serde_json::Map::new(),
        }
    }
}

/// A theme colour (custom themes §4): `#rrggbb`, or `rgba(r,g,b,a)` (used by
/// the sidebar selection); stored lower-case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ThemeColor(String);

impl ThemeColor {
    pub fn parse(s: &str) -> Option<ThemeColor> {
        if let Some(h) = HexColor::parse(s) {
            return Some(ThemeColor(h.0));
        }
        let inner = s.strip_prefix("rgba(")?.strip_suffix(')')?;
        let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
        let [r, g, b, a] = parts.as_slice() else {
            return None;
        };
        let channel = |c: &str| {
            (1..=3).contains(&c.len())
                && c.bytes().all(|b| b.is_ascii_digit())
                && c.parse::<u8>().is_ok()
        };
        let alpha = a.parse::<f64>().is_ok_and(|v| (0.0..=1.0).contains(&v))
            && a.chars().all(|c| c.is_ascii_digit() || c == '.');
        (channel(r) && channel(g) && channel(b) && alpha)
            .then(|| ThemeColor(s.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ThemeColor {
    type Error = String;
    fn try_from(s: String) -> Result<ThemeColor, String> {
        ThemeColor::parse(&s).ok_or_else(|| format!("not a theme colour: {s}"))
    }
}

impl From<ThemeColor> for String {
    fn from(c: ThemeColor) -> String {
        c.0
    }
}

/// A custom theme's 16 colours for one mode (custom themes §2): `#rrggbb`,
/// and `rgba()` only for the sidebar selection (review I3, M11). A token this
/// build doesn't know (a newer build's) is ignored, not fatal (review M12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokens {
    pub accent: HexColor,
    pub secondary: HexColor,
    pub bg: HexColor,
    pub surface: HexColor,
    pub border: HexColor,
    pub side: HexColor,
    pub side_text: HexColor,
    pub side_sel: ThemeColor,
    pub strong: HexColor,
    pub body: HexColor,
    pub text: HexColor,
    pub muted: HexColor,
    pub contrast: HexColor,
    pub soft: HexColor,
    pub mark: HexColor,
    pub code: HexColor,
}

const THEME_TOKEN_KEYS: [&str; 16] = [
    "accent",
    "secondary",
    "bg",
    "surface",
    "border",
    "side",
    "sideText",
    "sideSel",
    "strong",
    "body",
    "text",
    "muted",
    "contrast",
    "soft",
    "mark",
    "code",
];

fn known_token_keys<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    let keys = Vec::<String>::deserialize(d)?;
    Ok(keys
        .into_iter()
        .filter(|k| THEME_TOKEN_KEYS.contains(&k.as_str()))
        .collect())
}

/// The colours not set by hand, per mode; unknown names are dropped.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeDerived {
    #[serde(deserialize_with = "known_token_keys", default)]
    pub light: Vec<String>,
    #[serde(deserialize_with = "known_token_keys", default)]
    pub dark: Vec<String>,
}

/// A theme the user built (custom themes §2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CustomThemeRaw")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub light: ThemeTokens,
    pub dark: ThemeTokens,
    #[serde(default)]
    pub derived: ThemeDerived,
    /// The accent a migrated theme was derived from (review M6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<HexColor>,
}

#[derive(Deserialize)]
struct CustomThemeRaw {
    id: String,
    name: String,
    light: ThemeTokens,
    dark: ThemeTokens,
    #[serde(default)]
    derived: ThemeDerived,
    #[serde(default)]
    seed: Option<HexColor>,
}

impl TryFrom<CustomThemeRaw> for CustomTheme {
    type Error = String;
    fn try_from(r: CustomThemeRaw) -> Result<CustomTheme, String> {
        let id_ok = (1..=64).contains(&r.id.len());
        let name_ok = !r.name.trim().is_empty() && r.name.chars().count() <= 80;
        if !(id_ok && name_ok) {
            return Err("theme id or name out of range".into());
        }
        Ok(CustomTheme {
            id: r.id,
            name: r.name,
            light: r.light,
            dark: r.dark,
            derived: r.derived,
            seed: r.seed,
        })
    }
}

/// At most this many custom themes are kept.
pub const MAX_CUSTOM_THEMES: usize = 100;

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

pub const MIN_COVER_HEIGHT: u16 = 132;
pub const MAX_COVER_HEIGHT: u16 = 600;

/// The default cover height in px for pages without their own (cover
/// resize), clamped to 132–600 (an out-of-range number is clamped, not
/// reset). Pages keep their own in `.liber/vault.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "u32", into = "u16")]
pub struct CoverHeight(u16);

impl CoverHeight {
    pub fn new(px: u32) -> CoverHeight {
        CoverHeight(px.clamp(u32::from(MIN_COVER_HEIGHT), u32::from(MAX_COVER_HEIGHT)) as u16)
    }

    pub fn get(self) -> u16 {
        self.0
    }
}

impl Default for CoverHeight {
    fn default() -> CoverHeight {
        CoverHeight(200)
    }
}

impl From<u32> for CoverHeight {
    fn from(px: u32) -> CoverHeight {
        CoverHeight::new(px)
    }
}

impl From<CoverHeight> for u16 {
    fn from(h: CoverHeight) -> u16 {
        h.0
    }
}

pub const MIN_SIDEBAR_WIDTH: u16 = 200;
pub const MAX_SIDEBAR_WIDTH: u16 = 560;

/// The sidebar's width in px (round 3 §2.1), app-wide, clamped to 200–560
/// (an out-of-range number is clamped, not reset).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "u32", into = "u16")]
pub struct SidebarWidth(u16);

impl SidebarWidth {
    pub fn new(px: u32) -> SidebarWidth {
        SidebarWidth(px.clamp(u32::from(MIN_SIDEBAR_WIDTH), u32::from(MAX_SIDEBAR_WIDTH)) as u16)
    }

    pub fn get(self) -> u16 {
        self.0
    }
}

impl Default for SidebarWidth {
    fn default() -> SidebarWidth {
        SidebarWidth(270)
    }
}

impl From<u32> for SidebarWidth {
    fn from(px: u32) -> SidebarWidth {
        SidebarWidth::new(px)
    }
}

impl From<SidebarWidth> for u16 {
    fn from(w: SidebarWidth) -> u16 {
        w.0
    }
}

/// Minutes of idle before an encrypted vault locks (spec §6.2): 1–60. A
/// stored value outside that range resets to the default with a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u8")]
pub struct AutoLockMinutes(u8);

impl AutoLockMinutes {
    pub const DEFAULT: AutoLockMinutes = AutoLockMinutes(15);

    pub fn get(self) -> u8 {
        self.0
    }
}

impl TryFrom<u32> for AutoLockMinutes {
    type Error = String;
    fn try_from(m: u32) -> Result<AutoLockMinutes, String> {
        match m {
            1..=60 => Ok(AutoLockMinutes(m as u8)),
            _ => Err(format!("auto-lock minutes must be 1–60, not {m}")),
        }
    }
}

impl From<AutoLockMinutes> for u8 {
    fn from(m: AutoLockMinutes) -> u8 {
        m.0
    }
}

/// `Some(x)` for a present key, whatever `x` is (`null` included), so a
/// patch can tell "unchanged" (absent) from "never" (`null`).
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
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
    /// The custom accent from before custom themes; dropped once it has
    /// become a theme (custom themes §2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<HexColor>,
    pub font_live_preview: FontChoice,
    pub font_source: FontChoice,
    pub font_size: FontSize,
    /// Formatting toolbar shown (M2b §6).
    pub toolbar: bool,
    /// Line numbers in the editor gutter (M2b §11, feedback round).
    pub line_numbers: bool,
    /// Global View: Drill-down or Expand in place (M3a §5).
    pub global_view_mode: GlobalViewMode,
    /// Global View: edge kinds shown (M3a §6).
    pub global_view_edges: GlobalViewEdges,
    /// Readable measure, wide elements or full width, app-wide (M4b part 2
    /// §1; `wide`: M4b part 3).
    pub page_width: PageWidth,
    /// What goes wide when a page's width is `wide` (M4b part 3).
    pub wide_elements: WideElements,
    /// Outline panel shown beside the editor (M4b part 2 §5).
    pub outline: bool,
    /// Cover band height for pages without their own (cover resize).
    pub cover_height: CoverHeight,
    /// A caption with each attachment's place on disk (M4b part 3 §8).
    pub show_attachment_paths: bool,
    /// The global Scratchpad's folder (M4c §2), canonical; `None` until the
    /// first quick note. Set only through `scratchpad_set` (a folder the user
    /// picked, or the default), never through a settings patch (§4).
    pub scratchpad_path: Option<String>,
    /// Pages save themselves as you type (M5b §6); off: only on ⌘S.
    pub auto_save: bool,
    /// The sidebar is collapsed (M5b §2.5), app-wide.
    pub sidebar_collapsed: bool,
    /// The sidebar's width (round 3 §2.1), app-wide.
    pub sidebar_width: SidebarWidth,
    /// Idle minutes before an encrypted vault locks; `None` = never (E3).
    pub auto_lock_minutes: Option<AutoLockMinutes>,
    /// Where the floating Edit / Global View / Search button sits (M5b §2.2).
    pub action_button: ActionButton,
    /// Spell checking in the editor (spell checking spec §4).
    pub spellcheck: bool,
    /// The dictionaries checked, in order; `None` = the app language's.
    pub spell_dictionaries: Option<Vec<String>>,
    /// Themes the user built (custom themes §2).
    pub custom_themes: Vec<CustomTheme>,
    /// With `palette: custom`, the id of the theme in use.
    pub custom_theme: Option<String>,
    /// Dictionaries imported from disk; changed only by the spell commands.
    pub imported_dictionaries: Vec<ImportedDictionary>,
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
            accent_color: None,
            font_live_preview: FontChoice::bundled("atkinson-hyperlegible"),
            font_source: FontChoice::bundled("jetbrains-mono"),
            font_size: FontSize::default(),
            toolbar: true,
            line_numbers: false,
            global_view_mode: GlobalViewMode::Drill,
            global_view_edges: GlobalViewEdges::default(),
            page_width: PageWidth::Readable,
            wide_elements: WideElements::default(),
            outline: false,
            cover_height: CoverHeight::default(),
            show_attachment_paths: false,
            scratchpad_path: None,
            auto_save: true,
            sidebar_collapsed: false,
            sidebar_width: SidebarWidth::default(),
            auto_lock_minutes: Some(AutoLockMinutes::DEFAULT),
            action_button: ActionButton::BottomRight,
            spellcheck: true,
            spell_dictionaries: None,
            custom_themes: Vec::new(),
            custom_theme: None,
            imported_dictionaries: Vec::new(),
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
    /// `""` drops the legacy accent.
    pub accent_color: Option<String>,
    pub font_live_preview: Option<FontChoice>,
    pub font_source: Option<FontChoice>,
    pub font_size: Option<FontSize>,
    pub toolbar: Option<bool>,
    pub line_numbers: Option<bool>,
    pub global_view_mode: Option<GlobalViewMode>,
    pub global_view_edges: Option<GlobalViewEdges>,
    pub page_width: Option<PageWidth>,
    pub wide_elements: Option<WideElements>,
    pub outline: Option<bool>,
    pub cover_height: Option<CoverHeight>,
    pub show_attachment_paths: Option<bool>,
    pub auto_save: Option<bool>,
    pub sidebar_collapsed: Option<bool>,
    pub sidebar_width: Option<SidebarWidth>,
    /// `null` = never.
    #[serde(default, deserialize_with = "present")]
    pub auto_lock_minutes: Option<Option<AutoLockMinutes>>,
    pub action_button: Option<ActionButton>,
    pub spellcheck: Option<bool>,
    pub spell_dictionaries: Option<Vec<String>>,
    pub custom_themes: Option<Vec<CustomTheme>>,
    /// The theme in use; `""` clears it.
    pub custom_theme: Option<String>,
}

/// A dictionary imported from disk; its files live in
/// `<config>/dictionaries/<folder_name(id)>/index.{aff,dic}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedDictionary {
    pub id: String,
    pub name: String,
}

/// A recent vault as shown on the welcome screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentVaultDto {
    pub path: String,
    pub name: String,
    pub opened_at: String,
    pub missing: bool,
    /// The global Scratchpad (M4c §2): shown as "Quick notes".
    pub scratchpad: bool,
    /// The vault's emoji (M5b §4), read from its `.liber/vault.json`; never
    /// for an encrypted vault (it lives inside, encrypted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// An encrypted vault (E3): shown with a lock, opened by unlocking it.
    pub encrypted: bool,
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
    field!("globalViewMode", global_view_mode);
    field!("globalViewEdges", global_view_edges);
    field!("pageWidth", page_width);
    field!("wideElements", wide_elements);
    field!("outline", outline);
    field!("coverHeight", cover_height);
    field!("showAttachmentPaths", show_attachment_paths);
    field!("scratchpadPath", scratchpad_path);
    field!("autoSave", auto_save);
    field!("sidebarCollapsed", sidebar_collapsed);
    field!("sidebarWidth", sidebar_width);
    field!("autoLockMinutes", auto_lock_minutes);
    field!("actionButton", action_button);
    field!("spellcheck", spellcheck);
    field!("spellDictionaries", spell_dictionaries);
    field!("importedDictionaries", imported_dictionaries);
    field!("customTheme", custom_theme);
    // One bad theme is dropped, not all of them (custom themes plan, focus 3).
    match map.remove("customThemes") {
        None => {}
        Some(Value::Array(items)) => {
            let total = items.len();
            settings.custom_themes = items
                .into_iter()
                .filter_map(|v| serde_json::from_value::<CustomTheme>(v).ok())
                .take(MAX_CUSTOM_THEMES)
                .collect();
            if settings.custom_themes.len() < total.min(MAX_CUSTOM_THEMES) {
                reset.push("customThemes (some entries)".to_string());
            }
        }
        Some(_) => reset.push("customThemes".to_string()),
    }
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
            next.accent_color = if v.is_empty() {
                None
            } else {
                Some(HexColor::parse(&v).ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a #rrggbb colour")
                })?)
            };
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
        if let Some(v) = patch.global_view_mode {
            next.global_view_mode = v;
        }
        if let Some(v) = patch.global_view_edges {
            next.global_view_edges = v;
        }
        if let Some(v) = patch.page_width {
            next.page_width = v;
        }
        if let Some(mut v) = patch.wide_elements {
            // Keys a newer version wrote survive a patch from this one.
            let mut extra = std::mem::take(&mut next.wide_elements.extra);
            extra.append(&mut v.extra);
            v.extra = extra;
            next.wide_elements = v;
        }
        if let Some(v) = patch.outline {
            next.outline = v;
        }
        if let Some(v) = patch.cover_height {
            next.cover_height = v;
        }
        if let Some(v) = patch.show_attachment_paths {
            next.show_attachment_paths = v;
        }
        if let Some(v) = patch.auto_save {
            next.auto_save = v;
        }
        if let Some(v) = patch.sidebar_collapsed {
            next.sidebar_collapsed = v;
        }
        if let Some(v) = patch.sidebar_width {
            next.sidebar_width = v;
        }
        if let Some(v) = patch.auto_lock_minutes {
            next.auto_lock_minutes = v;
        }
        if let Some(v) = patch.action_button {
            next.action_button = v;
        }
        if let Some(v) = patch.spellcheck {
            next.spellcheck = v;
        }
        if let Some(v) = patch.spell_dictionaries {
            next.spell_dictionaries = Some(v);
        }
        if let Some(v) = patch.custom_themes {
            // Refused, never silently cut (review M7): the UI says why.
            if v.len() > MAX_CUSTOM_THEMES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("at most {MAX_CUSTOM_THEMES} themes"),
                ));
            }
            next.custom_themes = v;
        }
        if let Some(id) = patch.custom_theme {
            next.custom_theme = (!id.is_empty()).then_some(id);
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
        let s = self.lock();
        s.recent_vaults
            .iter()
            .map(|r| {
                let root = Path::new(&r.path);
                let encrypted = liber_vault::is_encrypted_vault(root);
                RecentVaultDto {
                    path: r.path.clone(),
                    name: r.name.clone(),
                    opened_at: r.opened_at.clone(),
                    missing: !root.is_dir(),
                    scratchpad: s.scratchpad_path.as_deref() == Some(r.path.as_str()),
                    icon: (!encrypted)
                        .then(|| liber_vault::vault_icon_at(root))
                        .flatten()
                        .filter(|i| liber_markdown::is_icon(i)),
                    encrypted,
                }
            })
            .collect()
    }

    /// Stores the global Scratchpad's folder (canonical); see
    /// `scratchpad_commands` for who may call it.
    pub fn set_scratchpad_path(&self, path: Option<String>) -> std::io::Result<Settings> {
        let mut s = self.lock();
        let mut next = s.clone();
        next.scratchpad_path = path;
        self.save(&next)?;
        *s = next.clone();
        Ok(next)
    }

    /// The folder settings.json lives in (imported dictionaries go beside it).
    pub fn dir(&self) -> &Path {
        self.path.parent().expect("settings path has a parent")
    }

    /// Applies an edit no patch may make (imported dictionaries), saved atomically.
    pub fn modify(&self, edit: impl FnOnce(&mut Settings)) -> std::io::Result<Settings> {
        let mut s = self.lock();
        let mut next = s.clone();
        edit(&mut next);
        self.save(&next)?;
        *s = next.clone();
        Ok(next)
    }

    /// The global Scratchpad is the vault at `root` (canonical).
    pub fn is_scratchpad(&self, root: &Path) -> bool {
        self.lock().scratchpad_path.as_deref() == Some(root.to_string_lossy().as_ref())
    }

    /// Whether `path` is on the recent list, exactly as stored.
    pub fn is_recent(&self, path: &str) -> bool {
        self.lock().recent_vaults.iter().any(|r| r.path == path)
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
