//! M6 audio clips (spec §3, §10): one take at a time, recorded on its own
//! thread into the app's cache, then imported as an attachment of the page it
//! started on. The microphone is open only between start and stop or cancel.

use crate::attachment_commands::visible_page;
use crate::dto::AttachedDto;
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::{blocking, not_archived};
use nimw_audio::{AudioError, Device, Ended, Host, Take};
use nimw_session::VaultSession;
use nimw_vault::VaultPath;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Clip files Upload clip offers (AUD-03).
pub const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a"];

/// The microphone and the take in progress.
pub struct AudioState {
    host: Arc<dyn Host>,
    take: Mutex<Option<Running>>,
    next: AtomicU64,
}

struct Running {
    id: u64,
    /// The vault the take started in: the clip goes there, even if another
    /// vault opened meanwhile.
    session: Arc<VaultSession>,
    page: VaultPath,
    file: PathBuf,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Result<Take, AudioError>>,
}

impl AudioState {
    pub fn new(host: Arc<dyn Host>) -> AudioState {
        AudioState {
            host,
            take: Mutex::new(None),
            next: AtomicU64::new(1),
        }
    }

    fn running(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.take.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A level reading for the recorder's meter, sent to the main window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelPayload {
    pub recording_id: u64,
    pub rms: f32,
    pub peak: f32,
    pub elapsed_ms: u64,
    /// Set once, when the microphone went away mid-take.
    pub ended: Option<Ended>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedDto {
    pub recording_id: u64,
}

impl From<AudioError> for CommandError {
    fn from(e: AudioError) -> CommandError {
        let kind = match e {
            AudioError::Permission => ErrorKind::NotPermitted,
            AudioError::NoDevice => ErrorKind::NotFound,
            AudioError::Device(_) | AudioError::Write(_) => ErrorKind::Io,
        };
        CommandError::new(kind, e.to_string())
    }
}

/// `clip-YYYYMMDD-HHMMSS`, named by the page in local time.
fn valid_name(name: &str) -> bool {
    let Some(stamp) = name.strip_prefix("clip-") else {
        return false;
    };
    let b = stamp.as_bytes();
    b.len() == 15
        && b[8] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 8 || c.is_ascii_digit())
}

pub(crate) fn audio_devices_impl(audio: &AudioState) -> CmdResult<Vec<Device>> {
    Ok(audio.host.devices()?)
}

pub(crate) fn audio_record_start_impl<R: Runtime>(
    app: &AppHandle<R>,
    page: String,
    device: Option<String>,
    name: String,
) -> CmdResult<StartedDto> {
    not_archived(&page)?;
    if !valid_name(&name) {
        return Err(CommandError::new(
            ErrorKind::InvalidName,
            format!("not a clip name: {name}"),
        ));
    }
    let state = app.state::<AppState>();
    let audio = app.state::<AudioState>();
    let session = state.session()?;
    let page = visible_page(&session, &page)?;
    let mut slot = audio.running();
    if slot.is_some() {
        return Err(CommandError::new(
            ErrorKind::AlreadyExists,
            "a clip is already being recorded",
        ));
    }
    // One take at a time: whatever is here is a crash's leftover.
    let dir = state.cache_dir.join("audio");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{name}.wav"));
    let id = audio.next.fetch_add(1, Ordering::SeqCst);
    let stop = Arc::new(AtomicBool::new(false));
    let (started, first) = mpsc::channel::<()>();
    let thread = {
        let host = audio.host.clone();
        let stop = stop.clone();
        let file = file.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let emit = |level: nimw_audio::Level, elapsed: Duration, ended| {
                let _ = app.emit_to(
                    "main",
                    "audio:level",
                    LevelPayload {
                        recording_id: id,
                        rms: level.rms,
                        peak: level.peak,
                        elapsed_ms: elapsed.as_millis() as u64,
                        ended,
                    },
                );
            };
            let take = nimw_audio::record(&*host, device.as_deref(), &file, &stop, &mut |l, at| {
                let _ = started.send(());
                emit(l, at, None);
            });
            if let Ok(t) = &take
                && t.ended == Ended::DeviceLost
            {
                emit(
                    nimw_audio::Level::default(),
                    t.duration,
                    Some(Ended::DeviceLost),
                );
            }
            take
        })
    };
    // The first reading means the microphone opened; an error ends the thread
    // first. A silent stream still reads (zero), so this never waits long.
    if first.recv_timeout(Duration::from_secs(3)).is_err() && thread.is_finished() {
        let _ = std::fs::remove_file(&file);
        return match thread.join() {
            Ok(Err(e)) => Err(e.into()),
            _ => Err(CommandError::new(
                ErrorKind::Io,
                "the recording stopped at once",
            )),
        };
    }
    *slot = Some(Running {
        id,
        session,
        page,
        file,
        stop,
        thread,
    });
    Ok(StartedDto { recording_id: id })
}

/// A take that was stopped: its file is still in the cache.
struct Done {
    session: Arc<VaultSession>,
    page: VaultPath,
    file: PathBuf,
    take: Result<Take, AudioError>,
}

/// Ends the take `id`: stops its capture and waits for its thread.
fn finish(audio: &AudioState, id: u64) -> CmdResult<Done> {
    let Running {
        session,
        page,
        file,
        stop,
        thread,
        ..
    } = {
        let mut slot = audio.running();
        if slot.as_ref().is_none_or(|r| r.id != id) {
            return Err(CommandError::new(
                ErrorKind::NotFound,
                format!("no recording {id}"),
            ));
        }
        slot.take().expect("checked above")
    };
    stop.store(true, Ordering::SeqCst);
    let take = thread
        .join()
        .unwrap_or_else(|_| Err(AudioError::Device("the recording thread failed".into())));
    Ok(Done {
        session,
        page,
        file,
        take,
    })
}

pub(crate) fn audio_record_stop_impl(audio: &AudioState, id: u64) -> CmdResult<AttachedDto> {
    let done = finish(audio, id)?;
    let attached = match done.take {
        Ok(_) => done
            .session
            .import_attachment(&done.page, &done.file)
            .map_err(CommandError::from),
        Err(e) => Err(e.into()),
    };
    let _ = std::fs::remove_file(&done.file);
    Ok(attached?.into())
}

pub(crate) fn audio_record_cancel_impl(audio: &AudioState, id: u64) -> CmdResult<()> {
    let done = finish(audio, id)?;
    let _ = std::fs::remove_file(&done.file);
    Ok(())
}

pub(crate) fn audio_pick_impl<R: Runtime>(
    app: &AppHandle<R>,
    page: String,
) -> CmdResult<Option<AttachedDto>> {
    not_archived(&page)?;
    let state = app.state::<AppState>();
    let session = state.session()?;
    let page = visible_page(&session, &page)?;
    // Tests replace the dialog through the cover picker hook (M2c §7.4).
    let picked = match state.cover_picker() {
        Some(pick) => pick(),
        None => app
            .dialog()
            .file()
            .add_filter("Audio", AUDIO_EXTENSIONS)
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok()),
    };
    let Some(path) = picked else {
        return Ok(None);
    };
    Ok(Some(session.import_attachment(&page, &path)?.into()))
}

#[tauri::command]
pub async fn audio_devices<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<Device>> {
    blocking(app, |app| audio_devices_impl(&app.state::<AudioState>())).await
}

#[tauri::command]
pub async fn audio_record_start<R: Runtime>(
    app: AppHandle<R>,
    page: String,
    device: Option<String>,
    name: String,
) -> CmdResult<StartedDto> {
    blocking(app, move |app| {
        audio_record_start_impl(&app, page, device, name)
    })
    .await
}

#[tauri::command]
pub async fn audio_record_stop<R: Runtime>(
    app: AppHandle<R>,
    recording_id: u64,
) -> CmdResult<AttachedDto> {
    blocking(app, move |app| {
        audio_record_stop_impl(&app.state::<AudioState>(), recording_id)
    })
    .await
}

#[tauri::command]
pub async fn audio_record_cancel<R: Runtime>(
    app: AppHandle<R>,
    recording_id: u64,
) -> CmdResult<()> {
    blocking(app, move |app| {
        audio_record_cancel_impl(&app.state::<AudioState>(), recording_id)
    })
    .await
}

#[tauri::command]
pub async fn audio_pick<R: Runtime>(
    app: AppHandle<R>,
    page: String,
) -> CmdResult<Option<AttachedDto>> {
    blocking(app, move |app| audio_pick_impl(&app, page)).await
}

#[cfg(test)]
mod tests {
    use super::valid_name;

    #[test]
    fn m6_clip_names_have_one_shape() {
        assert!(valid_name("clip-20261018-101500"));
        for bad in [
            "clip-2026101-101500",
            "clip-20261018_101500",
            "clip-20261018-10150a",
            "clip-20261018-101500.wav",
            "../clip-20261018-101500",
            "Clip-20261018-101500",
            "",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
