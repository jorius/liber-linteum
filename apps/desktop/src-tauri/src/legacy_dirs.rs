//! The app's folders before the rename to Liber Linteum. On first launch the
//! new app adopts the old settings (recent vaults, Scratchpad path, language,
//! palette) and any unrecovered audio takes; the old folders are only read.
//! Search indexes rebuild instead, and WebView conveniences reset.

use std::fs;
use std::path::Path;

/// The bundle id before the rename (Notes In My Way).
pub const LEGACY_IDENTIFIER: &str = "app.notesinmyway.desktop";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Adopted {
    pub settings: bool,
    pub audio_takes: usize,
}

/// Copies `settings.json` when the new config dir has none, and the leftover
/// takes when the new cache holds none. The legacy dirs are the siblings of
/// `config_dir` and `cache_dir` named [`LEGACY_IDENTIFIER`] on every OS.
pub fn adopt(config_dir: &Path, cache_dir: &Path) -> std::io::Result<Adopted> {
    let mut adopted = Adopted::default();
    let new_settings = config_dir.join("settings.json");
    if let Some(old) = sibling(config_dir).map(|d| d.join("settings.json"))
        && old.is_file()
        && !new_settings.exists()
    {
        fs::create_dir_all(config_dir)?;
        let tmp = config_dir.join("settings.json.tmp");
        fs::copy(&old, &tmp)?;
        fs::rename(&tmp, &new_settings)?;
        adopted.settings = true;
    }

    let new_audio = cache_dir.join("audio");
    if let Some(old_audio) = sibling(cache_dir).map(|d| d.join("audio"))
        && old_audio.is_dir()
        && !has_files(&new_audio)
    {
        for entry in fs::read_dir(&old_audio)? {
            let path = entry?.path();
            if path.is_file() {
                fs::create_dir_all(&new_audio)?;
                fs::copy(&path, new_audio.join(path.file_name().unwrap_or_default()))?;
                adopted.audio_takes += 1;
            }
        }
    }
    Ok(adopted)
}

fn sibling(dir: &Path) -> Option<std::path::PathBuf> {
    Some(dir.parent()?.join(LEGACY_IDENTIFIER))
}

fn has_files(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|mut it| it.any(|e| e.is_ok_and(|e| e.path().is_file())))
}
