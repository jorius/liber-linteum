//! The app's folders before the rename to Liber Linteum. On first launch the
//! new app adopts the old settings (recent vaults, Scratchpad path, language,
//! palette), the imported dictionaries and any unrecovered audio takes, once;
//! the old folders are only read.
//! Search indexes rebuild instead, and WebView conveniences reset.

use std::fs;
use std::path::Path;

/// The bundle id before the rename (Notes In My Way).
pub const LEGACY_IDENTIFIER: &str = "app.notesinmyway.desktop";

/// Written in the new config dir once adoption has run, so it runs once: a
/// take the new app recovers (and deletes) is never copied back.
const ADOPTED_MARKER: &str = "legacy-adopted";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Adopted {
    pub settings: bool,
    pub audio_takes: usize,
}

/// Runs once, on the first launch that finds the old app's folders (the
/// siblings of `config_dir` and `cache_dir` named [`LEGACY_IDENTIFIER`] on
/// every OS). It copies `settings.json` when the new dir has none, with the
/// imported dictionaries it lists, and every leftover take folder. The old
/// folders are only read.
pub fn adopt(config_dir: &Path, cache_dir: &Path) -> std::io::Result<Adopted> {
    let mut adopted = Adopted::default();
    let (Some(old_config), Some(old_cache)) = (sibling(config_dir), sibling(cache_dir)) else {
        return Ok(adopted);
    };
    let marker = config_dir.join(ADOPTED_MARKER);
    if marker.exists() || !(old_config.is_dir() || old_cache.is_dir()) {
        return Ok(adopted);
    }

    let new_settings = config_dir.join("settings.json");
    let old = old_config.join("settings.json");
    if old.is_file() && !new_settings.exists() {
        fs::create_dir_all(config_dir)?;
        let tmp = config_dir.join("settings.json.tmp");
        fs::copy(&old, &tmp)?;
        // Durable before it's visible: a power cut must not leave an empty
        // settings.json that is never adopted again. Windows flushes only a
        // handle opened for writing.
        fs::OpenOptions::new().write(true).open(&tmp)?.sync_all()?;
        fs::rename(&tmp, &new_settings)?;
        #[cfg(unix)]
        fs::File::open(config_dir)?.sync_all()?;
        adopted.settings = true;
        let dictionaries = old_config.join("dictionaries");
        if dictionaries.is_dir() {
            copy_dir(&dictionaries, &config_dir.join("dictionaries"))?;
        }
    }

    let old_audio = old_cache.join("audio");
    if old_audio.is_dir() {
        let new_audio = cache_dir.join("audio");
        for entry in fs::read_dir(&old_audio)? {
            let entry = entry?;
            let to = new_audio.join(entry.file_name());
            if entry.file_type()?.is_dir() && !to.exists() {
                copy_dir(&entry.path(), &to)?;
                adopted.audio_takes += 1;
            }
        }
    }

    fs::create_dir_all(config_dir)?;
    fs::write(marker, b"")?;
    Ok(adopted)
}

fn sibling(dir: &Path) -> Option<std::path::PathBuf> {
    Some(dir.parent()?.join(LEGACY_IDENTIFIER))
}

/// Files and folders under `from`; links are skipped, never followed.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
