//! The real microphone, through cpal (M6 §3). Never used by tests: the app
//! installs it, tests install `SyntheticHost`.

use crate::AudioError;
use crate::host::{Device, Ended, Host, Sink, StreamFormat};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

/// Chunks the callback may queue ahead of the writer (a few seconds at
/// typical buffer sizes); past that, chunks are dropped and counted rather
/// than growing memory while the disk stalls (batch 6 review M2).
const QUEUE: usize = 512;

/// The system's audio host (CoreAudio, WASAPI, ALSA).
#[derive(Debug, Default, Clone, Copy)]
pub struct CpalHost;

fn device_error(e: cpal::Error) -> AudioError {
    match e.kind() {
        cpal::ErrorKind::PermissionDenied => AudioError::Permission,
        cpal::ErrorKind::DeviceNotAvailable => AudioError::NoDevice,
        _ => AudioError::Device(e.to_string()),
    }
}

fn id_of(device: &cpal::Device) -> Option<String> {
    device.id().ok().map(|id| id.to_string())
}

/// What the stream's callbacks tell the capture thread besides sound.
#[derive(Default)]
struct Flags {
    lost: AtomicBool,
    dropped: AtomicU64,
}

fn stream_of<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    tx: mpsc::SyncSender<Vec<f32>>,
    flags: Arc<Flags>,
) -> Result<cpal::Stream, AudioError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let on_error = flags.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                // shortcut: one allocation per callback, never blocking; a
                // buffer pool would avoid it if real devices ever glitch.
                let chunk = data.iter().map(|s| s.to_sample::<f32>()).collect();
                if tx.try_send(chunk).is_err() {
                    flags.dropped.fetch_add(1, Ordering::Relaxed);
                }
            },
            move |err| {
                // Overruns and route changes are survivable; anything else ends the take.
                if !matches!(
                    err.kind(),
                    cpal::ErrorKind::Xrun
                        | cpal::ErrorKind::DeviceChanged
                        | cpal::ErrorKind::RealtimeDenied
                ) {
                    on_error.lost.store(true, Ordering::SeqCst);
                }
            },
            None,
        )
        .map_err(device_error)
}

impl Host for CpalHost {
    fn devices(&self) -> Result<Vec<Device>, AudioError> {
        let host = cpal::default_host();
        let default = host.default_input_device().as_ref().and_then(id_of);
        let mut out: Vec<Device> = host
            .input_devices()
            .map_err(device_error)?
            .filter_map(|d| {
                let id = id_of(&d)?;
                Some(Device {
                    is_default: default.as_deref() == Some(id.as_str()),
                    name: d.to_string(),
                    id,
                })
            })
            .collect();
        out.sort_by_key(|d| !d.is_default);
        Ok(out)
    }

    fn capture(
        &self,
        device: Option<&str>,
        sink: &mut dyn Sink,
        stop: &AtomicBool,
    ) -> Result<Ended, AudioError> {
        let host = cpal::default_host();
        let device = match device {
            None => host.default_input_device(),
            Some(id) => host
                .input_devices()
                .map_err(device_error)?
                .find(|d| id_of(d).as_deref() == Some(id)),
        }
        .ok_or(AudioError::NoDevice)?;
        let supported = device.default_input_config().map_err(device_error)?;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        sink.format(StreamFormat {
            sample_rate: config.sample_rate,
            channels: config.channels,
        })?;
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let flags = Arc::new(Flags::default());
        let f = flags.clone();
        // The stream stays on this thread: cpal's `Stream` isn't `Send` everywhere.
        let stream = match format {
            SampleFormat::I16 => stream_of::<i16>(&device, config, tx, f)?,
            SampleFormat::U16 => stream_of::<u16>(&device, config, tx, f)?,
            SampleFormat::I32 => stream_of::<i32>(&device, config, tx, f)?,
            SampleFormat::F32 => stream_of::<f32>(&device, config, tx, f)?,
            other => {
                return Err(AudioError::Device(format!(
                    "unsupported sample format {other}"
                )));
            }
        };
        stream.play().map_err(device_error)?;
        let ended = loop {
            if stop.load(Ordering::SeqCst) {
                break Ended::Stopped;
            }
            if flags.lost.load(Ordering::SeqCst) {
                break Ended::DeviceLost;
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(samples) => sink.frames(&samples)?,
                Err(RecvTimeoutError::Disconnected) => break Ended::DeviceLost,
                Err(RecvTimeoutError::Timeout) => {}
            }
        };
        drop(stream);
        // Sound that arrived before the stream closed is part of the take.
        while let Ok(samples) = rx.try_recv() {
            sink.frames(&samples)?;
        }
        let dropped = flags.dropped.load(Ordering::Relaxed);
        if dropped > 0 {
            eprintln!("nimw-audio: {dropped} chunks dropped while the disk caught up");
        }
        Ok(ended)
    }
}
