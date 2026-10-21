//! A take into an append-only writer (spec §4.2 Recordings): an encrypted
//! vault's stream encrypts each chunk once and never seeks, so the WAV header
//! goes out first with placeholder sizes and is fixed up in a new file later.

use crate::AudioError;
use crate::host::Host;
use crate::level::Level;
use crate::record::{Pcm, Take, run};
use std::io::{BufWriter, Write};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// The RIFF and data sizes a take in progress carries: "unknown".
const PLACEHOLDER: u32 = 0xFFFF_FFFF;

/// 16-bit PCM samples after a fixed 44-byte header, written in order.
struct StreamWav<W: Write> {
    out: BufWriter<W>,
}

impl<W: Write> StreamWav<W> {
    fn new(out: W, spec: hound::WavSpec) -> Result<Self, AudioError> {
        let block = spec.channels * 2;
        let mut head = Vec::with_capacity(44);
        head.extend_from_slice(b"RIFF");
        head.extend_from_slice(&PLACEHOLDER.to_le_bytes());
        head.extend_from_slice(b"WAVEfmt ");
        head.extend_from_slice(&16u32.to_le_bytes());
        head.extend_from_slice(&1u16.to_le_bytes()); // PCM
        head.extend_from_slice(&spec.channels.to_le_bytes());
        head.extend_from_slice(&spec.sample_rate.to_le_bytes());
        head.extend_from_slice(&(spec.sample_rate * u32::from(block)).to_le_bytes());
        head.extend_from_slice(&block.to_le_bytes());
        head.extend_from_slice(&16u16.to_le_bytes());
        head.extend_from_slice(b"data");
        head.extend_from_slice(&PLACEHOLDER.to_le_bytes());
        let mut out = BufWriter::new(out);
        out.write_all(&head).map_err(io_error)?;
        Ok(StreamWav { out })
    }
}

impl<W: Write> Pcm for StreamWav<W> {
    fn sample(&mut self, s: i16) -> Result<(), AudioError> {
        self.out.write_all(&s.to_le_bytes()).map_err(io_error)
    }

    fn flush(&mut self) -> Result<(), AudioError> {
        self.out.flush().map_err(io_error)
    }

    fn finalize(mut self) -> Result<(), AudioError> {
        self.out.flush().map_err(io_error)
    }
}

fn io_error(e: std::io::Error) -> AudioError {
    AudioError::Write(e.to_string())
}

/// [`record`](crate::record) into an append-only writer (spec §4.2 Recordings): the WAV header carries
/// placeholder sizes (0xFFFF_FFFF) and is never rewritten; no seek, ever.
pub fn record_stream<W: Write>(
    host: &dyn Host,
    device: Option<&str>,
    writer: W,
    stop: &AtomicBool,
    on_level: &mut dyn FnMut(Level, Duration),
    max_bytes: u64,
) -> Result<Take, AudioError> {
    run(
        host,
        device,
        writer,
        StreamWav::new,
        stop,
        on_level,
        max_bytes,
    )
}

/// The same bytes with the RIFF and data sizes set from the data length.
pub fn fix_wav_sizes(bytes: &mut Vec<u8>) -> Result<(), AudioError> {
    let bad = |why: &str| AudioError::Write(format!("not a WAV take: {why}"));
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad("no RIFF/WAVE header"));
    }
    let u32_at = |b: &[u8], at: usize| u32::from_le_bytes(b[at..at + 4].try_into().unwrap());
    let mut block = None;
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let size = u32_at(bytes, at + 4) as usize;
        match &bytes[at..at + 4] {
            b"fmt " if at + 22 <= bytes.len() => {
                block = Some(u16::from_le_bytes([bytes[at + 20], bytes[at + 21]]).max(1) as usize);
            }
            b"data" => {
                let block = block.ok_or_else(|| bad("data before fmt"))?;
                let start = at + 8;
                // Whole frames only: a salvaged take can end mid-sample.
                let data = (bytes.len() - start) / block * block;
                let riff = u32::try_from(start + data - 8).map_err(|_| bad("too long"))?;
                bytes.truncate(start + data);
                bytes[4..8].copy_from_slice(&riff.to_le_bytes());
                bytes[at + 4..at + 8].copy_from_slice(&(data as u32).to_le_bytes());
                return Ok(());
            }
            _ => {}
        }
        at = at.saturating_add(8 + size + size % 2);
    }
    Err(bad("no data chunk"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{Ended, SyntheticHost};
    use crate::record::MAX_DATA_BYTES;
    use std::sync::atomic::Ordering;

    /// A `Write`-only sink: its `Seek` panics, so a seek anywhere fails the test.
    struct NoSeek(Vec<u8>);
    impl Write for NoSeek {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl std::io::Seek for NoSeek {
        fn seek(&mut self, _: std::io::SeekFrom) -> std::io::Result<u64> {
            panic!("a stream WAV must never seek")
        }
    }

    #[test]
    fn stream_wav_never_seeks() {
        let mut out = NoSeek(Vec::new());
        let stop = AtomicBool::new(false);
        let take = record_stream(
            &SyntheticHost::tone(44_100, 2),
            None,
            &mut out,
            &stop,
            &mut |_, elapsed| {
                if elapsed >= Duration::from_secs(3) {
                    stop.store(true, Ordering::SeqCst);
                }
            },
            MAX_DATA_BYTES,
        )
        .unwrap();
        assert_eq!(take.ended, Ended::Stopped);
        let mut bytes = out.0;
        // The header was never rewritten: both sizes are still placeholders.
        assert_eq!(&bytes[4..8], &PLACEHOLDER.to_le_bytes());
        assert_eq!(&bytes[40..44], &PLACEHOLDER.to_le_bytes());
        fix_wav_sizes(&mut bytes).unwrap();
        let reader = hound::WavReader::new(std::io::Cursor::new(&bytes)).unwrap();
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.spec().sample_rate, 44_100);
        let frames = (take.duration.as_secs_f64() * 44_100.0).round() as u32;
        assert!(frames >= 3 * 44_100, "{frames}");
        assert_eq!(reader.len(), frames * 2);
        let samples: Vec<i16> = reader.into_samples().map(Result::unwrap).collect();
        assert_eq!(samples.len() as u32, frames * 2);
    }

    #[test]
    fn fix_wav_sizes_keeps_whole_frames_only() {
        let mut out = NoSeek(Vec::new());
        let stop = AtomicBool::new(false);
        record_stream(
            &SyntheticHost::tone(48_000, 2),
            None,
            &mut out,
            &stop,
            &mut |_, _| stop.store(true, Ordering::SeqCst),
            MAX_DATA_BYTES,
        )
        .unwrap();
        let mut bytes = out.0;
        bytes.extend_from_slice(&[1, 2, 3]); // a salvage cut mid-frame
        fix_wav_sizes(&mut bytes).unwrap();
        assert_eq!((bytes.len() - 44) % 4, 0);
        let reader = hound::WavReader::new(std::io::Cursor::new(&bytes)).unwrap();
        assert_eq!(reader.len() as usize, (bytes.len() - 44) / 2);
        assert!(fix_wav_sizes(&mut b"not a wav at all".to_vec()).is_err());
    }
}
