//! Settings store (M1b spec §2.3).

use nimw_desktop::settings::{
    MAX_RECENT, Settings, SettingsPatch, SettingsStore, Theme, rfc3339_utc,
};
use std::path::Path;

fn store(dir: &Path) -> SettingsStore {
    SettingsStore::load(dir)
}

#[test]
fn missing_file_gives_defaults_and_no_warning() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let (settings, warning) = s.get();
    assert_eq!(settings, Settings::default());
    assert_eq!(settings.version, 1);
    assert_eq!(settings.language, None);
    assert_eq!(settings.theme, Theme::System);
    assert!(settings.rewrite_links && settings.confirm_delete);
    assert!(settings.recent_vaults.is_empty());
    assert!(warning.is_none());
    assert!(
        !dir.path().join("settings.json").exists(),
        "loading writes nothing"
    );
}

#[test]
fn patch_merges_saves_atomically_and_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let saved = s
        .update(SettingsPatch {
            language: Some("es".into()),
            theme: Some(Theme::Dark),
            rewrite_links: Some(false),
            confirm_delete: None,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(saved.language.as_deref(), Some("es"));
    assert_eq!(saved.theme, Theme::Dark);
    assert!(!saved.rewrite_links && saved.confirm_delete);
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(json["language"], "es");
    assert_eq!(json["theme"], "dark");
    assert_eq!(json["rewriteLinks"], false);
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n != "settings.json")
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert_eq!(store(dir.path()).get().0, saved);
    // "system" means follow the OS again.
    let back = s
        .update(SettingsPatch {
            language: Some("system".into()),
            ..SettingsPatch::default()
        })
        .unwrap();
    assert_eq!(back.language, None);
}

#[test]
fn corrupt_file_gives_defaults_a_warning_and_a_bad_copy() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), "{ not json").unwrap();
    let s = store(dir.path());
    let (settings, warning) = s.get();
    assert_eq!(settings, Settings::default());
    assert!(warning.unwrap().contains("settings.json"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("settings.json.bad")).unwrap(),
        "{ not json"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
        "{ not json",
        "the corrupt file is not overwritten until the next save"
    );
}

/// Review Focus: a settings file written by a newer app version keeps the
/// keys and version this build doesn't know about when it saves.
#[test]
fn review_focus_newer_settings_file_keeps_unknown_keys_and_version() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"version":3,"theme":"light","futureThing":{"a":1},"language":"en"}"#,
    )
    .unwrap();
    let s = store(dir.path());
    let (settings, warning) = s.get();
    assert!(warning.is_none());
    assert_eq!(settings.theme, Theme::Light);
    s.update(SettingsPatch {
        rewrite_links: Some(false),
        ..SettingsPatch::default()
    })
    .unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(json["version"], 3);
    assert_eq!(json["futureThing"]["a"], 1);
    assert_eq!(json["rewriteLinks"], false);
}

#[test]
fn recent_vaults_are_deduplicated_capped_and_flag_missing_folders() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let vaults = tempfile::tempdir().unwrap();
    for i in 0..12 {
        let v = vaults.path().join(format!("v{i}"));
        std::fs::create_dir(&v).unwrap();
        s.push_recent(&v, &format!("v{i}")).unwrap();
    }
    // Re-opening v5 moves it to the front without duplicating it.
    s.push_recent(&vaults.path().join("v5"), "v5").unwrap();
    let recent = s.recent();
    assert_eq!(recent.len(), MAX_RECENT);
    assert_eq!(recent[0].name, "v5");
    assert_eq!(recent.iter().filter(|r| r.name == "v5").count(), 1);
    assert!(recent.iter().all(|r| !r.missing));
    std::fs::remove_dir(vaults.path().join("v11")).unwrap();
    let recent = s.recent();
    assert!(recent.iter().any(|r| r.name == "v11" && r.missing));
    s.forget(&recent.iter().find(|r| r.name == "v11").unwrap().path)
        .unwrap();
    assert!(!s.recent().iter().any(|r| r.name == "v11"));
    assert_eq!(store(dir.path()).recent().len(), MAX_RECENT - 1);
}

#[test]
fn rfc3339_formats_utc_seconds() {
    assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(rfc3339_utc(1_791_820_800), "2026-10-12T16:00:00Z");
}

/// Final review I3: a newer app may write a value this build doesn't know
/// (`"theme": "sepia"`) — only that field falls back to its default; recent
/// vaults, other preferences and unknown keys survive, and the next save keeps them.
#[test]
fn review_focus_unknown_value_from_newer_version_resets_only_that_field() {
    let dir = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        format!(
            r#"{{"version":3,"theme":"sepia","language":"es","confirmDelete":false,
               "recentVaults":[{{"path":{p:?},"name":"Old","openedAt":"2026-01-01T00:00:00Z"}},
                               {{"path":7}}],
               "futureThing":1}}"#,
            p = vault.path().to_string_lossy()
        ),
    )
    .unwrap();
    let s = store(dir.path());
    let (settings, warning) = s.get();
    assert_eq!(settings.theme, Theme::System, "unknown theme → default");
    assert_eq!(settings.language.as_deref(), Some("es"));
    assert!(!settings.confirm_delete);
    assert_eq!(settings.recent_vaults.len(), 1, "valid recent entries kept");
    assert_eq!(settings.version, 3);
    let w = warning.expect("a warning names what was reset");
    assert!(w.contains("theme"), "{w}");

    s.push_recent(vault.path(), "Old").unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(saved["futureThing"], 1);
    assert_eq!(saved["version"], 3);
    assert_eq!(saved["language"], "es");
    assert_eq!(saved["recentVaults"].as_array().unwrap().len(), 1);
}

/// M2a §3.2: the last-used editor mode is a global setting.
#[test]
fn ed_01_editor_mode_defaults_to_live_preview_and_persists() {
    use nimw_desktop::settings::EditorMode;
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    assert_eq!(s.get().0.editor_mode, EditorMode::LivePreview);
    s.update(SettingsPatch {
        editor_mode: Some(EditorMode::Split),
        ..Default::default()
    })
    .unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(saved["editorMode"], "split");
    assert_eq!(store(dir.path()).get().0.editor_mode, EditorMode::Split);
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"editorMode":"zen","theme":"dark"}"#,
    )
    .unwrap();
    let (s, warning) = store(dir.path()).get();
    assert_eq!(s.editor_mode, EditorMode::LivePreview);
    assert_eq!(s.theme, Theme::Dark);
    assert!(warning.unwrap().contains("editorMode"));
}

/// M2b §7: appearance and editor settings, each with a default, persisted,
/// and reset on its own when a value can't be understood.
#[test]
fn m2b_appearance_and_editor_settings_default_and_persist() {
    use nimw_desktop::settings::{FontChoice, FontSize, HexColor, Palette};
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let d = s.get().0;
    assert_eq!(d.palette, Palette::Lavender);
    assert_eq!(d.accent_color, HexColor::parse("#d1477a").unwrap());
    assert_eq!(d.font_live_preview.as_str(), "atkinson-hyperlegible");
    assert_eq!(d.font_source.as_str(), "jetbrains-mono");
    assert_eq!(d.font_size, FontSize::new(15));
    assert!(d.toolbar);
    assert!(!d.line_numbers, "line numbers are off by default");
    s.update(SettingsPatch {
        palette: Some(Palette::Custom),
        accent_color: Some(HexColor::parse("#2AA198").unwrap()),
        font_live_preview: Some(FontChoice::parse("system:Avenir Next").unwrap()),
        font_source: Some(FontChoice::parse("ibm-plex-mono").unwrap()),
        font_size: Some(FontSize::new(18)),
        toolbar: Some(false),
        line_numbers: Some(true),
        ..Default::default()
    })
    .unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(saved["palette"], "custom");
    assert_eq!(saved["accentColor"], "#2aa198", "stored lower-case");
    assert_eq!(saved["fontLivePreview"], "system:Avenir Next");
    assert_eq!(saved["fontSource"], "ibm-plex-mono");
    assert_eq!(saved["fontSize"], 18);
    assert_eq!(saved["toolbar"], false);
    assert_eq!(saved["lineNumbers"], true);
    assert_eq!(store(dir.path()).get().0, s.get().0, "round-trips");
}

#[test]
fn m2b_each_new_setting_is_reset_on_its_own() {
    use nimw_desktop::settings::{FontSize, Palette};
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"palette":"neon","accentColor":"red","fontLivePreview":"comic-sans",
            "fontSource":"system:","fontSize":"big","toolbar":"yes","lineNumbers":1,"theme":"dark"}"#,
    )
    .unwrap();
    let (s, warning) = store(dir.path()).get();
    assert_eq!(s.palette, Palette::Lavender);
    assert_eq!(s.accent_color.as_str(), "#d1477a");
    assert_eq!(s.font_live_preview.as_str(), "atkinson-hyperlegible");
    assert_eq!(s.font_source.as_str(), "jetbrains-mono");
    assert_eq!(s.font_size, FontSize::new(15));
    assert!(s.toolbar);
    assert!(!s.line_numbers);
    assert_eq!(s.theme, Theme::Dark, "valid neighbours survive");
    let warning = warning.unwrap();
    for key in [
        "palette",
        "accentColor",
        "fontLivePreview",
        "fontSource",
        "fontSize",
        "toolbar",
        "lineNumbers",
    ] {
        assert!(warning.contains(key), "{key} in {warning}");
    }
}

#[test]
fn m2b_font_size_is_clamped_and_font_choices_are_bounded() {
    use nimw_desktop::settings::{FontChoice, FontSize, HexColor};
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("settings.json"), r#"{"fontSize":40}"#).unwrap();
    assert_eq!(store(dir.path()).get().0.font_size, FontSize::new(20));
    assert_eq!(FontSize::new(2).get(), 13);
    assert!(FontChoice::parse("literata").is_some());
    assert!(FontChoice::parse("system:Avenir Next").is_some());
    assert!(FontChoice::parse("system:").is_none(), "empty family");
    assert!(
        FontChoice::parse("system:x\u{7}").is_none(),
        "control characters"
    );
    assert!(
        FontChoice::parse(&format!("system:{}", "a".repeat(200))).is_none(),
        "at most 200 characters"
    );
    assert!(
        FontChoice::parse("comic-sans").is_none(),
        "unknown bundled id"
    );
    assert!(HexColor::parse("#ABCDEF").is_some());
    assert!(HexColor::parse("#abc").is_none());
    assert!(HexColor::parse("abcdef").is_none());
}

/// M3a §5, §6, §8: the Global View's mode and edge toggles are global
/// settings with defaults (Drill-down, every edge kind shown), persisted, and
/// reset on their own when unreadable.
#[test]
fn m3a_global_view_settings_default_persist_and_reset() {
    use nimw_desktop::settings::{GlobalViewEdges, GlobalViewMode};
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let d = s.get().0;
    assert_eq!(d.global_view_mode, GlobalViewMode::Drill);
    assert_eq!(
        d.global_view_edges,
        GlobalViewEdges {
            links: true,
            tree: true,
            manual: true,
            aggregated: true
        }
    );
    s.update(SettingsPatch {
        global_view_mode: Some(GlobalViewMode::Expand),
        global_view_edges: Some(GlobalViewEdges {
            links: true,
            tree: false,
            manual: true,
            aggregated: false,
        }),
        ..Default::default()
    })
    .unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(saved["globalViewMode"], "expand");
    assert_eq!(
        saved["globalViewEdges"],
        serde_json::json!({ "links": true, "tree": false, "manual": true, "aggregated": false })
    );
    assert_eq!(store(dir.path()).get().0, s.get().0, "round-trips");

    // A missing toggle defaults to shown; an unknown mode resets on its own.
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"globalViewMode":"radial","globalViewEdges":{"tree":false},"theme":"dark"}"#,
    )
    .unwrap();
    let (s, warning) = store(dir.path()).get();
    assert_eq!(s.global_view_mode, GlobalViewMode::Drill);
    assert!(!s.global_view_edges.tree && s.global_view_edges.links);
    assert_eq!(s.theme, Theme::Dark);
    assert!(warning.unwrap().contains("globalViewMode"));
}

/// M4b part 2 §1: the app-wide page width, readable by default, persisted,
/// and reset on its own when unreadable.
#[test]
fn m4b2_page_width_setting_default_persist_and_reset() {
    use nimw_desktop::settings::PageWidth;
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    assert_eq!(s.get().0.page_width, PageWidth::Readable);
    s.update(SettingsPatch {
        page_width: Some(PageWidth::Full),
        ..Default::default()
    })
    .unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(saved["pageWidth"], "full");
    std::fs::write(
        dir.path().join("settings.json"),
        r#"{"pageWidth":"wide","theme":"dark"}"#,
    )
    .unwrap();
    let (s, warning) = store(dir.path()).get();
    assert_eq!(s.page_width, PageWidth::Readable);
    assert_eq!(s.theme, Theme::Dark);
    assert!(warning.unwrap().contains("pageWidth"));
}
