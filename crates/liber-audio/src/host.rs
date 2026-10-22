//! Where sound comes from (M6 §3, §7): the real microphone through cpal, or a
//! synthetic source in every test, so no test ever opens a microphone.

use crate::AudioError;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// The stream a device delivers: interleaved channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

/// An input device, as the recorder bar lists it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// How a capture ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ended {
    /// `stop` was set.
    Stopped,
    /// The device went away (unplugged); what came before is kept.
    DeviceLost,
    /// The clip reached the size a WAV can hold (batch 6 review I5).
    LengthLimit,
    /// The disk refused more sound; what was flushed before is kept (I1).
    WriteFailed,
}

/// Receives a capture: its format once, then samples in -1.0..=1.0.
pub trait Sink {
    fn format(&mut self, format: StreamFormat) -> Result<(), AudioError>;
    fn frames(&mut self, interleaved: &[f32]) -> Result<(), AudioError>;
}

/// A source of input devices and their sound.
pub trait Host: Send + Sync {
    fn devices(&self) -> Result<Vec<Device>, AudioError>;
    /// Captures from `device` (the default when `None`) into `sink` until
    /// `stop` is set or the device goes away. Blocks the calling thread.
    fn capture(
        &self,
        device: Option<&str>,
        sink: &mut dyn Sink,
        stop: &AtomicBool,
    ) -> Result<Ended, AudioError>;
}

/// A deterministic source for tests: a 440 Hz tone at half scale, in 10 ms
/// chunks, as fast as it is read (or at the pace of real time, keeping up
/// with the clock as a real device does).
#[derive(Debug, Clone)]
pub struct SyntheticHost {
    pub format: StreamFormat,
    /// Ends as a lost device after this much sound.
    pub lose_after: Option<Duration>,
    /// Paces chunks at real time (the app's own tests of a running take).
    pub realtime: bool,
    /// Opening the device fails as a denied microphone.
    pub deny: bool,
}

impl SyntheticHost {
    pub fn tone(sample_rate: u32, channels: u16) -> SyntheticHost {
        SyntheticHost {
            format: StreamFormat {
                sample_rate,
                channels,
            },
            lose_after: None,
            realtime: false,
            deny: false,
        }
    }

    pub fn denied() -> SyntheticHost {
        SyntheticHost {
            deny: true,
            ..SyntheticHost::tone(48_000, 1)
        }
    }

    pub fn lost_after(self, after: Duration) -> SyntheticHost {
        SyntheticHost {
            lose_after: Some(after),
            ..self
        }
    }

    pub fn realtime(self) -> SyntheticHost {
        SyntheticHost {
            realtime: true,
            ..self
        }
    }
}

/// The synthetic device's id.
pub const SYNTHETIC_DEVICE: &str = "synthetic";

impl Host for SyntheticHost {
    fn devices(&self) -> Result<Vec<Device>, AudioError> {
        Ok(vec![Device {
            id: SYNTHETIC_DEVICE.into(),
            name: "Test microphone".into(),
            is_default: true,
        }])
    }

    fn capture(
        &self,
        device: Option<&str>,
        sink: &mut dyn Sink,
        stop: &AtomicBool,
    ) -> Result<Ended, AudioError> {
        if device.is_some_and(|d| d != SYNTHETIC_DEVICE) {
            return Err(AudioError::NoDevice);
        }
        if self.deny {
            return Err(AudioError::Permission);
        }
        let StreamFormat {
            sample_rate,
            channels,
        } = self.format;
        sink.format(self.format)?;
        let chunk = (sample_rate / 100) as usize; // 10 ms per channel
        let mut t = 0u64;
        let mut buf = Vec::with_capacity(chunk * channels as usize);
        let start = std::time::Instant::now();
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            if self
                .lose_after
                .is_some_and(|d| t as f64 >= d.as_secs_f64() * f64::from(sample_rate))
            {
                return Ok(Ended::DeviceLost);
            }
            buf.clear();
            for i in 0..chunk as u64 {
                let phase = (t + i) as f64 * 440.0 * std::f64::consts::TAU / f64::from(sample_rate);
                let s = (phase.sin() * 0.5) as f32;
                buf.extend(std::iter::repeat_n(s, channels as usize));
            }
            t += chunk as u64;
            sink.frames(&buf)?;
            if self.realtime {
                // Waits until the sound made so far is due. A sleep that runs
                // long (a loaded machine, macOS timer coalescing) is caught up
                // by the next chunks instead of losing that time's sound.
                let due = Duration::from_secs_f64(t as f64 / f64::from(sample_rate));
                if let Some(wait) = due.checked_sub(start.elapsed()) {
                    std::thread::sleep(wait);
                }
            }
        }
        Ok(Ended::Stopped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m6_the_synthetic_host_lists_one_default_device() {
        let devices = SyntheticHost::tone(48_000, 1).devices().unwrap();
        assert_eq!(devices.len(), 1);
        assert!(devices[0].is_default);
    }

    #[test]
    fn m6_an_unknown_device_is_refused() {
        struct Nothing;
        impl Sink for Nothing {
            fn format(&mut self, _: StreamFormat) -> Result<(), AudioError> {
                Ok(())
            }
            fn frames(&mut self, _: &[f32]) -> Result<(), AudioError> {
                Ok(())
            }
        }
        let err = SyntheticHost::tone(48_000, 1)
            .capture(Some("no-such-mic"), &mut Nothing, &AtomicBool::new(true))
            .unwrap_err();
        assert!(matches!(err, AudioError::NoDevice));
    }
}
