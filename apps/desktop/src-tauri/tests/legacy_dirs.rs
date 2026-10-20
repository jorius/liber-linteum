//! Rename to Liber Linteum: the first launch adopts the old app's settings
//! and leftover audio takes from the sibling `app.notesinmyway.desktop`
//! folders, and never writes there.

use liber_desktop::legacy_dirs::{LEGACY_IDENTIFIER, adopt};
use liber_desktop::settings::SettingsStore;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// `<tmp>/config/app.liberlinteum.desktop` and `<tmp>/cache/…`, with the
/// legacy folders as their siblings.
struct Dirs {
    _tmp: tempfile::TempDir,
    config: PathBuf,
    cache: PathBuf,
    old_config: PathBuf,
    old_cache: PathBuf,
}

fn dirs() -> Dirs {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().to_path_buf();
    Dirs {
        config: base.join("config/app.liberlinteum.desktop"),
        cache: base.join("cache/app.liberlinteum.desktop"),
        old_config: base.join("config").join(LEGACY_IDENTIFIER),
        old_cache: base.join("cache").join(LEGACY_IDENTIFIER),
        _tmp: tmp,
    }
}

fn write(p: &Path, bytes: &[u8]) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, bytes).unwrap();
}

fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>, SystemTime)> {
    let mut out = Vec::new();
    for e in walk(dir) {
        let meta = fs::metadata(&e).unwrap();
        out.push((e.clone(), fs::read(&e).unwrap(), meta.modified().unwrap()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

const OLD: &[u8] = br#"{"language":"es","recentVaults":[]}"#;

#[test]
fn legacy_identifier_is_pinned() {
    // Split so a future sweep can't rewrite the expected value.
    assert_eq!(LEGACY_IDENTIFIER, concat!("app.notes", "inmyway.desktop"));
}

#[test]
fn copies_settings_into_an_empty_new_dir() {
    let d = dirs();
    write(&d.old_config.join("settings.json"), OLD);
    let a = adopt(&d.config, &d.cache).unwrap();
    assert!(a.settings);
    assert_eq!(fs::read(d.config.join("settings.json")).unwrap(), OLD);
    assert!(!d.config.join("settings.json.tmp").exists());
}

#[test]
fn never_overwrites_new_settings() {
    let d = dirs();
    write(&d.old_config.join("settings.json"), OLD);
    write(&d.config.join("settings.json"), b"{\"language\":\"en\"}");
    let a = adopt(&d.config, &d.cache).unwrap();
    assert!(!a.settings);
    assert_eq!(
        fs::read(d.config.join("settings.json")).unwrap(),
        b"{\"language\":\"en\"}"
    );
    // And a second launch after a first adoption changes nothing either.
    let d = dirs();
    write(&d.old_config.join("settings.json"), OLD);
    assert!(adopt(&d.config, &d.cache).unwrap().settings);
    write(&d.config.join("settings.json"), b"{}");
    assert!(!adopt(&d.config, &d.cache).unwrap().settings);
    assert_eq!(fs::read(d.config.join("settings.json")).unwrap(), b"{}");
}

#[test]
fn old_dir_is_never_modified() {
    let d = dirs();
    write(&d.old_config.join("settings.json"), OLD);
    write(&d.old_config.join("dictionaries/user-x/x.dic"), b"1\nx\n");
    write(&d.old_cache.join("audio/take-1.wav"), b"RIFF");
    write(&d.old_cache.join("index/v.sqlite"), b"db");
    let (cfg, cache) = (snapshot(&d.old_config), snapshot(&d.old_cache));
    adopt(&d.config, &d.cache).unwrap();
    assert_eq!(snapshot(&d.old_config), cfg);
    assert_eq!(snapshot(&d.old_cache), cache);
}

#[test]
fn no_legacy_dir_is_a_noop() {
    let d = dirs();
    let a = adopt(&d.config, &d.cache).unwrap();
    assert!(!a.settings);
    assert_eq!(a.audio_takes, 0);
    assert!(!d.config.exists());
    assert!(!d.cache.exists());
}

#[test]
fn corrupt_legacy_settings_are_copied_and_load_falls_back() {
    let d = dirs();
    write(&d.old_config.join("settings.json"), b"{not json");
    assert!(adopt(&d.config, &d.cache).unwrap().settings);
    // Loading reports and falls back to defaults rather than panicking.
    let _ = SettingsStore::load(&d.config);
}

/// Rename review I2: takes are folders (`audio/<name>-<id>/{take.json,
/// <name>.wav}`, see `audio_commands`), copied once: after the new app
/// recovers (and deletes) them, a later launch copies nothing again.
#[test]
fn copies_leftover_take_folders_once() {
    let d = dirs();
    write(&d.old_config.join("settings.json"), OLD);
    write(&d.old_cache.join("audio/clip-3/take.json"), b"{}");
    write(&d.old_cache.join("audio/clip-3/clip.wav"), b"RIFF1");
    let a = adopt(&d.config, &d.cache).unwrap();
    assert_eq!(a.audio_takes, 1);
    assert_eq!(
        fs::read(d.cache.join("audio/clip-3/clip.wav")).unwrap(),
        b"RIFF1"
    );
    assert!(d.cache.join("audio/clip-3/take.json").is_file());
    assert!(d.old_cache.join("audio/clip-3/clip.wav").is_file());
    // Recovery imports and deletes the take; the next launch adopts nothing.
    fs::remove_dir_all(d.cache.join("audio/clip-3")).unwrap();
    assert_eq!(adopt(&d.config, &d.cache).unwrap(), Default::default());
    assert!(!d.cache.join("audio/clip-3").exists());
}

/// Rename review M1: imported dictionaries listed in the adopted settings
/// come along, where `spell_commands` looks for them.
#[test]
fn copies_imported_dictionaries_with_the_settings() {
    let d = dirs();
    write(&d.old_config.join("settings.json"), OLD);
    write(
        &d.old_config.join("dictionaries/user-x/x.aff"),
        b"SET UTF-8\n",
    );
    write(&d.old_config.join("dictionaries/user-x/x.dic"), b"1\nx\n");
    adopt(&d.config, &d.cache).unwrap();
    assert_eq!(
        fs::read(d.config.join("dictionaries/user-x/x.dic")).unwrap(),
        b"1\nx\n"
    );
    assert!(d.config.join("dictionaries/user-x/x.aff").is_file());
}
