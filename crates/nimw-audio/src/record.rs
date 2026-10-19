//! A take: capture from a [`Host`] into a 16-bit PCM WAV file, with a level
//! reading every 50 ms (M6 §3).

use crate::AudioError;
use crate::host::{Ended, Host, Sink, StreamFormat};
use crate::level::{Level, Meter};
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

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
    let mut sink = WavSink {
        path,
        on_level,
        writer: None,
        meter: Meter::default(),
        format: None,
        frames: 0,
    };
    let ended = host.capture(device, &mut sink, stop)?;
    let duration = sink.elapsed();
    match sink.writer.take() {
        Some(writer) => writer.finalize().map_err(write_error)?,
        None => return Err(AudioError::Device("the microphone sent no sound".into())),
    }
    Ok(Take { ended, duration })
}

struct WavSink<'a> {
    path: &'a Path,
    on_level: &'a mut dyn FnMut(Level, Duration),
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    meter: Meter,
    format: Option<StreamFormat>,
    /// Samples per channel written so far.
    frames: u64,
}

impl WavSink<'_> {
    fn elapsed(&self) -> Duration {
        match self.format {
            Some(f) if f.sample_rate > 0 => {
                Duration::from_secs_f64(self.frames as f64 / f64::from(f.sample_rate))
            }
            _ => Duration::ZERO,
        }
    }
}

impl Sink for WavSink<'_> {
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
        self.writer = Some(hound::WavWriter::create(self.path, spec).map_err(write_error)?);
        // A reading per 50 ms of sound, whatever the rate and channels.
        self.meter = Meter::new(format.sample_rate as usize * format.channels as usize / 20);
        self.format = Some(format);
        Ok(())
    }

    fn frames(&mut self, interleaved: &[f32]) -> Result<(), AudioError> {
        let (Some(writer), Some(format)) = (self.writer.as_mut(), self.format) else {
            return Err(AudioError::Device("sound arrived before its format".into()));
        };
        for &s in interleaved {
            writer
                .write_sample((s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
                .map_err(write_error)?;
        }
        self.frames += (interleaved.len() / format.channels as usize) as u64;
        let elapsed = self.elapsed();
        let on_level = &mut *self.on_level;
        self.meter
            .push(interleaved, |level| on_level(level, elapsed));
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
