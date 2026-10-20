//! Spell checking (spell checking spec): local Hunspell dictionaries only.
//! The active set is the open vault's override, else the app setting, else
//! the UI language's default. Words added to the dictionary live in the
//! vault; ignored words last until the vault closes.

use crate::error::{CmdResult, CommandError, ErrorKind};
use crate::settings::ImportedDictionary;
use crate::state::AppState;
use crate::vault_commands::blocking;
use nimw_session::VaultSession;
use nimw_spell::{BUNDLED, SpellError, Speller, validate};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::SystemTime;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Most words one `spell_check` call takes.
const MAX_WORDS: usize = 5000;
/// Longest word that can be added to the dictionary.
const MAX_WORD_CHARS: usize = 100;

#[derive(Default)]
pub struct SpellState {
    speller: Speller,
    /// Words ignored in the open vault's session; reset when another session
    /// (a different vault, or the same one reopened) is open.
    ignores: Mutex<(Weak<VaultSession>, HashSet<String>)>,
    /// Imported dictionaries that failed to load, with their files' times
    /// then: not retried until the files change (round 3b final review #12).
    failed: Mutex<HashMap<String, Option<(SystemTime, SystemTime)>>>,
    /// The open vault's spelling settings, kept until `.nimw/vault.json`
    /// changes rather than read on every check (final review #12).
    vault: Mutex<Option<VaultSpelling>>,
    loads: AtomicUsize,
    reads: AtomicUsize,
}

struct VaultSpelling {
    session: Weak<VaultSession>,
    stamp: Option<(SystemTime, u64)>,
    dictionaries: Option<Vec<String>>,
    words: Vec<String>,
}

impl SpellState {
    fn ignores(&self, session: Option<&Arc<VaultSession>>) -> HashSet<String> {
        let mut slot = self.ignores.lock().unwrap_or_else(|e| e.into_inner());
        match session {
            Some(s) if slot.0.ptr_eq(&Arc::downgrade(s)) => slot.1.clone(),
            _ => {
                *slot = (
                    session.map(Arc::downgrade).unwrap_or_default(),
                    HashSet::new(),
                );
                HashSet::new()
            }
        }
    }

    /// (dictionary loads attempted, vault settings reads), for tests.
    #[doc(hidden)]
    pub fn counters(&self) -> (usize, usize) {
        (
            self.loads.load(Ordering::Relaxed),
            self.reads.load(Ordering::Relaxed),
        )
    }

    /// The open vault's (dictionary override, added words).
    fn vault_spelling(&self, session: &Arc<VaultSession>) -> (Option<Vec<String>>, Vec<String>) {
        let vault = session.vault();
        let stamp = vault.spelling_stamp();
        let mut slot = self.vault.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref() {
            Some(c) if c.session.ptr_eq(&Arc::downgrade(session)) && c.stamp == stamp => {}
            _ => {
                self.reads.fetch_add(1, Ordering::Relaxed);
                *slot = Some(VaultSpelling {
                    session: Arc::downgrade(session),
                    stamp,
                    dictionaries: vault.spelling_dictionaries(),
                    words: vault.spelling_words(),
                });
            }
        }
        let c = slot.as_ref().expect("filled above");
        (c.dictionaries.clone(), c.words.clone())
    }

    /// Forgets the cached vault settings after this module writes them.
    fn vault_changed(&self) {
        *self.vault.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn ignore(&self, session: &Arc<VaultSession>, word: String) {
        self.ignores(Some(session));
        self.ignores
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .1
            .insert(word);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryDto {
    pub id: String,
    pub name: String,
    pub bundled: bool,
    /// False when an imported dictionary's files are gone or don't parse.
    pub available: bool,
}

fn bundled_name(id: &str) -> &'static str {
    match id {
        "en_US" => "English (US)",
        "es" => "Spanish",
        _ => "Spanish (Colombia)",
    }
}

/// `user:mine` → `user-mine`: `:` isn't allowed in Windows folder names.
fn folder(state: &AppState, id: &str) -> PathBuf {
    state
        .settings
        .dir()
        .join("dictionaries")
        .join(id.replace(':', "-"))
}

fn files(dir: &Path) -> (PathBuf, PathBuf) {
    (dir.join("index.aff"), dir.join("index.dic"))
}

fn spell_error(e: SpellError) -> CommandError {
    let kind = match e {
        SpellError::TooLarge(_) => ErrorKind::TooLarge,
        SpellError::Unreadable(_) => ErrorKind::Io,
        SpellError::Invalid(_) => ErrorKind::InvalidInput,
        SpellError::Unknown(_) => ErrorKind::NotFound,
    };
    CommandError::new(kind, e.to_string())
}

fn invalid(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::InvalidInput, message.into())
}

fn imported(state: &AppState) -> Vec<ImportedDictionary> {
    state.settings.get().0.imported_dictionaries
}

fn known(state: &AppState, id: &str) -> bool {
    BUNDLED.iter().any(|b| b.0 == id) || imported(state).iter().any(|d| d.id == id)
}

/// Loads `id` if it isn't yet; `false` when it can't be.
fn ensure(spell: &SpellState, state: &AppState, id: &str) -> bool {
    if spell.speller.is_loaded(id) {
        return true;
    }
    if BUNDLED.iter().any(|b| b.0 == id) {
        return spell.speller.load_bundled(id).is_ok();
    }
    if !imported(state).iter().any(|d| d.id == id) {
        return false;
    }
    let (aff, dic) = files(&folder(state, id));
    let times = (|| {
        let t = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        Some((t(&aff)?, t(&dic)?))
    })();
    let mut failed = spell.failed.lock().unwrap_or_else(|e| e.into_inner());
    if failed.get(id) == Some(&times) {
        return false;
    }
    spell.loads.fetch_add(1, Ordering::Relaxed);
    let ok = spell.speller.load_files(id, &aff, &dic).is_ok();
    if ok {
        failed.remove(id);
    } else {
        failed.insert(id.to_string(), times);
    }
    ok
}

fn active(spell: &SpellState, state: &AppState, lang: &str) -> Vec<String> {
    let from_vault = state
        .session()
        .ok()
        .and_then(|s| spell.vault_spelling(&s).0);
    let ids = from_vault
        .or(state.settings.get().0.spell_dictionaries)
        .unwrap_or_else(|| {
            vec![
                if lang.starts_with("es") {
                    "es"
                } else {
                    "en_US"
                }
                .to_string(),
            ]
        });
    ids.into_iter()
        .filter(|id| ensure(spell, state, id))
        .collect()
}

pub(crate) fn spell_dictionaries_impl(spell: &SpellState, state: &AppState) -> Vec<DictionaryDto> {
    let bundled = BUNDLED.iter().map(|b| DictionaryDto {
        id: b.0.to_string(),
        name: bundled_name(b.0).to_string(),
        bundled: true,
        available: true,
    });
    let imported = imported(state).into_iter().map(|d| {
        let (aff, dic) = files(&folder(state, &d.id));
        // Files deleted by hand stay loaded until restart; report them gone.
        let available = aff.is_file() && dic.is_file() && ensure(spell, state, &d.id);
        DictionaryDto {
            available,
            id: d.id,
            name: d.name,
            bundled: false,
        }
    });
    bundled.chain(imported).collect()
}

/// The imported pair `picked` points at (either file): checked, copied under
/// a fresh id, and listed.
pub(crate) fn spell_import_file(
    spell: &SpellState,
    state: &AppState,
    picked: &Path,
) -> CmdResult<DictionaryDto> {
    let ext = picked.extension().and_then(|e| e.to_str()).unwrap_or("");
    let (aff, dic) = match ext.to_ascii_lowercase().as_str() {
        "aff" => (picked.to_path_buf(), picked.with_extension("dic")),
        "dic" => (picked.with_extension("aff"), picked.to_path_buf()),
        _ => return Err(invalid("pick a .aff or .dic file")),
    };
    for (path, what) in [(&aff, ".aff"), (&dic, ".dic")] {
        if !path.is_file() {
            return Err(CommandError::new(
                ErrorKind::NotFound,
                format!("the {what} next to the picked file is missing"),
            ));
        }
    }
    validate(&aff, &dic).map_err(spell_error)?;
    let name = picked
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let taken = imported(state);
    let base = format!("user:{slug}");
    let id = (1..)
        .map(|n| {
            if n == 1 {
                base.clone()
            } else {
                format!("{base}-{n}")
            }
        })
        .find(|id| !taken.iter().any(|d| d.id == *id))
        .expect("an unused id");
    let dir = folder(state, &id);
    let (to_aff, to_dic) = files(&dir);
    let copied = std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::copy(&aff, &to_aff))
        .and_then(|_| std::fs::copy(&dic, &to_dic));
    if let Err(e) = copied {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e.into());
    }
    let entry = ImportedDictionary {
        id: id.clone(),
        name: name.clone(),
    };
    if let Err(e) = state
        .settings
        .modify(|s| s.imported_dictionaries.push(entry))
    {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e.into());
    }
    Ok(DictionaryDto {
        available: ensure(spell, state, &id),
        id,
        name,
        bundled: false,
    })
}

pub(crate) fn spell_remove_impl(spell: &SpellState, state: &AppState, id: String) -> CmdResult<()> {
    if BUNDLED.iter().any(|b| b.0 == id) {
        return Err(CommandError::new(
            ErrorKind::NotPermitted,
            "bundled dictionaries can't be removed",
        ));
    }
    if !imported(state).iter().any(|d| d.id == id) {
        return Err(CommandError::new(
            ErrorKind::NotFound,
            format!("no dictionary {id}"),
        ));
    }
    state.settings.modify(|s| {
        s.imported_dictionaries.retain(|d| d.id != id);
        if let Some(list) = s.spell_dictionaries.as_mut() {
            list.retain(|d| *d != id);
        }
    })?;
    if let Ok(session) = state.session() {
        let vault = session.vault();
        if let Some(mut ids) = vault.spelling_dictionaries()
            && ids.contains(&id)
        {
            ids.retain(|d| *d != id);
            vault.set_spelling_dictionaries(Some(&ids))?;
            spell.vault_changed();
        }
    }
    spell.speller.unload(&id);
    spell
        .failed
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    let dir = folder(state, &id);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

pub(crate) fn spell_check_impl(
    spell: &SpellState,
    state: &AppState,
    words: Vec<String>,
    lang: &str,
) -> CmdResult<Vec<bool>> {
    if words.len() > MAX_WORDS {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("at most {MAX_WORDS} words per check"),
        ));
    }
    let active = active(spell, state, lang);
    let session = state.session().ok();
    let mut extra = spell.ignores(session.as_ref());
    if let Some(s) = &session {
        extra.extend(spell.vault_spelling(s).1);
    }
    Ok(spell.speller.check(&active, &extra, &words))
}

fn valid_word(word: &str) -> CmdResult<()> {
    let ok = !word.is_empty()
        && word.chars().count() <= MAX_WORD_CHARS
        && !word.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then_some(()).ok_or_else(|| invalid("not a single word"))
}

pub(crate) fn spell_vault_set_impl(
    spell: &SpellState,
    state: &AppState,
    ids: Option<Vec<String>>,
) -> CmdResult<()> {
    if let Some(unknown) = ids.iter().flatten().find(|id| !known(state, id)) {
        return Err(invalid(format!("unknown dictionary {unknown}")));
    }
    state
        .session()?
        .vault()
        .set_spelling_dictionaries(ids.as_deref())?;
    spell.vault_changed();
    Ok(())
}

#[tauri::command]
pub async fn spell_dictionaries<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<DictionaryDto>> {
    blocking(app, |app| {
        Ok(spell_dictionaries_impl(
            &app.state::<SpellState>(),
            &app.state::<AppState>(),
        ))
    })
    .await
}

#[tauri::command]
pub async fn spell_import<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<DictionaryDto>> {
    blocking(app, |app| {
        let state = app.state::<AppState>();
        // Tests replace the dialog through the cover picker hook (M2c §7.4).
        let picked = match state.cover_picker() {
            Some(pick) => pick(),
            None => app
                .dialog()
                .file()
                .add_filter("Hunspell dictionary", &["aff", "dic"])
                .blocking_pick_file()
                .and_then(|f| f.into_path().ok()),
        };
        picked
            .map(|p| spell_import_file(&app.state::<SpellState>(), &state, &p))
            .transpose()
    })
    .await
}

#[tauri::command]
pub async fn spell_remove<R: Runtime>(app: AppHandle<R>, id: String) -> CmdResult<()> {
    blocking(app, move |app| {
        spell_remove_impl(&app.state::<SpellState>(), &app.state::<AppState>(), id)
    })
    .await
}

#[tauri::command]
pub async fn spell_check<R: Runtime>(
    app: AppHandle<R>,
    words: Vec<String>,
    lang: String,
) -> CmdResult<Vec<bool>> {
    blocking(app, move |app| {
        spell_check_impl(
            &app.state::<SpellState>(),
            &app.state::<AppState>(),
            words,
            &lang,
        )
    })
    .await
}

#[tauri::command]
pub async fn spell_suggest<R: Runtime>(
    app: AppHandle<R>,
    word: String,
    lang: String,
) -> CmdResult<Vec<String>> {
    blocking(app, move |app| {
        let spell = app.state::<SpellState>();
        let active = active(&spell, &app.state::<AppState>(), &lang);
        Ok(spell.speller.suggest(&active, &word))
    })
    .await
}

#[tauri::command]
pub async fn spell_add_word<R: Runtime>(app: AppHandle<R>, word: String) -> CmdResult<()> {
    blocking(app, move |app| {
        valid_word(&word)?;
        app.state::<AppState>()
            .session()?
            .vault()
            .add_spelling_word(&word)?;
        app.state::<SpellState>().vault_changed();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn spell_ignore<R: Runtime>(app: AppHandle<R>, word: String) -> CmdResult<()> {
    blocking(app, move |app| {
        valid_word(&word)?;
        let session = app.state::<AppState>().session()?;
        app.state::<SpellState>().ignore(&session, word);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn spell_words<R: Runtime>(app: AppHandle<R>) -> CmdResult<Vec<String>> {
    blocking(app, |app| {
        Ok(app.state::<AppState>().session()?.vault().spelling_words())
    })
    .await
}

#[tauri::command]
pub async fn spell_remove_word<R: Runtime>(app: AppHandle<R>, word: String) -> CmdResult<()> {
    blocking(app, move |app| {
        app.state::<AppState>()
            .session()?
            .vault()
            .remove_spelling_word(&word)?;
        app.state::<SpellState>().vault_changed();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn spell_vault_get<R: Runtime>(app: AppHandle<R>) -> CmdResult<Option<Vec<String>>> {
    blocking(app, |app| {
        Ok(app
            .state::<AppState>()
            .session()?
            .vault()
            .spelling_dictionaries())
    })
    .await
}

#[tauri::command]
pub async fn spell_vault_set<R: Runtime>(
    app: AppHandle<R>,
    ids: Option<Vec<String>>,
) -> CmdResult<()> {
    blocking(app, move |app| {
        spell_vault_set_impl(&app.state::<SpellState>(), &app.state::<AppState>(), ids)
    })
    .await
}
