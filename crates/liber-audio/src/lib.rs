//! Microphone capture and WAV encoding for audio clips (M6).
//!
//! No Tauri here: the desktop app runs [`record`] on a thread of its own with
//! [`CpalHost`]; tests use [`SyntheticHost`] and never open a microphone. An
//! encrypted vault records with [`record_stream`], which never seeks.

mod cpal_host;
mod host;
mod level;
mod record;
mod stream_wav;

pub use cpal_host::CpalHost;
pub use host::{Device, Ended, Host, SYNTHETIC_DEVICE, Sink, StreamFormat, SyntheticHost};
pub use level::{Level, level};
pub use record::{MAX_DATA_BYTES, Take, record, record_with};
pub use stream_wav::{FixedWav, fix_wav_sizes, fixed_wav, record_stream};

use serde::{Deserialize, Serialize};

/// Why a recording couldn't start or go on.
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("the app isn't allowed to use the microphone")]
    Permission,
    #[error("no microphone was found")]
    NoDevice,
    #[error("the microphone failed: {0}")]
    Device(String),
    #[error("the clip couldn't be written: {0}")]
    Write(String),
}

/// AUD-02: recording container/codec. Default is WAV (Q-AUD-1). Only WAV is
/// recorded for now (M6 §10.1: MP3 is deferred).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingFormat {
    #[default]
    Wav,
    Mp3,
}

impl RecordingFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RecordingFormat;

    #[test]
    fn aud_02_default_format_is_wav() {
        assert_eq!(RecordingFormat::default(), RecordingFormat::Wav);
    }

    #[test]
    fn aud_02_extensions() {
        assert_eq!(RecordingFormat::Wav.extension(), "wav");
        assert_eq!(RecordingFormat::Mp3.extension(), "mp3");
    }

    #[test]
    fn aud_02_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&RecordingFormat::Mp3).unwrap(),
            "\"mp3\""
        );
        let parsed: RecordingFormat = serde_json::from_str("\"wav\"").unwrap();
        assert_eq!(parsed, RecordingFormat::Wav);
    }
}
