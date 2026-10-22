//! Decrypting an encrypted vault in place (encryption UX spec §10), the
//! mirror of [`super::convert`]: the folder keeps its path; nothing encrypted
//! is removed before every file is written in the clear and verified, and the
//! encrypted entries only move inside the vault folder until the finish
//! deletes them, the keys first.
//!
//! ```text
//!   preflight ─ nothing changed; a blocking list
//!   begin     ─ journal {copying} → <root>/.liber-decrypting/
//!   copy      ─ stamps recorded → each file streamed out, synced, read back, SHA-256 compared, mtime set
//!   stage     ─ re-check → d/, README.txt, header copies, liber-vault.json (last) into .liber-encrypted/
//!               → re-check → {staged}
//!   commit    ─ {committing} → each entry of .liber-decrypting/ up → {committed} (the root reads plain)
//!   finish    ─ delete the header and its copies (the keys) → delete .liber-encrypted/ (the ciphertext)
//!               → forget the vault id (rollback memory) → remove .liber-decrypting/ → remove the journal, last
//! ```
//!
//! A crash anywhere is recovered by [`recover`] on the next open, following
//! the journal: before `staged` it rolls back (the readable copy is deleted,
//! the vault is as it was), from `staged` on it rolls forward. The engine
//! never cleans up after its own errors: the caller calls [`recover`] (or
//! [`rollback`]). Only this device's journal is acted on.

use super::convert::{
    self, Blocked, ConvertError, Preflight, Reason, Result, Tree, check_same, exists, hex, io,
    join, listed, move_new, now_secs, refuse_folder, reserved_like, stamp, write_json,
};
use super::header::is_header_copy;
use super::names::fold;
use super::{
    DATA_DIR, EncryptedStorage, HEADER_FILE, README_FILE, VaultKind, content_err, read_header,
    vault_kind,
};
use crate::error::VaultError;
use crate::path::VaultPath;
use crate::storage::plain::{canonical_root, sync_dir};
use crate::storage::{Child, Follow, Kind, Reach, Storage};
use liber_crypto::{RecoveryCode, Unlock, VaultHeader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

/// The decryption's journal at the vault root: plain JSON, no secrets.
pub const JOURNAL: &str = ".liber-decrypt.json";
/// The readable tree while it fills.
pub const STAGING: &str = ".liber-decrypting";
/// The encrypted entries between staging and their deletion.
pub const RETIRED: &str = ".liber-encrypted";
const JOURNAL_TMP: &str = ".liber-decrypt.json.tmp";
pub(super) const RESERVED: [&str; 4] = [JOURNAL, JOURNAL_TMP, STAGING, RETIRED];
const JOURNAL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Copying,
    /// Nothing encrypted is at the root any more: from here recovery rolls forward.
    Staged,
    Committing,
    /// The readable tree is at the root.
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    pub phase: Phase,
    /// Unix seconds.
    pub started: u64,
    /// The device that decrypts: only it recovers.
    pub install_id: String,
    /// The vault's id (hex): its rollback memory is forgotten at the finish.
    pub vault_id: String,
    /// This run created `.liber-decrypting/` (only then is it removed).
    #[serde(default)]
    pub staging_created: bool,
    /// This run created `.liber-encrypted/` (only then are its entries moved back).
    #[serde(default)]
    pub retired_created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoverOutcome {
    /// No journal.
    Nothing,
    /// Another install's decryption, before its commit: nothing touched.
    OtherDevice,
    /// Another install's decryption, committed: the vault opens as plain;
    /// that device finishes. Nothing touched.
    FinishingElsewhere,
    /// Interrupted before `staged`: the vault is encrypted as it was.
    RolledBack,
    /// Finished now: the vault is plain.
    Finished,
}

/// Where a test can make a run stop as if the app died (`test-params` only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashPoint {
    AfterJournal,
    /// `.liber-decrypting/` made, the journal not yet saying so.
    AfterStagingDir,
    /// After this many files written and checked.
    Copied(usize),
    /// After this many encrypted entries moved into `.liber-encrypted/`.
    Retiring(usize),
    /// Every encrypted entry moved and re-checked, `staged` not yet written.
    AllRetired,
    AfterStaged,
    /// `committing` written, nothing moved up yet.
    AfterCommitting,
    /// After this many readable entries moved up.
    Committing(usize),
    AfterCommitted,
    /// The header and its copies deleted.
    AfterKeys,
    AfterCiphertext,
    AfterEpoch,
    AfterStagingRemoved,
    /// During a rollback, after this many entries moved back (0: before any).
    Unretiring(usize),
}

/// Decides, at each point, whether to stop there (and may act, as a sync would).
#[cfg(feature = "test-params")]
pub type CrashHook = Box<dyn FnMut(CrashPoint) -> bool>;

#[cfg(feature = "test-params")]
thread_local! {
    static CRASH: std::cell::RefCell<Option<CrashHook>> = const { std::cell::RefCell::new(None) };
}

/// Makes this thread's next run stop at `p` (`None` clears it).
#[cfg(feature = "test-params")]
pub fn crash_at(p: Option<CrashPoint>) {
    crash_when(p.map(|p| Box::new(move |q| q == p) as CrashHook));
}

/// Calls `hook` at every crash point on this thread; it stops the run there
/// by returning `true` (`None` clears it).
#[cfg(feature = "test-params")]
pub fn crash_when(hook: Option<CrashHook>) {
    CRASH.with(|c| *c.borrow_mut() = hook);
}

fn crash(at: CrashPoint) -> Result<()> {
    #[cfg(feature = "test-params")]
    if CRASH.with(|c| c.borrow_mut().as_mut().is_some_and(|h| h(at))) {
        return Err(ConvertError::Refused(format!("injected crash at {at:?}")));
    }
    let _ = at;
    Ok(())
}

/// Forgets the vault id (hex) in this device's rollback memory (the desktop's).
pub type Forget<'a> = &'a dyn Fn(&str) -> std::io::Result<()>;

/// The journal, `None` if there is none; an unreadable one is `Damaged`.
pub fn read_journal(root: &Path) -> Result<Option<Journal>> {
    let bytes = match std::fs::read(root.join(JOURNAL)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(JOURNAL)(e)),
    };
    if !listed(root, JOURNAL) {
        return Ok(None);
    }
    let damaged = |why: String| VaultError::Damaged(format!("{JOURNAL}: {why}"));
    let j: Journal = serde_json::from_slice(&bytes).map_err(|e| damaged(e.to_string()))?;
    if j.version != JOURNAL_VERSION {
        return Err(damaged(format!("unknown version {}", j.version)).into());
    }
    Ok(Some(j))
}

fn write_journal(root: &Path, j: &Journal) -> Result<()> {
    write_json(root, JOURNAL, JOURNAL_TMP, j)
}

/// Opens the vault at `root` with its passphrase, after checking the
/// passphrase and the recovery code each on its own (§10.2): `WrongSecrets`
/// says which opens no slot (`recovery: None` is a code that didn't parse).
pub fn open_with_both(
    root: &Path,
    passphrase: &str,
    recovery: Option<&RecoveryCode>,
) -> Result<EncryptedStorage> {
    let wrong = |r: crate::Result<()>| match r {
        Ok(()) => Ok(false),
        Err(VaultError::WrongSecret) => Ok(true),
        Err(e) => Err(ConvertError::Vault(e)),
    };
    let by_pass = EncryptedStorage::unlock(root, Unlock::Passphrase(passphrase));
    let (storage, pass_wrong) = match by_pass {
        Ok((s, _)) => (Some(s), false),
        Err(e) => (None, wrong(Err(e))?),
    };
    let rec_wrong = match recovery {
        None => true,
        Some(code) => {
            let by_code = EncryptedStorage::unlock(root, Unlock::Recovery(code));
            match (by_code, &storage) {
                // The same header: one vault, both secrets.
                (Ok((r, _)), Some(s)) if r.vault_id() != s.vault_id() => true,
                (Ok(_), _) => false,
                (Err(e), _) => wrong(Err(e))?,
            }
        }
    };
    match storage {
        Some(s) if !rec_wrong => Ok(s),
        _ => Err(ConvertError::WrongSecrets {
            passphrase: pass_wrong,
            recovery: rec_wrong,
        }),
    }
}

/// A decryption between [`begin`] and [`stage_and_commit`].
pub struct Decrypting {
    root: PathBuf,
    storage: EncryptedStorage,
    journal: Journal,
    /// The encrypted entries as [`copy`] found them.
    cipher: Option<Tree>,
    /// The root's other entries' names as [`copy`] found them.
    extras: BTreeSet<OsString>,
    /// `.liber-decrypting/` as [`copy`] wrote it.
    plain: Option<Tree>,
}

impl Decrypting {
    /// Canonical.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn vault_id(&self) -> [u8; 16] {
        self.storage.vault_id()
    }
}

/// The encrypted vault's own entries in `dir` (its root, or `.liber-encrypted/`):
/// `d/`, `README.txt`, the header's sync-conflict copies, and the header, last.
fn ours(dir: &Path) -> Result<Vec<OsString>> {
    let mut names = Vec::new();
    let mut header = false;
    for item in std::fs::read_dir(dir).map_err(io(dir.display()))? {
        let name = item.map_err(io(dir.display()))?.file_name();
        match name.to_str() {
            Some(HEADER_FILE) => header = true,
            Some(DATA_DIR | README_FILE) => names.push(name),
            Some(n) if is_header_copy(n) => names.push(name),
            _ => {}
        }
    }
    names.sort();
    if header {
        names.push(HEADER_FILE.into());
    }
    Ok(names)
}

/// Every physical entry under `base/<name>` for each of `names`, with stamps.
fn physical(base: &Path, names: &[OsString]) -> Tree {
    fn walk(base: &Path, rel: &str, out: &mut Tree) {
        let p = base.join(rel);
        let Ok(meta) = p.symlink_metadata() else {
            return out.blocked.push(Blocked {
                path: rel.to_string(),
                reason: Reason::Unreadable,
            });
        };
        if !meta.is_dir() {
            out.files.insert(rel.to_string(), stamp(&meta));
            return;
        }
        out.dirs.insert(rel.to_string());
        let Ok(items) = std::fs::read_dir(&p) else {
            return out.blocked.push(Blocked {
                path: rel.to_string(),
                reason: Reason::Unreadable,
            });
        };
        let mut subs: Vec<String> = items
            .flatten()
            .map(|i| join(rel, &i.file_name().to_string_lossy()))
            .collect();
        subs.sort();
        for sub in subs {
            walk(base, &sub, out);
        }
    }
    let mut out = Tree::default();
    for name in names {
        walk(base, &name.to_string_lossy(), &mut out);
    }
    out
}

/// Every entry under `dir` (the readable staging folder).
fn everything(dir: &Path) -> Result<Tree> {
    let mut names: Vec<OsString> = std::fs::read_dir(dir)
        .map_err(io(dir.display()))?
        .flatten()
        .map(|i| i.file_name())
        .collect();
    names.sort();
    Ok(physical(dir, &names))
}

/// The root's entries that are neither the vault's own nor decrypt's names.
fn extras(root: &Path) -> Result<BTreeSet<OsString>> {
    let ours: BTreeSet<OsString> = ours(root)?.into_iter().collect();
    let mut out = BTreeSet::new();
    for item in std::fs::read_dir(root).map_err(io(root.display()))? {
        let name = item.map_err(io(root.display()))?.file_name();
        let reserved = name.to_str().is_some_and(|n| RESERVED.contains(&n));
        if !ours.contains(&name) && !reserved {
            out.insert(name);
        }
    }
    Ok(out)
}

/// `Changed` for a newcomer at the root since `before` (OS junk aside).
fn newcomers(root: &Path, before: &BTreeSet<OsString>) -> Result<()> {
    let junk = |n: &OsString| n.to_str().is_some_and(|n| convert::JUNK.contains(&n));
    match extras(root)?
        .into_iter()
        .find(|n| !before.contains(n) && !junk(n))
    {
        Some(n) => Err(ConvertError::Changed(n.to_string_lossy().into_owned())),
        None => Ok(()),
    }
}

/// The readable tree the vault holds: its files (with plaintext lengths) and
/// folders, logical and `/`-separated, and what blocks decrypting it.
#[derive(Default)]
struct Logical {
    files: Vec<(String, u64)>,
    dirs: Vec<String>,
    blocked: Vec<Blocked>,
}

fn logical(s: &EncryptedStorage, root: &Path) -> Result<Logical> {
    let mut out = Logical::default();
    walk_logical(s, root, "", &mut out)?;
    // Names that couldn't be decrypted would be lost with the ciphertext.
    for (p, _) in s.unreadable() {
        let rel = p.strip_prefix(root).unwrap_or(&p);
        out.blocked.push(Blocked {
            path: rel.to_string_lossy().replace('\\', "/"),
            reason: Reason::Unreadable,
        });
    }
    Ok(out)
}

fn walk_logical(s: &EncryptedStorage, root: &Path, rel: &str, out: &mut Logical) -> Result<()> {
    let vp = if rel.is_empty() {
        VaultPath::root()
    } else {
        VaultPath::new(rel)?
    };
    let mut subdirs = Vec::new();
    let mut names = Vec::new();
    for child in s.children(&vp)? {
        let Child::Entry { name, meta } = child else {
            continue; // listed by `unreadable`
        };
        let path = join(rel, &name);
        match meta.kind {
            Kind::Dir => subdirs.push(path),
            Kind::File => out.files.push((path, meta.len)),
            _ => {}
        }
        names.push((name, meta.kind));
    }
    if would_be_vault(s, rel, &names)? {
        let path = if rel.is_empty() { HEADER_FILE } else { rel };
        out.blocked.push(Blocked {
            path: path.to_string(),
            reason: Reason::Vault,
        });
    }
    if rel.is_empty() {
        top_level(root, &names, out)?;
    }
    subdirs.sort();
    for sub in subdirs {
        out.dirs.push(sub.clone());
        walk_logical(s, root, &sub, out)?;
    }
    Ok(())
}

/// Whether the folder `rel`, once readable, would read as an encrypted (or
/// damaged) vault of its own (`vault_kind`): a header that parses, or a `d/`
/// holding ciphertext names.
fn would_be_vault(s: &EncryptedStorage, rel: &str, names: &[(String, Kind)]) -> Result<bool> {
    for (name, kind) in names {
        let path = join(rel, name);
        if *kind == Kind::File && name.eq_ignore_ascii_case(HEADER_FILE) {
            let vp = VaultPath::new(&path)?;
            let small = s
                .meta(&vp, Follow::No)?
                .is_some_and(|m| m.len <= liber_crypto::MAX_HEADER_BYTES as u64);
            if small && VaultHeader::parse(&s.read(&vp)?).is_ok() {
                return Ok(true);
            }
        }
        if *kind == Kind::Dir && name.eq_ignore_ascii_case(DATA_DIR) {
            let cipher = s.children(&VaultPath::new(&path)?)?.iter().any(|c| {
                matches!(c, Child::Entry { name, .. }
                    if [".libere", ".liberl", ".libern"].iter().any(|x| name.ends_with(x)))
            });
            if cipher {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// A top-level readable name that is one of the conversions' own (`reserved`)
/// or already used by a readable entry beside the vault (`taken`).
fn top_level(root: &Path, names: &[(String, Kind)], out: &mut Logical) -> Result<()> {
    let ours: BTreeSet<OsString> = ours(root)?.into_iter().collect();
    let beside: Vec<String> = std::fs::read_dir(root)
        .map_err(io(root.display()))?
        .flatten()
        .map(|i| i.file_name())
        .filter(|n| !ours.contains(n))
        .map(|n| fold(&n.to_string_lossy()))
        .collect();
    for (name, _) in names {
        let reason = if reserved_like(name) {
            Some(Reason::Reserved)
        } else if beside.contains(&fold(name)) {
            Some(Reason::Taken)
        } else {
            None
        };
        if let Some(reason) = reason {
            out.blocked.push(Blocked {
                path: name.clone(),
                reason,
            });
        }
    }
    Ok(())
}

/// What would block decrypting the unlocked vault `s` in place. Changes
/// nothing. The whole folder is refused (`Err`) when it is a refused folder,
/// inside another encrypted vault, not an encrypted vault, or part-way
/// through a conversion either way.
pub fn preflight(s: &EncryptedStorage, refused: &[PathBuf]) -> Result<Preflight> {
    let root = canonical_root(s.location())?;
    refuse_folder(&root, refused)?;
    if let Some(vault) = root
        .ancestors()
        .skip(1)
        .find(|a| !matches!(vault_kind(a), VaultKind::Plain))
    {
        return Err(ConvertError::InsideVault(vault.display().to_string()));
    }
    if convert::read_journal(&root)?.is_some() || read_journal(&root)?.is_some() {
        return Err(ConvertError::Pending);
    }
    match vault_kind(&root) {
        VaultKind::Encrypted => {}
        VaultKind::Plain => {
            return Err(ConvertError::Refused(
                "This folder isn't an encrypted vault".into(),
            ));
        }
        VaultKind::Damaged(why) => {
            return Err(VaultError::Damaged(format!("{}: {why}", root.display())).into());
        }
    }
    let tree = logical(s, &root)?;
    let mut blocked = tree.blocked;
    // Leftovers under the conversions' names at the root, with no journal.
    for item in std::fs::read_dir(&root).map_err(io(root.display()))? {
        let name = item.map_err(io(root.display()))?.file_name();
        let name = name.to_string_lossy();
        if reserved_like(&name) {
            blocked.push(Blocked {
                path: name.into_owned(),
                reason: Reason::Reserved,
            });
        }
    }
    Ok(Preflight {
        files: tree.files.len() as u64,
        bytes: tree.files.iter().map(|(_, len)| len).sum(),
        blocked,
    })
}

/// Preflight, then the journal (`copying`), then the empty readable staging
/// folder. `storage` is the vault, unlocked (by [`open_with_both`]). On
/// error, the caller calls [`rollback`].
pub fn begin(
    storage: EncryptedStorage,
    refused: &[PathBuf],
    install_id: &str,
) -> Result<Decrypting> {
    let pre = preflight(&storage, refused)?;
    if !pre.blocked.is_empty() {
        return Err(ConvertError::Blocked(pre.blocked));
    }
    let root = canonical_root(storage.location())?;
    let mut journal = Journal {
        version: JOURNAL_VERSION,
        phase: Phase::Copying,
        started: now_secs(),
        install_id: install_id.to_string(),
        vault_id: hex(&storage.vault_id()),
        staging_created: false,
        retired_created: false,
    };
    write_journal(&root, &journal)?;
    crash(CrashPoint::AfterJournal)?;
    // Fails on anything already there, a lookalike name included.
    std::fs::create_dir(root.join(STAGING)).map_err(io(STAGING))?;
    crash(CrashPoint::AfterStagingDir)?;
    journal.staging_created = true;
    write_journal(&root, &journal)?;
    Ok(Decrypting {
        root,
        storage,
        journal,
        cipher: None,
        extras: BTreeSet::new(),
        plain: None,
    })
}

/// Writes every folder and file into `.liber-decrypting/`: each file streamed
/// out, synced, read back and compared by SHA-256, its mtime kept.
/// `progress(done, total)` after each file; `cancel` is checked between
/// files (`Cancelled`). On error, the caller calls [`recover`].
pub fn copy(
    d: &mut Decrypting,
    mut progress: impl FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<()> {
    let tree = logical(&d.storage, &d.root)?;
    if !tree.blocked.is_empty() {
        return Err(ConvertError::Blocked(tree.blocked));
    }
    // Recorded first: a sync that changes them while this runs stops the stage.
    let cipher = physical(&d.root, &ours(&d.root)?);
    if let Some(b) = cipher.blocked.first() {
        return Err(ConvertError::Changed(b.path.clone()));
    }
    d.cipher = Some(cipher);
    d.extras = extras(&d.root)?;
    let staging = d.root.join(STAGING);
    for dir in &tree.dirs {
        std::fs::create_dir(staging.join(dir)).map_err(io(dir))?;
    }
    let total = tree.files.len() as u64;
    progress(0, total);
    for (done, (rel, _)) in tree.files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(ConvertError::Cancelled);
        }
        copy_out(&d.storage, &staging, rel)?;
        progress(done as u64 + 1, total);
        crash(CrashPoint::Copied(done + 1))?;
    }
    sync_dir(&staging);
    d.plain = Some(everything(&staging)?);
    Ok(())
}

fn copy_out(s: &EncryptedStorage, staging: &Path, rel: &str) -> Result<()> {
    let vp = VaultPath::new(rel)?;
    let meta = s
        .meta(&vp, Follow::No)?
        .ok_or_else(|| VaultError::NotFound(rel.to_string()))?;
    let mut from = s.open_read(&vp, Reach::Any)?.inner;
    let to = staging.join(rel);
    let mut out = File::options()
        .write(true)
        .create_new(true)
        .open(&to)
        .map_err(io(rel))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        // A file that fails to decrypt is `damaged`; a lock under it, `Locked`.
        let n = from
            .read(&mut buf)
            .map_err(|e| ConvertError::Vault(content_err(&vp, e.into())))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(io(rel))?;
    }
    let wrote: [u8; 32] = hash.finalize().into();
    if meta.mtime_ns >= 0 {
        let t = SystemTime::UNIX_EPOCH + Duration::from_nanos(meta.mtime_ns as u64);
        out.set_modified(t).map_err(io(rel))?;
    }
    out.sync_all().map_err(io(rel))?;
    drop(out);
    let read = convert::sha256(File::open(&to).map_err(io(rel))?, |_| Ok(())).map_err(io(rel))?;
    if read != wrote {
        return Err(ConvertError::Mismatch(rel.to_string()));
    }
    Ok(())
}

/// Re-checks the encrypted entries and the readable copy against what
/// [`copy`] recorded, moves the encrypted entries into `.liber-encrypted/`
/// (the header last) and checks them there, writes `staged`, then commits.
/// On error, the caller calls [`recover`]: before `staged` it rolls back.
pub fn stage_and_commit(d: Decrypting) -> Result<()> {
    let Decrypting {
        root,
        storage,
        mut journal,
        cipher,
        extras: before,
        plain,
    } = d;
    drop(storage);
    let not_copied = || ConvertError::Refused("nothing was decrypted yet: copy first".into());
    let (cipher, plain) = (
        cipher.ok_or_else(not_copied)?,
        plain.ok_or_else(not_copied)?,
    );
    check_same(&physical(&root, &ours(&root)?), &cipher, false)?;
    check_same(&everything(&root.join(STAGING))?, &plain, false)?;
    newcomers(&root, &before)?;
    let retired = root.join(RETIRED);
    // Fails on anything already there, a lookalike name included.
    std::fs::create_dir(&retired).map_err(io(RETIRED))?;
    journal.retired_created = true;
    write_journal(&root, &journal)?;
    for (n, name) in ours(&root)?.iter().enumerate() {
        move_new(&root.join(name), &retired.join(name))?;
        crash(CrashPoint::Retiring(n + 1))?;
    }
    sync_dir(&retired);
    sync_dir(&root);
    // A sync that wrote between the check and a move, or a newcomer.
    check_same(&physical(&retired, &ours(&retired)?), &cipher, true)?;
    newcomers(&root, &before)?;
    if let Some(left) = ours(&root)?.first() {
        return Err(ConvertError::Changed(left.to_string_lossy().into_owned()));
    }
    crash(CrashPoint::AllRetired)?;
    journal.phase = Phase::Staged;
    write_journal(&root, &journal)?;
    crash(CrashPoint::AfterStaged)?;
    commit(&root, &mut journal)
}

/// Moves the readable tree up, skipping what a crash already moved; then
/// `committed` once the root reads as a plain vault.
fn commit(root: &Path, journal: &mut Journal) -> Result<()> {
    let staging = root.join(STAGING);
    // Never roll forward into deleting the ciphertext without the readable copy.
    if journal.phase == Phase::Staged && !listed(root, STAGING) {
        return Err(VaultError::Damaged(format!(
            "{STAGING} is missing from {}: nothing was deleted",
            root.display()
        ))
        .into());
    }
    if journal.phase != Phase::Committing {
        journal.phase = Phase::Committing;
        write_journal(root, journal)?;
    }
    crash(CrashPoint::AfterCommitting)?;
    if listed(root, STAGING) {
        let mut names: Vec<OsString> = std::fs::read_dir(&staging)
            .map_err(io(STAGING))?
            .map(|e| e.map(|e| e.file_name()))
            .collect::<std::io::Result<_>>()
            .map_err(io(STAGING))?;
        names.sort();
        for (i, name) in names.iter().enumerate() {
            move_new(&staging.join(name), &root.join(name))?;
            crash(CrashPoint::Committing(i + 1))?;
        }
    }
    sync_dir(root);
    if vault_kind(root) != VaultKind::Plain {
        return Err(VaultError::Damaged(format!(
            "{} still reads as an encrypted vault",
            root.display()
        ))
        .into());
    }
    journal.phase = Phase::Committed;
    write_journal(root, journal)?;
    crash(CrashPoint::AfterCommitted)
}

/// The finish steps (§10.3): the keys (the header and its copies) deleted
/// first, then the ciphertext, then the vault id forgotten, the empty
/// staging folder removed, and the journal last.
pub fn finish(root: &Path, forget: Forget<'_>) -> Result<()> {
    let root = canonical_root(root)?;
    let journal = read_journal(&root)?
        .ok_or_else(|| ConvertError::Refused("there is no decryption to finish".into()))?;
    if journal.phase != Phase::Committed {
        return Err(ConvertError::Refused(format!(
            "a decryption at {:?} can't finish yet",
            journal.phase
        )));
    }
    let retired = root.join(RETIRED);
    if listed(&root, RETIRED) && journal.retired_created {
        for name in ours(&retired)? {
            let key = name
                .to_str()
                .is_some_and(|n| n == HEADER_FILE || is_header_copy(n));
            if key {
                match std::fs::remove_file(retired.join(&name)) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        return Err(io(RETIRED)(e));
                    }
                    _ => {}
                }
            }
        }
        sync_dir(&retired);
        crash(CrashPoint::AfterKeys)?;
        std::fs::remove_dir_all(&retired).map_err(io(RETIRED))?;
        sync_dir(&root);
        crash(CrashPoint::AfterCiphertext)?;
    }
    forget(&journal.vault_id).map_err(io("the rollback memory"))?;
    crash(CrashPoint::AfterEpoch)?;
    if listed(&root, STAGING) {
        // Empty after the commit; anything a sync put there since stays.
        let _ = std::fs::remove_dir(root.join(STAGING));
    }
    crash(CrashPoint::AfterStagingRemoved)?;
    if listed(&root, JOURNAL_TMP) {
        let _ = std::fs::remove_file(root.join(JOURNAL_TMP));
    }
    std::fs::remove_file(root.join(JOURNAL)).map_err(io(JOURNAL))?;
    sync_dir(&root);
    Ok(())
}

/// Undoes a decryption before `staged`: every encrypted entry back from
/// `.liber-encrypted/` (a collision stops it, never overwrites; the header
/// last), the readable staging folder deleted, the journal last. Refused
/// from `staged` on.
pub fn rollback(root: &Path) -> Result<()> {
    let root = canonical_root(root)?;
    let Some(journal) = read_journal(&root)? else {
        return Ok(());
    };
    if journal.phase != Phase::Copying {
        return Err(ConvertError::Refused(
            "this decryption can't be undone any more: opening the vault finishes it".into(),
        ));
    }
    let retired = root.join(RETIRED);
    let ours_retired = listed(&root, RETIRED)
        && (journal.retired_created
            || std::fs::read_dir(&retired).is_ok_and(|mut d| d.next().is_none()));
    if ours_retired {
        let mut names: Vec<OsString> = std::fs::read_dir(&retired)
            .map_err(io(RETIRED))?
            .map(|e| e.map(|e| e.file_name()))
            .collect::<std::io::Result<_>>()
            .map_err(io(RETIRED))?;
        // The header last: the root reads as a vault only once `d/` is back.
        names.sort_by_key(|n| (n == HEADER_FILE, n.clone()));
        // All checked first: a collision moves nothing back.
        if let Some(n) = names.iter().find(|n| exists(&root.join(n))) {
            return Err(ConvertError::Collision(root.join(n).display().to_string()));
        }
        crash(CrashPoint::Unretiring(0))?;
        for (i, n) in names.iter().enumerate() {
            move_new(&retired.join(n), &root.join(n))?;
            crash(CrashPoint::Unretiring(i + 1))?;
        }
        std::fs::remove_dir(&retired).map_err(io(RETIRED))?;
    }
    if listed(&root, STAGING) {
        let staging = root.join(STAGING);
        if journal.staging_created {
            // The readable copy: the encrypted vault is intact, so it goes.
            std::fs::remove_dir_all(&staging).map_err(io(STAGING))?;
        } else {
            // Made just before the journal said so: empty.
            let _ = std::fs::remove_dir(&staging);
        }
    }
    if listed(&root, JOURNAL_TMP) {
        let _ = std::fs::remove_file(root.join(JOURNAL_TMP));
    }
    std::fs::remove_file(root.join(JOURNAL)).map_err(io(JOURNAL))?;
    sync_dir(&root);
    Ok(())
}

/// What an open does first: follows this device's journal to a rollback or
/// a finish. Another device's is left alone.
pub fn recover(root: &Path, install_id: &str, forget: Forget<'_>) -> Result<RecoverOutcome> {
    let root = canonical_root(root)?;
    let Some(mut journal) = read_journal(&root)? else {
        return Ok(RecoverOutcome::Nothing);
    };
    if journal.install_id != install_id {
        let committed = journal.phase == Phase::Committed && vault_kind(&root) == VaultKind::Plain;
        return Ok(if committed {
            RecoverOutcome::FinishingElsewhere
        } else {
            RecoverOutcome::OtherDevice
        });
    }
    match journal.phase {
        Phase::Copying => {
            rollback(&root)?;
            return Ok(RecoverOutcome::RolledBack);
        }
        Phase::Staged | Phase::Committing => commit(&root, &mut journal)?,
        Phase::Committed => {}
    }
    finish(&root, forget)?;
    Ok(RecoverOutcome::Finished)
}

/// The header at `root` parses (a test helper's check that keys remain).
#[doc(hidden)]
pub fn holds_a_header(dir: &Path) -> bool {
    read_header(&dir.join(HEADER_FILE))
        .ok()
        .is_some_and(|b| VaultHeader::parse(&b).is_ok())
}
