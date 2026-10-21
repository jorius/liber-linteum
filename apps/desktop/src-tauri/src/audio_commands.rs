//! M6 audio clips (spec §3, §10): one take at a time, recorded on its own
//! thread into the app's cache, then imported as an attachment of the page it
//! started on. The microphone is open only between start and stop or cancel.
//!
//! An encrypted vault's take never touches the cache (E3 spec §4.2): it is
//! appended, encrypted, into the vault's own `.liber/recording/`, and fixed up
//! into a new file at Stop, or at the next Start or unlock after a lock or crash.

use crate::attachment_commands::visible_page;
use crate::dto::AttachedDto;
use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::state::AppState;
use crate::vault_commands::{blocking, not_archived};
use liber_audio::{AudioError, Device, Ended, Host, Take};
use liber_session::{Attached, VaultSession};
use liber_vault::{Child, Kind, NewFile, Vault, VaultError, VaultPath};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
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
    /// Take folders being imported by a Stop: recovery leaves them alone
    /// (batch 6 review M5).
    finishing: Mutex<HashSet<PathBuf>>,
}

struct Running {
    id: u64,
    /// The vault the take started in: the clip goes there, even if another
    /// vault opened meanwhile.
    session: Arc<VaultSession>,
    page: VaultPath,
    at: TakeAt,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Result<Take, AudioError>>,
}

/// Where an encrypted vault keeps its takes in progress (spec §4.2).
const RECORDING_DIR: &str = ".liber/recording";

/// A take's own folder (batch 6 review M5) and file: in the app cache for a
/// plain vault; in the vault's [`RECORDING_DIR`] for an encrypted one.
enum TakeAt {
    Cache { dir: PathBuf, file: PathBuf },
    Vault { dir: VaultPath, file: VaultPath },
}

impl TakeAt {
    /// Its key in [`AudioState::finishing`].
    fn key(&self) -> PathBuf {
        match self {
            TakeAt::Cache { dir, .. } => dir.clone(),
            TakeAt::Vault { dir, .. } => PathBuf::from(dir.as_str()),
        }
    }

    fn remove(&self, session: &VaultSession) {
        match self {
            TakeAt::Cache { dir, .. } => {
                let _ = std::fs::remove_dir_all(dir); // seam: outside (audio takes live in the app cache, E3 spec §4.2)
            }
            TakeAt::Vault { dir, .. } => {
                let _ = remove_vault_take(session.vault(), dir);
            }
        }
    }
}

/// A take's folder in the vault: its files, any temp file a crash left, then
/// the folder. An unreadable entry in it is never touched, so the folder stays.
fn remove_vault_take(vault: &Vault, dir: &VaultPath) -> liber_vault::Result<()> {
    for child in vault.children(dir)? {
        if let Child::Entry { name, .. } = child {
            vault.remove_file(&dir.join(&name)?)?;
        }
    }
    if let Some(storage) = vault.encrypted() {
        storage.remove_temp_files(dir)?;
    }
    vault.remove_empty_dir(dir)
}

/// Where the record thread writes: a WAV file in the cache, or the vault's
/// append-only stream.
enum Writer {
    Cache(PathBuf),
    Vault(Box<dyn NewFile>),
}

impl AudioState {
    pub fn new(host: Arc<dyn Host>) -> AudioState {
        AudioState {
            host,
            take: Mutex::new(None),
            next: AtomicU64::new(1),
            finishing: Mutex::new(HashSet::new()),
        }
    }

    fn running(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.take.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn finishing(&self) -> std::sync::MutexGuard<'_, HashSet<PathBuf>> {
        self.finishing.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether a take is in progress (a system quit must stop it first).
    pub fn recording(&self) -> bool {
        self.running().is_some()
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
    /// Set once, when the take ended by itself: the microphone went away,
    /// the disk refused more or the clip reached its size limit.
    pub ended: Option<Ended>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedDto {
    pub recording_id: u64,
    /// Takes an earlier session left behind, now in the vault (batch 6 review C1).
    pub recovered: Vec<AttachedDto>,
}

/// Where a take was recorded, beside its file, for recovery.
#[derive(Debug, Serialize, Deserialize)]
struct TakeRecord {
    root: PathBuf,
    page: String,
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

/// Makes a WAV's header count the sound actually in the file: a take cut
/// short by a killed app still says "no sound" or less than it holds.
/// `false` when there's no sound at all.
fn repair_wav(path: &Path) -> std::io::Result<bool> {
    use std::io::{Seek, SeekFrom, Write};
    let len = std::fs::metadata(path)?.len(); // seam: outside (audio takes live in the app cache, E3 spec §4.2)
    let mut head = vec![0u8; 256.min(len as usize)];
    std::io::Read::read_exact(&mut std::fs::File::open(path)?, &mut head)?; // seam: outside (audio takes live in the app cache, E3 spec §4.2)
    let Some(at) = head.windows(4).position(|w| w == b"data") else {
        return Ok(false);
    };
    let start = at as u64 + 8;
    // Whole 16-bit samples only.
    let data = len.saturating_sub(start) & !1;
    if data == 0 || &head[..4] != b"RIFF" {
        return Ok(false);
    }
    let mut f = std::fs::OpenOptions::new().write(true).open(path)?; // seam: outside (audio takes live in the app cache, E3 spec §4.2)
    f.seek(SeekFrom::Start(4))?;
    f.write_all(&((start + data - 8) as u32).to_le_bytes())?;
    f.seek(SeekFrom::Start(at as u64 + 4))?;
    f.write_all(&(data as u32).to_le_bytes())?;
    Ok(true)
}

/// Imports what earlier sessions left in `cache` (a killed app, a Stop whose
/// import failed): next to the page each take was recorded on when that
/// vault is the open one, else next to `fallback`, named `…-recovered.wav`.
/// A folder that fails to import stays for the next try.
fn recover(
    cache: &Path,
    session: &VaultSession,
    fallback: &VaultPath,
    busy: &HashSet<PathBuf>,
) -> Vec<AttachedDto> {
    let entries = std::fs::read_dir(cache); // seam: outside (audio takes live in the app cache, E3 spec §4.2)
    let Ok(entries) = entries else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dir in entries.flatten().map(|e| e.path()) {
        if !dir.is_dir() || busy.contains(&dir) {
            continue;
        }
        let page = std::fs::read(dir.join("take.json")) // seam: outside (audio takes live in the app cache, E3 spec §4.2)
            .ok()
            .and_then(|b| serde_json::from_slice::<TakeRecord>(&b).ok())
            .filter(|r| {
                dunce::canonicalize(&r.root).is_ok_and(|root| root == session.vault().root()) // seam: outside (matching a take to a recent vault by canonical path)
            })
            .and_then(|r| {
                not_archived(&r.page).ok()?;
                visible_page(session, &r.page).ok()
            })
            .unwrap_or_else(|| fallback.clone());
        let files = std::fs::read_dir(&dir); // seam: outside (audio takes live in the app cache, E3 spec §4.2)
        let Ok(files) = files else {
            continue;
        };
        let mut kept = false;
        for wav in files.flatten().map(|e| e.path()) {
            let Some(stem) = wav
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".wav"))
            else {
                continue;
            };
            if !repair_wav(&wav).unwrap_or(false) {
                continue; // no sound to keep
            }
            let named = if stem.ends_with("-recovered") {
                wav.clone()
            } else {
                dir.join(format!("{stem}-recovered.wav"))
            };
            match std::fs::rename(&wav, &named) // seam: outside (audio takes live in the app cache, E3 spec §4.2)
                .map_err(CommandError::from)
                .and_then(|()| Ok(session.import_attachment(&page, &named)?))
            {
                Ok(attached) => out.push(attached.into()),
                Err(_) => kept = true,
            }
        }
        if !kept {
            let _ = std::fs::remove_dir_all(&dir); // seam: outside (audio takes live in the app cache, E3 spec §4.2)
        }
    }
    out
}

/// A take's WAV bytes, sizes fixed (they are placeholders while recording),
/// saved as `name` in `page`'s attachment folder: a new file, fresh salt.
fn save_wav(
    session: &VaultSession,
    page: &VaultPath,
    mut bytes: Vec<u8>,
    name: &str,
) -> CmdResult<Attached> {
    liber_audio::fix_wav_sizes(&mut bytes)?;
    Ok(session.save_attachment(page, name, &bytes)?)
}

/// Saves the takes an encrypted vault's [`RECORDING_DIR`] holds — one a lock
/// ended, or the complete chunks of one a crash cut short — as
/// `…-recovered.wav` next to the page each was recorded on, else next to
/// `fallback`. With no fallback (at unlock), a take whose page is gone waits
/// for the next Start. A take that fails to save stays for the next try.
fn recover_in_vault(
    session: &VaultSession,
    fallback: Option<&VaultPath>,
    busy: &HashSet<PathBuf>,
) -> Vec<AttachedDto> {
    let vault = session.vault();
    let (Some(storage), Ok(root)) = (vault.encrypted(), VaultPath::new(RECORDING_DIR)) else {
        return Vec::new();
    };
    let Ok(children) = vault.children(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for child in children {
        let Child::Entry { name, meta } = child else {
            continue;
        };
        // `<clip name>-<id>`, as `start_in_vault` names it.
        let Some((stem, _)) = name.rsplit_once('-') else {
            continue;
        };
        let Ok(dir) = root.join(&name) else {
            continue;
        };
        if meta.kind != Kind::Dir || !valid_name(stem) || busy.contains(Path::new(dir.as_str())) {
            continue;
        }
        let page = dir
            .join("take.json")
            .ok()
            .and_then(|p| vault.read(&p).ok())
            .and_then(|(b, _)| serde_json::from_slice::<TakeRecord>(&b).ok())
            .and_then(|r| {
                not_archived(&r.page).ok()?;
                visible_page(session, &r.page).ok()
            })
            .or_else(|| fallback.cloned());
        let (Some(page), Ok(wav)) = (page, dir.join(&format!("{stem}.wav"))) else {
            continue;
        };
        match storage.salvage(&wav) {
            // Anything but a WAV with sound (a crash before the first chunk) is dropped.
            Ok((bytes, _)) if bytes.len() > 44 && bytes.starts_with(b"RIFF") => {
                match save_wav(session, &page, bytes, &format!("{stem}-recovered.wav")) {
                    Ok(attached) => out.push(attached.into()),
                    Err(_) => continue,
                }
            }
            Ok(_) | Err(VaultError::NotFound(_) | VaultError::Crypto(_)) => {}
            Err(_) => continue,
        }
        let _ = remove_vault_take(vault, &dir);
    }
    out
}

/// Step 5 of `vault_unlock` (spec §4.2): saves the takes a lock or a crash
/// left in the vault just opened. Not while a take runs (it may be this
/// vault's): the next Start does it then.
pub(crate) fn recover_at_unlock<R: Runtime>(app: &AppHandle<R>) {
    let audio = app.state::<AudioState>();
    let slot = audio.running();
    if slot.is_some() {
        return;
    }
    if let Ok(session) = app.state::<AppState>().session() {
        recover_in_vault(&session, None, &audio.finishing());
    }
}

/// A new take's folder and stream in the encrypted vault: `take.json` first,
/// then `<name>.wav`, which only the record thread appends to.
fn start_in_vault(
    session: &VaultSession,
    name: &str,
    id: u64,
    json: &[u8],
) -> CmdResult<(TakeAt, Box<dyn NewFile>)> {
    let vault = session.vault();
    vault.create_dir_all(&VaultPath::new(RECORDING_DIR)?)?;
    let dir = VaultPath::new(&format!("{RECORDING_DIR}/{name}-{id}"))?;
    // Not `create_dir_all`: a kept take of the same name is never reused.
    vault.create_dir(&dir)?;
    let file = dir.join(&format!("{name}.wav"))?;
    let made = dir
        .join("take.json")
        .and_then(|p| vault.write_cas(&p, json, None))
        .and_then(|_| vault.create_new(&file));
    let at = TakeAt::Vault { dir, file };
    match made {
        Ok(out) => Ok((at, out)),
        Err(e) => {
            at.remove(session);
            Err(e.into())
        }
    }
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
    let cache = state.cache_dir.join("audio");
    let mut recovered = recover(&cache, &session, &page, &audio.finishing());
    recovered.extend(recover_in_vault(&session, Some(&page), &audio.finishing()));
    let id = audio.next.fetch_add(1, Ordering::SeqCst);
    let record = TakeRecord {
        root: session.vault().root().to_path_buf(),
        page: page.to_string(),
    };
    let json =
        serde_json::to_vec(&record).map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?;
    let (at, writer) = if session.vault().encrypted().is_some() {
        let (at, out) = start_in_vault(&session, &name, id, &json)?;
        (at, Writer::Vault(out))
    } else {
        let dir = cache.join(format!("{name}-{id}"));
        let _ = std::fs::remove_dir_all(&dir); // seam: outside (audio takes live in the app cache, E3 spec §4.2)
        std::fs::create_dir_all(&dir)?; // seam: outside (audio takes live in the app cache, E3 spec §4.2)
        std::fs::write(dir.join("take.json"), json)?; // seam: outside (audio takes live in the app cache, E3 spec §4.2)
        let file = dir.join(format!("{name}.wav"));
        (
            TakeAt::Cache {
                dir,
                file: file.clone(),
            },
            Writer::Cache(file),
        )
    };
    let stop = Arc::new(AtomicBool::new(false));
    let (started, first) = mpsc::channel::<()>();
    let thread = {
        let host = audio.host.clone();
        let stop = stop.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let emit = |level: liber_audio::Level, elapsed: Duration, ended| {
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
            let mut on_level = |l, at| {
                let _ = started.send(());
                emit(l, at, None);
            };
            let device = device.as_deref();
            let take = match writer {
                Writer::Cache(file) => {
                    liber_audio::record(&*host, device, &file, &stop, &mut on_level)
                }
                Writer::Vault(mut out) => {
                    let max = liber_audio::MAX_DATA_BYTES;
                    let take = liber_audio::record_stream(
                        &*host,
                        device,
                        &mut out,
                        &stop,
                        &mut on_level,
                        max,
                    );
                    // Ends the stream (a periodic flush never does): Stop, and a
                    // lock (spec §6.2), find a whole file.
                    take.and_then(|t| {
                        out.finish()
                            .map(|()| t)
                            .map_err(|e| AudioError::Write(e.to_string()))
                    })
                }
            };
            // Ended by itself: the bar says so, Stop & insert keeps the sound.
            if let Ok(t) = &take
                && t.ended != Ended::Stopped
            {
                emit(liber_audio::Level::default(), t.duration, Some(t.ended));
            }
            take
        })
    };
    // The first reading means the microphone opened; an error ends the thread
    // first. A silent stream still reads (zero), so this never waits long.
    if first.recv_timeout(Duration::from_secs(3)).is_err() && thread.is_finished() {
        at.remove(&session);
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
        at,
        stop,
        thread,
    });
    Ok(StartedDto {
        recording_id: id,
        recovered,
    })
}

/// A take that was stopped: its file is still in its folder, which is marked
/// as being finished until it is imported, discarded or kept.
struct Done<'a> {
    audio: &'a AudioState,
    session: Arc<VaultSession>,
    page: VaultPath,
    at: TakeAt,
    take: Result<Take, AudioError>,
}

impl Done<'_> {
    /// Imports the take next to `page`. Its folder goes once the clip is
    /// safely in the vault; on failure it stays and the next Start recovers
    /// it (batch 6 review I1). A take with no sound is dropped.
    fn import(self, page: &VaultPath) -> CmdResult<AttachedDto> {
        let out = match &self.take {
            Ok(_) => match self.save(page) {
                Ok(attached) => {
                    self.at.remove(&self.session);
                    Ok(attached.into())
                }
                Err(e) => Err(CommandError::new(
                    ErrorKind::Io,
                    format!(
                        "{}. The clip is kept and goes into the vault the next time you record.",
                        e.message
                    ),
                )),
            },
            Err(e) => {
                self.at.remove(&self.session);
                Err(CommandError::new(ErrorKind::Io, e.to_string()))
            }
        };
        self.keep();
        out
    }

    /// The cache file imported, or the vault stream read back and saved as a
    /// new file with its sizes fixed (spec §4.2).
    fn save(&self, page: &VaultPath) -> CmdResult<Attached> {
        match &self.at {
            TakeAt::Cache { file, .. } => Ok(self.session.import_attachment(page, file)?),
            TakeAt::Vault { file, .. } => {
                let (bytes, _) = self.session.vault().read(file)?;
                save_wav(&self.session, page, bytes, file.file_name())
            }
        }
    }

    fn discard(self) {
        self.at.remove(&self.session);
        self.keep();
    }

    /// Leaves the take where it is, for recovery.
    fn keep(self) {
        self.audio.finishing().remove(&self.at.key());
    }
}

/// Ends the take `id` (any take when `None`): stops its capture and waits
/// for its thread.
fn finish(audio: &AudioState, id: Option<u64>) -> CmdResult<Done<'_>> {
    let Running {
        session,
        page,
        at,
        stop,
        thread,
        ..
    } = {
        let mut slot = audio.running();
        if slot
            .as_ref()
            .is_none_or(|r| id.is_some_and(|id| r.id != id))
        {
            return Err(CommandError::new(
                ErrorKind::NotFound,
                format!("no recording {}", id.unwrap_or_default()),
            ));
        }
        let running = slot.take().expect("checked above");
        audio.finishing().insert(running.at.key());
        running
    };
    stop.store(true, Ordering::SeqCst);
    let take = thread
        .join()
        .unwrap_or_else(|_| Err(AudioError::Device("the recording thread failed".into())));
    Ok(Done {
        audio,
        session,
        page,
        at,
        take,
    })
}

/// Stops the take `id` and imports it next to `page` — where its page is
/// now (batch 6 review I2) — or, when that isn't a page any more, next to
/// the page it started on.
pub(crate) fn audio_record_stop_impl(
    audio: &AudioState,
    id: u64,
    page: Option<String>,
) -> CmdResult<AttachedDto> {
    let done = finish(audio, Some(id))?;
    let now = page
        .filter(|p| not_archived(p).is_ok())
        .and_then(|p| visible_page(&done.session, &p).ok())
        .unwrap_or_else(|| done.page.clone());
    done.import(&now)
}

pub(crate) fn audio_record_cancel_impl(audio: &AudioState, id: u64) -> CmdResult<()> {
    finish(audio, Some(id))?.discard();
    Ok(())
}

/// Stops any take whose recorder went away — the main window reloaded or
/// closed, or the app is exiting — and keeps it: next to its page, or for
/// the next Start to recover. The microphone is released (batch 6 review
/// C1, I4).
pub fn stop_orphaned<R: Runtime>(app: &AppHandle<R>) {
    let Some(audio) = app.try_state::<AudioState>() else {
        return;
    };
    if let Ok(done) = finish(&audio, None) {
        let page = done.page.clone();
        let _ = done.import(&page);
    }
}

/// Spec §6.2 lock, step 2: stops the take, its thread ending its stream, and
/// leaves an encrypted vault's take in place for the next unlock (the vault
/// is about to lock: nothing more is written). Any other take is imported as
/// [`stop_orphaned`] does.
pub(crate) fn stop_for_lock<R: Runtime>(app: &AppHandle<R>) {
    let Some(audio) = app.try_state::<AudioState>() else {
        return;
    };
    if let Ok(done) = finish(&audio, None) {
        match done.at {
            TakeAt::Vault { .. } => done.keep(),
            TakeAt::Cache { .. } => {
                let page = done.page.clone();
                let _ = done.import(&page);
            }
        }
    }
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
    page: Option<String>,
) -> CmdResult<AttachedDto> {
    blocking(app, move |app| {
        audio_record_stop_impl(&app.state::<AudioState>(), recording_id, page)
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
