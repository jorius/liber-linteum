//! Microphone capture and WAV/MP3 encoding for audio clips.

use serde::{Deserialize, Serialize};

/// AUD-02: recording container/codec. Default is WAV (Q-AUD-1).
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
