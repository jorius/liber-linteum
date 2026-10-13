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
