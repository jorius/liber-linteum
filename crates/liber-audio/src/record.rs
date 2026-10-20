//! A take: capture from a [`Host`] into a 16-bit PCM WAV file, with a level
//! reading every 50 ms (M6 §3).

use crate::AudioError;
use crate::host::{Ended, Host, Sink, StreamFormat};
use crate::level::{Level, Meter};
use std::fs::File; // seam: outside (a take in the app cache dir; E3 redesigns recordings, spec §4.2)
use std::io::{BufWriter, Seek, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// A WAV counts its sound in 32 bits: a take ends itself before 4 GiB
/// (about 6 h of 48 kHz stereo), well clear of the wrap (batch 6 review I5).
pub const MAX_DATA_BYTES: u64 = 4_000_000_000;

/// The header is rewritten this often, so a take cut short by a killed app
/// still plays up to here (batch 6 review C1).
const FLUSH_EVERY: Duration = Duration::from_secs(2);

/// How a take ended and how long it is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Take {
    pub ended: Ended,
    pub duration: Duration,
}

/// Records from `device` (the default when `None`) into a new WAV file at
/// `path` until `stop` is set or the device goes away. `on_level` gets a
/// reading and the elapsed time every 50 ms. Blocks: run it on its own thread.
pub fn record(
    host: &dyn Host,
    device: Option<&str>,
    path: &Path,
    stop: &AtomicBool,
    on_level: &mut dyn FnMut(Level, Duration),
) -> Result<Take, AudioError> {
    // The file is only created once the device delivers its format.
    let file = LazyFile { path, file: None };
    record_with(host, device, file, stop, on_level, MAX_DATA_BYTES)
}

/// [`record`] into any writer, ending the take once `max_bytes` of sound are
/// written. A write error ends it too, keeping the sound up to the last
/// flush (`Ended::WriteFailed`).
pub fn record_with<W: Write + Seek>(
    host: &dyn Host,
    device: Option<&str>,
    writer: W,
    stop: &AtomicBool,
    on_level: &mut dyn FnMut(Level, Duration),
    max_bytes: u64,
) -> Result<Take, AudioError> {
    let mut sink = WavSink {
        out: Some(writer),
        on_level,
        writer: None,
        meter: Meter::default(),
        format: None,
        frames: 0,
        flushed_at: 0,
        max_bytes,
        stop,
        ended: None,
    };
    let captured = host.capture(device, &mut sink, stop);
    let duration = sink.elapsed();
    let Some(writer) = sink.writer.take() else {
        captured?;
        return Err(AudioError::Device("the microphone sent no sound".into()));
    };
    let ended = match (captured, sink.ended) {
        // The disk refused more: what was flushed before is the take.
        (Err(AudioError::Write(_)), _) | (_, Some(Ended::WriteFailed)) => {
            let _ = writer.finalize();
            return Ok(Take {
                ended: Ended::WriteFailed,
                duration,
            });
        }
        (Err(e), _) => {
            let _ = writer.finalize();
            return Err(e);
        }
        (Ok(_), Some(limit)) => limit,
        (Ok(ended), None) => ended,
    };
    writer.finalize().map_err(write_error)?;
    Ok(Take { ended, duration })
}

/// A file created on first write, so a microphone that never opens leaves
/// nothing behind.
struct LazyFile<'a> {
    path: &'a Path,
    file: Option<BufWriter<File>>,
}

impl LazyFile<'_> {
    fn with<T>(
        &mut self,
        f: impl FnOnce(&mut BufWriter<File>) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        if self.file.is_none() {
            self.file = Some(BufWriter::new(File::create(self.path)?)); // seam: outside (a take in the app cache dir; E3 redesigns recordings, spec §4.2)
        }
        f(self.file.as_mut().expect("created above"))
    }
}

impl Write for LazyFile<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.with(|f| f.write(buf))
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.with(|f| f.flush())
    }
}

impl Seek for LazyFile<'_> {
    fn seek(&mut self, to: std::io::SeekFrom) -> std::io::Result<u64> {
        self.with(|f| f.seek(to))
    }
}

struct WavSink<'a, W: Write + Seek> {
    /// The writer until the format arrives and the WAV starts.
    out: Option<W>,
    on_level: &'a mut dyn FnMut(Level, Duration),
    writer: Option<hound::WavWriter<W>>,
    meter: Meter,
    format: Option<StreamFormat>,
    /// Samples per channel written so far.
    frames: u64,
    /// `frames` at the last header rewrite.
    flushed_at: u64,
    max_bytes: u64,
    stop: &'a AtomicBool,
    /// Set when the sink itself ended the take.
    ended: Option<Ended>,
}

impl<W: Write + Seek> WavSink<'_, W> {
    fn elapsed(&self) -> Duration {
        match self.format {
            Some(f) if f.sample_rate > 0 => {
                Duration::from_secs_f64(self.frames as f64 / f64::from(f.sample_rate))
            }
            _ => Duration::ZERO,
        }
    }
}

impl<W: Write + Seek> Sink for WavSink<'_, W> {
    fn format(&mut self, format: StreamFormat) -> Result<(), AudioError> {
        if format.channels == 0 || format.sample_rate == 0 {
            return Err(AudioError::Device(format!("unusable stream {format:?}")));
        }
        let spec = hound::WavSpec {
            channels: format.channels,
            sample_rate: format.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let out = self
            .out
            .take()
            .ok_or_else(|| AudioError::Device("the stream started twice".into()))?;
        self.writer = Some(hound::WavWriter::new(out, spec).map_err(write_error)?);
        // A reading per 50 ms of sound, whatever the rate and channels.
        self.meter = Meter::new(format.sample_rate as usize * format.channels as usize / 20);
        self.format = Some(format);
        Ok(())
    }

    fn frames(&mut self, interleaved: &[f32]) -> Result<(), AudioError> {
        let (Some(writer), Some(format)) = (self.writer.as_mut(), self.format) else {
            return Err(AudioError::Device("sound arrived before its format".into()));
        };
        if self.ended.is_some() {
            return Ok(());
        }
        let channels = format.channels as usize;
        // Whole frames that still fit under the size limit.
        let room = (self.max_bytes / 2).saturating_sub(self.frames * channels as u64) as usize;
        let take = interleaved.len().min(room - room % channels);
        let mut failed = interleaved[..take]
            .iter()
            .try_for_each(|&s| {
                writer.write_sample((s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
            })
            .err();
        self.frames += (take / channels) as u64;
        let due = u64::from(format.sample_rate) * FLUSH_EVERY.as_secs();
        if failed.is_none() && self.frames - self.flushed_at >= due {
            self.flushed_at = self.frames;
            failed = writer.flush().err();
        }
        if let Some(e) = failed {
            self.ended = Some(Ended::WriteFailed);
            return Err(write_error(e));
        }
        if take < interleaved.len() {
            self.ended = Some(Ended::LengthLimit);
            self.stop.store(true, Ordering::SeqCst);
        }
        let elapsed = self.elapsed();
        let on_level = &mut *self.on_level;
        self.meter
            .push(&interleaved[..take], |level| on_level(level, elapsed));
        Ok(())
    }
}

fn write_error(e: hound::Error) -> AudioError {
    AudioError::Write(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::SyntheticHost;
    use std::sync::atomic::Ordering;

    fn read(path: &Path) -> (hound::WavSpec, usize) {
        let reader = hound::WavReader::open(path).unwrap();
        (reader.spec(), reader.len() as usize)
    }

    #[test]
    fn m6_a_take_is_a_16_bit_wav_at_the_device_rate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let stop = AtomicBool::new(false);
        let mut readings = Vec::new();
        let take = record(
            &SyntheticHost::tone(48_000, 1),
            None,
            &path,
            &stop,
            &mut |level, elapsed| {
                readings.push((level, elapsed));
                if elapsed >= Duration::from_millis(500) {
                    stop.store(true, Ordering::SeqCst);
                }
            },
        )
        .unwrap();
        assert_eq!(take.ended, Ended::Stopped);
        let (spec, samples) = read(&path);
        assert_eq!(spec.sample_rate, 48_000);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.bits_per_sample, 16);
        // Half a second, give or take one 10 ms chunk.
        assert!((24_000..=24_480).contains(&samples), "{samples}");
        assert!((Duration::from_millis(500)..=Duration::from_millis(510)).contains(&take.duration));
        // A reading every 50 ms: ten, each with the tone's level.
        assert_eq!(readings.len(), 10);
        let (level, at) = readings[0];
        assert_eq!(at, Duration::from_millis(50));
        assert!(level.peak > 0.4 && level.rms > 0.3, "{level:?}");
    }

    #[test]
    fn m6_stereo_is_kept_and_counted_per_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let stop = AtomicBool::new(false);
        let take = record(
            &SyntheticHost::tone(44_100, 2),
            None,
            &path,
            &stop,
            &mut |_, elapsed| {
                if elapsed >= Duration::from_millis(200) {
                    stop.store(true, Ordering::SeqCst);
                }
            },
        )
        .unwrap();
        let (spec, samples) = read(&path);
        assert_eq!(spec.channels, 2);
        assert_eq!(samples % 2, 0);
        assert!(take.duration >= Duration::from_millis(200));
        assert!(take.duration < Duration::from_millis(220));
    }

    #[test]
    fn m6_a_device_that_goes_away_keeps_the_take_so_far() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let stop = AtomicBool::new(false);
        let host = SyntheticHost::tone(48_000, 1).lost_after(Duration::from_millis(300));
        let take = record(&host, None, &path, &stop, &mut |_, _| {}).unwrap();
        assert_eq!(take.ended, Ended::DeviceLost);
        let (_, samples) = read(&path);
        assert_eq!(samples, 14_400);
    }

    /// A writer that fails every write once `fail` is set (a full disk).
    #[derive(Clone)]
    struct Disk {
        bytes: std::sync::Arc<std::sync::Mutex<std::io::Cursor<Vec<u8>>>>,
        fail: std::sync::Arc<AtomicBool>,
    }
    impl Disk {
        fn new() -> Disk {
            Disk {
                bytes: Default::default(),
                fail: Default::default(),
            }
        }
        fn samples(&self) -> usize {
            let bytes = self.bytes.lock().unwrap().get_ref().clone();
            hound::WavReader::new(std::io::Cursor::new(bytes))
                .map(|r| r.len() as usize)
                .unwrap_or(0)
        }
    }
    impl std::io::Write for Disk {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.fail.load(Ordering::SeqCst) {
                return Err(std::io::Error::other("no space left on device"));
            }
            self.bytes.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl std::io::Seek for Disk {
        fn seek(&mut self, to: std::io::SeekFrom) -> std::io::Result<u64> {
            self.bytes.lock().unwrap().seek(to)
        }
    }

    #[test]
    fn b6_review_c1_a_take_in_progress_is_playable_up_to_its_last_flush() {
        // A process killed mid-take leaves the file as it is: its header must
        // already count the sound written a moment ago.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let stop = AtomicBool::new(false);
        let mut seen = 0;
        record(
            &SyntheticHost::tone(48_000, 1),
            None,
            &path,
            &stop,
            &mut |_, elapsed| {
                if elapsed >= Duration::from_millis(2_500) && seen == 0 {
                    seen = hound::WavReader::open(&path).map_or(0, |r| r.len() as usize);
                    stop.store(true, Ordering::SeqCst);
                }
            },
        )
        .unwrap();
        assert!(seen >= 96_000, "2 s were flushed before the cut: {seen}");
    }

    #[test]
    fn b6_review_i1_a_write_error_keeps_the_sound_written_before_it() {
        let disk = Disk::new();
        let stop = AtomicBool::new(false);
        let fail = disk.fail.clone();
        let take = record_with(
            &SyntheticHost::tone(48_000, 1),
            None,
            disk.clone(),
            &stop,
            &mut |_, elapsed| {
                if elapsed >= Duration::from_millis(2_500) {
                    fail.store(true, Ordering::SeqCst);
                }
            },
            MAX_DATA_BYTES,
        )
        .unwrap();
        assert_eq!(take.ended, Ended::WriteFailed);
        assert!(disk.samples() >= 96_000, "{}", disk.samples());
    }

    #[test]
    fn b6_review_i5_a_take_ends_itself_before_the_wav_size_limit() {
        let disk = Disk::new();
        let stop = AtomicBool::new(false);
        // One second of 16-bit mono at 48 kHz.
        let take = record_with(
            &SyntheticHost::tone(48_000, 1),
            None,
            disk.clone(),
            &stop,
            &mut |_, _| {},
            96_000,
        )
        .unwrap();
        assert_eq!(take.ended, Ended::LengthLimit);
        let samples = disk.samples();
        assert!((47_520..=48_000).contains(&samples), "{samples}");
        assert!(MAX_DATA_BYTES < u64::from(u32::MAX) - 1_000_000);
    }

    #[test]
    fn m6_a_device_that_fails_to_open_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let stop = AtomicBool::new(false);
        let err = record(&SyntheticHost::denied(), None, &path, &stop, &mut |_, _| {}).unwrap_err();
        assert!(matches!(err, AudioError::Permission));
        assert!(!path.exists());
    }
}
