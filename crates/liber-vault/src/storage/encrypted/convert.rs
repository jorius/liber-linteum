//! Encrypting a plain vault in place (encryption UX spec §4.3 and §8, whose
//! builder-check answers win where they differ). The folder keeps its path;
//! no plaintext file is removed before every file is copied and verified, and
//! the originals only move inside the vault folder until the final trash.
//!
//! ```text
//!   preflight ─ nothing changed; a blocking list
//!   begin     ─ journal {copying} → <root>/.liber-converting/ (a new vault) → journal + vaultId
//!   copy      ─ each file streamed in, read back, SHA-256 compared, mtime set
//!   stage     ─ re-check against the record → originals into .liber-plain/ → re-check → {staged}
//!   commit    ─ {committing} → d/ up → README.txt up → liber-vault.json up (the commit point) → {committed}
//!   finish    ─ drop the plaintext index → .liber-plain/ renamed visibly → trash (or {trashPending})
//!               → remove .liber-converting/ → remove the journal, last
//! ```
//!
//! A crash anywhere is recovered by [`recover`] on the next open, following
//! the journal, never the presence of a header: before `staged` it rolls back,
//! from `staged` on it rolls forward. The engine never cleans up after its own
//! errors: the caller calls [`recover`] (or [`rollback`]), which is exactly
//! what an open after a crash does. Only this device's journal is acted on.
//!
//! A readable backup (§9) may be written between [`begin`] and [`copy`]:
//! [`backup`] copies and verifies every file into an empty folder outside the
//! vault, and [`copy`] then refuses a tree that changed since.

use super::names::fold;
use super::{
    DATA_DIR, EncryptedStorage, HEADER_FILE, README_FILE, VaultKind, content_err, read_header,
    vault_kind,
};
use crate::error::{VaultError, io_err};
use crate::path::VaultPath;
use crate::storage::plain::{canonical_root, sync_dir};
use liber_crypto::{RecoveryCode, StreamReader, VaultHeader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::OsString;
use std::fs::{File, Metadata};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;
use unicode_normalization::UnicodeNormalization;

/// The conversion's journal at the vault root: plain JSON, no secrets.
pub const JOURNAL: &str = ".liber-convert.json";
/// The new encrypted vault while it fills.
pub const STAGING: &str = ".liber-converting";
/// The originals between staging and the trash.
pub const ORIGINALS: &str = ".liber-plain";
/// The journal's temp name while it is rewritten.
const JOURNAL_TMP: &str = ".liber-convert.json.tmp";
pub(super) const RESERVED: [&str; 4] = [JOURNAL, JOURNAL_TMP, STAGING, ORIGINALS];
/// Top-level entries that stay plaintext at the root, neither copied nor
/// staged (§8.5): sync-tool control files only. The root's `.DS_Store` and
/// `Thumbs.db` hold plaintext names and thumbnails: they go to the trash with
/// the originals (review judgment change).
pub(super) const KEPT: [&str; 8] = [
    ".stfolder",
    ".stignore",
    ".stversions",
    ".sync",
    ".dropbox",
    ".dropbox.attr",
    "Icon\r",
    "desktop.ini",
];
/// OS junk, never copied at any depth (below the root it goes with its folder).
pub(super) const JUNK: [&str; 4] = [".DS_Store", "Thumbs.db", "desktop.ini", "Icon\r"];
const JOURNAL_VERSION: u32 = 1;
/// Longest name the encrypted format takes, in bytes of its NFC form.
pub(super) const MAX_NAME_BYTES: usize = 255;

#[derive(Debug, thiserror::Error)]
pub enum ConvertError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    /// Preflight found entries the encrypted format refuses: nothing changed.
    #[error("{} item(s) can't be encrypted in place", .0.len())]
    Blocked(Vec<Blocked>),
    /// The whole folder is refused, or the step can't run in this state.
    #[error("{0}")]
    Refused(String),
    /// A folder never encrypted in place (§8.10): home, Desktop, …, a volume root.
    #[error("Encrypt a vault folder, not {0}")]
    Folder(String),
    /// The folder is part-way through a conversion: opening it finishes or undoes that.
    #[error(
        "this folder is part-way through being encrypted: open it to finish or undo that first"
    )]
    Pending,
    /// The folder is inside an encrypted (or damaged) vault (final review I3).
    #[error("this folder is inside the encrypted vault {0}")]
    InsideVault(String),
    #[error("encrypting was stopped")]
    Cancelled,
    /// A file changed, or an entry appeared, after it was recorded (§8.3).
    #[error("files changed while encrypting ({0}): probably a sync service")]
    Changed(String),
    /// Recovery stops rather than overwrite (§8.4).
    #[error("{0} is in the way; nothing was overwritten")]
    Collision(String),
    #[error("{0} didn't read back as written")]
    Mismatch(String),
    /// The backup folder (§9.1) is the vault, inside it or around it.
    #[error("{0} is inside the vault being encrypted")]
    BackupInVault(String),
    /// The backup folder is inside another vault (the one named).
    #[error("{0} is a vault, or inside one")]
    BackupInOtherVault(String),
    /// The backup folder has something in it already.
    #[error("{0} isn't empty")]
    BackupNotEmpty(String),
    /// Writing or checking the backup failed (the file and why): nothing was encrypted.
    #[error("the readable copy couldn't be made: {0}")]
    BackupFailed(String),
    /// Decrypt in place (§10.2): which of the two secrets opens no slot.
    #[error("{}", wrong_secrets(*.passphrase, *.recovery))]
    WrongSecrets { passphrase: bool, recovery: bool },
}

fn wrong_secrets(passphrase: bool, recovery: bool) -> &'static str {
    match (passphrase, recovery) {
        (true, true) => "both",
        (true, false) => "passphrase",
        _ => "recovery",
    }
}

pub type Result<T> = std::result::Result<T, ConvertError>;

/// Why preflight refuses an entry (§4.2 step 2, §8 items 5, 6, 10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// A `:` or `\` in the name.
    BadChar,
    /// Differs from another name in its folder only by case or Unicode form.
    Twin,
    Symlink,
    Unreadable,
    /// Not a file, folder or link (a socket, a device).
    Special,
    /// One of the conversion's own names, with no journal.
    Reserved,
    /// A git repository: encrypting it would break it.
    Git,
    /// Only in the cloud (a placeholder): nothing is read from it.
    Cloud,
    /// Over 255 bytes once NFC-encoded.
    LongName,
    NotUtf8,
    /// A vault of its own (encrypted or damaged): move it out first (final review I3).
    Vault,
    /// Decrypt in place (§10.2): a readable entry beside the vault already has this name.
    Taken,
    /// Decrypt in place: an unfinished write (a hidden temp file under `d/`,
    /// a salvage stream): open the vault and let it finish first.
    Unfinished,
    /// Decrypt in place: a recording that hasn't been saved as a clip yet.
    Recording,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocked {
    /// Vault-relative, `/`-separated (lossy for a non-UTF-8 name).
    pub path: String,
    pub reason: Reason,
}

#[derive(Debug, Clone, Default)]
pub struct Preflight {
    pub files: u64,
    pub bytes: u64,
    pub blocked: Vec<Blocked>,
    /// Decrypt in place (§10.2): sync archives at the root (`.stversions`,
    /// `.sync`) that may hold old encrypted files and keys; never touched.
    pub archives: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Copying,
    /// Every original is in `.liber-plain/`: from here recovery rolls forward.
    Staged,
    Committing,
    /// The root header is this conversion's.
    Committed,
    /// Done, but the originals couldn't go to the trash: still in `.liber-plain/`.
    TrashPending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    pub phase: Phase,
    /// Unix seconds.
    pub started: u64,
    /// The device that converts: only it recovers (§8.2).
    pub install_id: String,
    /// The new vault's id (hex), once its header exists.
    #[serde(default)]
    pub vault_id: Option<String>,
    /// This run created `.liber-converting/` (review C1: only then is it removed).
    #[serde(default)]
    pub staging_created: bool,
    /// This run created `.liber-plain/` (only then are its entries moved back).
    #[serde(default)]
    pub plain_created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoverOutcome {
    /// No journal.
    Nothing,
    /// Another install's conversion, before its commit: nothing touched.
    OtherDevice,
    /// Another install's conversion, committed (the root header is its):
    /// the vault opens; that device finishes. Nothing touched.
    FinishingElsewhere,
    /// Interrupted before `staged`: the vault is back as it was.
    RolledBack,
    /// Finished now (the originals may still be pending: see the journal).
    Finished,
    /// Finished earlier, but the originals are still in the folder.
    TrashPending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finished {
    Done,
    /// The trash failed (why): the originals stay in `.liber-plain/`.
    TrashPending(String),
}

/// Where a test can make a run stop as if the app died (`test-params` only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashPoint {
    AfterJournal,
    /// `.liber-converting/` made, the journal not yet saying so.
    AfterStagingDir,
    /// The staging vault made, its id not yet in the journal.
    AfterStagingCreated,
    /// After this many originals moved.
    Staging(usize),
    /// Every original moved and re-checked, `staged` not yet written.
    AllMoved,
    AfterStaged,
    /// `committing` written, nothing moved up yet.
    AfterCommitting,
    AfterData,
    AfterReadme,
    AfterHeader,
    AfterCommitted,
    AfterIndex,
    AfterVisibleRename,
    AfterTrash,
    AfterStagingRemoved,
    /// During a rollback, after this many originals moved back (0: before any).
    Unstaging(usize),
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

/// Sends a folder to the OS trash (tests inject a fake).
pub type Trash<'a> = &'a dyn Fn(&Path) -> std::io::Result<()>;

/// The real [`Trash`]: the OS trash (recoverable; the user empties it, D4).
pub fn os_trash(path: &Path) -> std::io::Result<()> {
    trash::delete(path).map_err(std::io::Error::other)
}

/// Deletes the vault's plaintext index from the app cache (the desktop's).
pub type DropIndex<'a> = &'a dyn Fn() -> std::io::Result<()>;

/// A file as recorded: size, mtime, and on unix its inode and ctime (review
/// M2: a rewrite that keeps size and mtime still changes those). Windows has
/// no stable file id in std: size and mtime only there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Stamp {
    pub(super) len: u64,
    mtime: Option<SystemTime>,
    ino: u64,
    ctime_ns: i128,
}

impl Stamp {
    /// What a rename keeps (it may change the ctime).
    pub(super) fn moved(self) -> (u64, Option<SystemTime>, u64) {
        (self.len, self.mtime, self.ino)
    }
}

/// A conversion between [`begin`] and [`stage_and_commit`]: the staging vault, unlocked.
pub struct Converting {
    root: PathBuf,
    storage: EncryptedStorage,
    journal: Journal,
    /// What [`copy`] copied, as it was (no `blocked`).
    record: Tree,
    /// What [`backup`] copied, as it was: [`copy`] refuses anything else.
    backup: Option<Tree>,
}

impl Converting {
    /// Canonical.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn vault_id(&self) -> [u8; 16] {
        self.storage.vault_id()
    }
}

pub(super) fn hex(id: &[u8]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn exists(p: &Path) -> bool {
    p.symlink_metadata().is_ok()
}

/// Whether `dir` lists exactly `name`: on a case-insensitive disk `exists`
/// also finds `.Liber-Plain` for `.liber-plain` (review C1).
pub(super) fn listed(dir: &Path, name: &str) -> bool {
    std::fs::read_dir(dir).is_ok_and(|items| items.flatten().any(|i| i.file_name() == name))
}

/// A user's name that a reserved one (this conversion's or decrypt's) matches
/// by case or Unicode form only.
pub(super) fn reserved_like(name: &str) -> bool {
    RESERVED
        .iter()
        .chain(super::decrypt::RESERVED.iter())
        .any(|r| fold(r) == fold(name))
}

pub(super) fn io(what: impl std::fmt::Display) -> impl Fn(std::io::Error) -> ConvertError {
    move |e| io_err(what.to_string(), e).into()
}

pub(super) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The journal, `None` if there is none; an unreadable one is `Damaged`, never guessed at.
pub fn read_journal(root: &Path) -> Result<Option<Journal>> {
    let bytes = match std::fs::read(root.join(JOURNAL)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(JOURNAL)(e)),
    };
    // A user's `.Liber-Convert.json` on a case-insensitive disk isn't ours.
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

/// Atomic: temp file, fsync, rename, fsync the folder.
fn write_journal(root: &Path, j: &Journal) -> Result<()> {
    write_json(root, JOURNAL, JOURNAL_TMP, j)
}

/// Writes `value` as `root/name` through `root/tmp` (decrypt's journal too).
pub(super) fn write_json(root: &Path, name: &str, tmp: &str, value: &impl Serialize) -> Result<()> {
    let tmp = root.join(tmp);
    let bytes = serde_json::to_vec_pretty(value).expect("a journal serializes");
    let r = (|| {
        let mut f = File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, root.join(name))
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(io(name))?;
    sync_dir(root);
    Ok(())
}

/// What a walk found: files with their stamps, folders, and what blocks.
#[derive(Default)]
pub(super) struct Tree {
    pub(super) files: BTreeMap<String, Stamp>,
    /// Sorted, so a parent comes before its children.
    pub(super) dirs: BTreeSet<String>,
    pub(super) blocked: Vec<Blocked>,
}

pub(super) fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

pub(super) fn stamp(m: &Metadata) -> Stamp {
    #[cfg(unix)]
    let (ino, ctime_ns) = {
        use std::os::unix::fs::MetadataExt;
        (
            m.ino(),
            i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec()),
        )
    };
    #[cfg(not(unix))]
    let (ino, ctime_ns) = (0, 0);
    Stamp {
        len: m.len(),
        mtime: m.modified().ok(),
        ino,
        ctime_ns,
    }
}

/// Walks the vault at `base`. At its top, kept names are left out, and so are
/// reserved names when `in_conversion` (else they block).
fn scan(base: &Path, in_conversion: bool) -> Tree {
    let mut tree = Tree::default();
    walk(base, "", in_conversion, &mut tree);
    tree
}

fn walk(base: &Path, rel: &str, in_conversion: bool, out: &mut Tree) {
    let top = rel.is_empty();
    let mut block = |path: String, reason| out.blocked.push(Blocked { path, reason });
    let dir = if top {
        base.to_path_buf()
    } else {
        base.join(rel)
    };
    let Ok(items) = std::fs::read_dir(&dir) else {
        return block(rel.to_string(), Reason::Unreadable);
    };
    let mut folded = HashSet::new();
    let mut subdirs = Vec::new();
    for item in items {
        let Ok(item) = item else {
            block(rel.to_string(), Reason::Unreadable);
            continue;
        };
        let os = item.file_name();
        let Some(name) = os.to_str() else {
            block(join(rel, &os.to_string_lossy()), Reason::NotUtf8);
            continue;
        };
        if top && KEPT.contains(&name) {
            continue;
        }
        if top && reserved_like(name) {
            // During a conversion its own names are skipped; a lookalike blocks.
            if !(in_conversion && RESERVED.contains(&name)) {
                block(name.to_string(), Reason::Reserved);
            }
            continue;
        }
        if JUNK.contains(&name) {
            continue;
        }
        let path = join(rel, name);
        let reason = if name == ".git" {
            Some(Reason::Git)
        } else if name.contains([':', '\\']) {
            Some(Reason::BadChar)
        } else if name.nfc().collect::<String>().len() > MAX_NAME_BYTES {
            Some(Reason::LongName)
        } else if !folded.insert(fold(name)) {
            Some(Reason::Twin)
        } else {
            None
        };
        if let Some(reason) = reason {
            block(path, reason);
            continue;
        }
        let Ok(meta) = item.path().symlink_metadata() else {
            block(path, Reason::Unreadable);
            continue;
        };
        let kind = meta.file_type();
        if kind.is_symlink() {
            block(path, Reason::Symlink);
        } else if in_cloud(name, &meta) {
            block(path, Reason::Cloud);
        } else if kind.is_dir() && !matches!(vault_kind(&item.path()), VaultKind::Plain) {
            block(path, Reason::Vault);
        } else if kind.is_dir() {
            subdirs.push(path);
        } else if !kind.is_file() {
            block(path, Reason::Special);
        } else if File::open(item.path()).is_err() {
            block(path, Reason::Unreadable);
        } else {
            out.files.insert(path, stamp(&meta));
        }
    }
    for sub in subdirs {
        out.dirs.insert(sub.clone());
        walk(base, &sub, in_conversion, out);
    }
}

/// A cloud placeholder (§8.6): an iCloud stub, a macOS dataless file, or a
/// Windows file that is offline or recalled on access. Never opened.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(unused_variables))]
fn in_cloud(name: &str, meta: &Metadata) -> bool {
    if name.ends_with(".icloud") {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const SF_DATALESS: u32 = 0x4000_0000;
        if meta.st_flags() & SF_DATALESS != 0 {
            return true;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const OFFLINE: u32 = 0x1000;
        const RECALL_ON_OPEN: u32 = 0x4_0000;
        const RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;
        if meta.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0 {
            return true;
        }
    }
    false
}

/// A volume root, or a folder the caller refuses (home, Desktop, …): §8.10.
pub(super) fn refuse_folder(root: &Path, refused: &[PathBuf]) -> Result<()> {
    let listed = refused
        .iter()
        .any(|r| dunce::canonicalize(r).is_ok_and(|r| r == root));
    if listed || volume_root(root) {
        return Err(ConvertError::Folder(root.display().to_string()));
    }
    Ok(())
}

fn volume_root(root: &Path) -> bool {
    let Some(parent) = root.parent() else {
        return true;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (root.metadata(), parent.metadata()) {
            return a.dev() != b.dev();
        }
    }
    let _ = parent;
    false
}

/// What would block encrypting `root` in place. Changes nothing. The whole
/// folder is refused (`Err`) when it is a refused folder, already encrypted or
/// damaged, or part-way through a conversion.
pub fn preflight(root: &Path, refused: &[PathBuf]) -> Result<Preflight> {
    let root = canonical_root(root)?;
    refuse_folder(&root, refused)?;
    // Inside an encrypted vault (its `d/` or below): that vault's ciphertext.
    if let Some(vault) = root
        .ancestors()
        .skip(1)
        .find(|a| !matches!(vault_kind(a), VaultKind::Plain))
    {
        return Err(ConvertError::InsideVault(vault.display().to_string()));
    }
    // A decrypt part-way through (§10.3) is that run's to finish or undo.
    if read_journal(&root)?.is_some() || super::decrypt::read_journal(&root)?.is_some() {
        return Err(ConvertError::Pending);
    }
    match vault_kind(&root) {
        VaultKind::Plain => {}
        VaultKind::Encrypted => {
            return Err(ConvertError::Refused(
                "This folder is already an encrypted vault".into(),
            ));
        }
        VaultKind::Damaged(why) => {
            return Err(VaultError::Damaged(format!("{}: {why}", root.display())).into());
        }
    }
    let tree = scan(&root, false);
    Ok(Preflight {
        files: tree.files.len() as u64,
        bytes: tree.files.values().map(|s| s.len).sum(),
        blocked: tree.blocked,
        archives: Vec::new(),
    })
}

/// Preflight, then the journal (`copying`), then the staging vault that
/// `make` creates in the empty folder it is given (with real calibration,
/// or tiny test parameters). Its recovery code is for the UI to show and
/// confirm before [`copy`] (§8.1). On error, the caller calls [`recover`].
pub fn begin(
    root: &Path,
    refused: &[PathBuf],
    install_id: &str,
    make: impl FnOnce(&Path) -> crate::Result<(EncryptedStorage, RecoveryCode)>,
) -> Result<(Converting, RecoveryCode)> {
    let pre = preflight(root, refused)?;
    if !pre.blocked.is_empty() {
        return Err(ConvertError::Blocked(pre.blocked));
    }
    let root = canonical_root(root)?;
    let mut journal = Journal {
        version: JOURNAL_VERSION,
        phase: Phase::Copying,
        started: now_secs(),
        install_id: install_id.to_string(),
        vault_id: None,
        staging_created: false,
        plain_created: false,
    };
    write_journal(&root, &journal)?;
    crash(CrashPoint::AfterJournal)?;
    let staging = root.join(STAGING);
    // Fails on anything already there, a lookalike name included.
    std::fs::create_dir(&staging).map_err(io(STAGING))?;
    crash(CrashPoint::AfterStagingDir)?;
    journal.staging_created = true;
    write_journal(&root, &journal)?;
    let (storage, code) = make(&staging)?;
    crash(CrashPoint::AfterStagingCreated)?;
    journal.vault_id = Some(hex(&storage.vault_id()));
    write_journal(&root, &journal)?;
    Ok((
        Converting {
            root,
            storage,
            journal,
            record: Tree::default(),
            backup: None,
        },
        code,
    ))
}

/// Copies every file and folder into the staging vault: each file streamed
/// in, read back and compared by SHA-256, its mtime set on the ciphertext.
/// `progress(done, total)` after each file; `cancel` is checked between
/// files (`Cancelled`). On error, the caller calls [`recover`].
pub fn copy(
    c: &mut Converting,
    mut progress: impl FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<()> {
    let tree = scan(&c.root, true);
    if !tree.blocked.is_empty() {
        return Err(ConvertError::Blocked(tree.blocked));
    }
    // The backup is of exactly what is encrypted (§9.1): a sync since it
    // (during the recovery-key step) stops the conversion.
    if let Some(backup) = &c.backup {
        check_same(&tree, backup, false)?;
    }
    for dir in &tree.dirs {
        c.storage.make_dir(&VaultPath::new(dir)?)?;
    }
    let total = tree.files.len() as u64;
    progress(0, total);
    for (done, (rel, recorded)) in tree.files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(ConvertError::Cancelled);
        }
        copy_file(&c.storage, &c.root, rel, recorded)?;
        progress(done as u64 + 1, total);
    }
    c.record = tree;
    Ok(())
}

pub(super) fn sha256(
    mut r: impl Read,
    mut also: impl FnMut(&[u8]) -> std::io::Result<()>,
) -> std::io::Result<[u8; 32]> {
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            return Ok(hash.finalize().into());
        }
        hash.update(&buf[..n]);
        also(&buf[..n])?;
    }
}

fn copy_file(s: &EncryptedStorage, root: &Path, rel: &str, recorded: &Stamp) -> Result<()> {
    let vp = VaultPath::new(rel)?;
    let src = root.join(rel);
    let changed = || ConvertError::Changed(rel.to_string());
    let from = File::open(&src).map_err(io(rel))?;
    if stamp(&from.metadata().map_err(io(rel))?) != *recorded {
        return Err(changed());
    }
    let mut out = s.new_file(&vp, u64::MAX)?;
    let wrote = sha256(from, |b| out.write_all(b)).map_err(io(rel))?;
    let physical = out.commit_to()?;
    // Changed while it was read: the copy may be torn.
    if src.symlink_metadata().map(|m| stamp(&m)).ok().as_ref() != Some(recorded) {
        return Err(changed());
    }
    let read = s.with_keys(|u| {
        let f = File::open(&physical).map_err(|e| io_err(rel, e))?;
        let r = StreamReader::open(f, |e| u.content_key(e)).map_err(|e| content_err(&vp, e))?;
        sha256(r, |_| Ok(())).map_err(|e| io_err(rel, e))
    })?;
    if read != wrote {
        return Err(ConvertError::Mismatch(rel.to_string()));
    }
    if let Some(t) = recorded.mtime {
        File::options()
            .write(true)
            .open(&physical)
            .and_then(|f| f.set_modified(t))
            .map_err(io(rel))?;
    }
    Ok(())
}

/// `Changed` unless `now` is exactly what was recorded (`moved`: what a
/// rename keeps of each file).
pub(super) fn check_same(now: &Tree, rec: &Tree, moved: bool) -> Result<()> {
    if let Some(b) = now.blocked.first() {
        return Err(ConvertError::Changed(b.path.clone()));
    }
    if let Some(d) = now.dirs.symmetric_difference(&rec.dirs).next() {
        return Err(ConvertError::Changed(d.clone()));
    }
    let same = |a: &Stamp, b: &Stamp| {
        if moved {
            a.moved() == b.moved()
        } else {
            a == b
        }
    };
    let differs = |a: &BTreeMap<String, Stamp>, b: &BTreeMap<String, Stamp>| {
        a.iter()
            .find(|(k, v)| !b.get(*k).is_some_and(|w| same(v, w)))
            .map(|(k, _)| k.clone())
    };
    match differs(&now.files, &rec.files).or_else(|| differs(&rec.files, &now.files)) {
        Some(rel) => Err(ConvertError::Changed(rel)),
        None => Ok(()),
    }
}

/// The root's entries the conversion moves: all but kept and reserved names.
fn movable(root: &Path) -> Result<Vec<OsString>> {
    let mut names = Vec::new();
    for item in std::fs::read_dir(root).map_err(io(root.display()))? {
        let name = item.map_err(io(root.display()))?.file_name();
        let keep = name
            .to_str()
            .is_some_and(|n| KEPT.contains(&n) || RESERVED.contains(&n));
        if !keep {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// Renames `from` onto `to`, which must not exist (never overwrites).
pub(super) fn move_new(from: &Path, to: &Path) -> Result<()> {
    if exists(to) {
        return Err(ConvertError::Collision(to.display().to_string()));
    }
    std::fs::rename(from, to).map_err(io(from.display()))
}

/// Re-checks every original against the record (§8.3), moves them into
/// `.liber-plain/` and checks them there, writes `staged`, then commits.
/// On error, the caller calls [`recover`]: before `staged` it rolls back.
pub fn stage_and_commit(c: Converting) -> Result<()> {
    let Converting {
        root,
        storage,
        mut journal,
        record,
        backup: _,
    } = c;
    drop(storage);
    check_same(&scan(&root, true), &record, false)?;
    let plain = root.join(ORIGINALS);
    // Fails on anything already there, a lookalike name included.
    std::fs::create_dir(&plain).map_err(io(ORIGINALS))?;
    journal.plain_created = true;
    write_journal(&root, &journal)?;
    for (n, name) in movable(&root)?.iter().enumerate() {
        move_new(&root.join(name), &plain.join(name))?;
        crash(CrashPoint::Staging(n + 1))?;
    }
    sync_dir(&plain);
    sync_dir(&root);
    // A sync that wrote between the check and a move (still before `staged`),
    // or a newcomer at the root (review M1; OS junk there is left alone).
    check_same(&scan(&plain, true), &record, true)?;
    if let Some(new) = movable(&root)?
        .into_iter()
        .find(|n| !n.to_str().is_some_and(|n| JUNK.contains(&n)))
    {
        return Err(ConvertError::Changed(new.to_string_lossy().into_owned()));
    }
    crash(CrashPoint::AllMoved)?;
    journal.phase = Phase::Staged;
    write_journal(&root, &journal)?;
    crash(CrashPoint::AfterStaged)?;
    commit(&root, &mut journal)
}

/// Moves the staging vault up, its header last (the commit point), skipping
/// what a crash already moved; then `committed`.
fn commit(root: &Path, journal: &mut Journal) -> Result<()> {
    if journal.phase != Phase::Committing {
        journal.phase = Phase::Committing;
        write_journal(root, journal)?;
    }
    crash(CrashPoint::AfterCommitting)?;
    let staging = root.join(STAGING);
    for (name, point) in [
        (DATA_DIR, CrashPoint::AfterData),
        (README_FILE, CrashPoint::AfterReadme),
        (HEADER_FILE, CrashPoint::AfterHeader),
    ] {
        let (from, to) = (staging.join(name), root.join(name));
        match (exists(&from), exists(&to)) {
            (true, _) => move_new(&from, &to)?,
            (false, true) => {} // moved before a crash
            (false, false) if name == README_FILE => {}
            (false, false) => {
                return Err(
                    VaultError::Damaged(format!("{name} is missing from {STAGING}")).into(),
                );
            }
        }
        sync_dir(root);
        crash(point)?;
    }
    verify_header(root, journal)?;
    journal.phase = Phase::Committed;
    write_journal(root, journal)?;
    crash(CrashPoint::AfterCommitted)
}

/// "Committed" means the root header parses, is an encrypted vault, and has
/// the journal's vault id (§8.4).
fn verify_header(root: &Path, journal: &Journal) -> Result<()> {
    let bytes = read_header(&root.join(HEADER_FILE)).map_err(io(HEADER_FILE))?;
    let ours = VaultHeader::parse(&bytes)
        .is_ok_and(|h| Some(hex(&h.vault_id().0)) == journal.vault_id)
        && vault_kind(root) == VaultKind::Encrypted;
    if !ours {
        return Err(VaultError::Damaged(format!(
            "{HEADER_FILE} at {} isn't this conversion's",
            root.display()
        ))
        .into());
    }
    Ok(())
}

/// `<vault name> (unencrypted originals)`, the name shortened to fit one
/// path component (review I5).
fn visible_originals(root: &Path) -> PathBuf {
    const SUFFIX: &str = " (unencrypted originals)";
    let mut name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Vault".into());
    while name.len() + SUFFIX.len() > MAX_NAME_BYTES {
        name.pop();
    }
    root.join(format!("{name}{SUFFIX}"))
}

/// Removes `.liber-converting/` only when it is provably this conversion's
/// (review C1): listed under that exact name, and empty, or created by this
/// run with no header of another vault in it. Anything else stays.
fn remove_staging(root: &Path, journal: &Journal) -> Result<()> {
    let staging = root.join(STAGING);
    if !listed(root, STAGING) || std::fs::remove_dir(&staging).is_ok() {
        return Ok(());
    }
    let header = staging.join(HEADER_FILE);
    let ours = !exists(&header)
        || journal.vault_id.is_none()
        || read_header(&header)
            .ok()
            .and_then(|b| VaultHeader::parse(&b).ok())
            .is_some_and(|h| Some(hex(&h.vault_id().0)) == journal.vault_id);
    if journal.staging_created && ours {
        std::fs::remove_dir_all(&staging).map_err(io(STAGING))?;
    }
    Ok(())
}

/// `.liber-plain/` is this conversion's: listed under that exact name, and
/// created by this run (or empty, from a crash before the journal said so).
fn plain_is_ours(root: &Path, journal: &Journal) -> bool {
    let plain = root.join(ORIGINALS);
    listed(root, ORIGINALS)
        && (journal.plain_created
            || std::fs::read_dir(&plain).is_ok_and(|mut d| d.next().is_none()))
}

/// The finish steps (§8.9): drop the plaintext index, trash the originals
/// under a visible name (§8.8) or mark `trashPending`, remove the staging
/// folder, then the journal last. Also retries a pending trash.
pub fn finish(root: &Path, trash: Trash<'_>, drop_index: DropIndex<'_>) -> Result<Finished> {
    let root = canonical_root(root)?;
    let mut journal = read_journal(&root)?
        .ok_or_else(|| ConvertError::Refused("there is no conversion to finish".into()))?;
    if !matches!(journal.phase, Phase::Committed | Phase::TrashPending) {
        return Err(ConvertError::Refused(format!(
            "a conversion at {:?} can't finish yet",
            journal.phase
        )));
    }
    verify_header(&root, &journal)?;
    drop_index().map_err(io("the index cache"))?;
    crash(CrashPoint::AfterIndex)?;
    let out = match trash_originals(&root, trash)? {
        Ok(()) => Finished::Done,
        Err(why) => {
            if journal.phase != Phase::TrashPending {
                journal.phase = Phase::TrashPending;
                write_journal(&root, &journal)?;
            }
            Finished::TrashPending(why)
        }
    };
    remove_staging(&root, &journal)?;
    crash(CrashPoint::AfterStagingRemoved)?;
    if out == Finished::Done {
        std::fs::remove_file(root.join(JOURNAL)).map_err(io(JOURNAL))?;
        sync_dir(&root);
    }
    Ok(out)
}

/// `Ok(Err(why))`: the originals couldn't go, and are back out of sight.
fn trash_originals(root: &Path, trash: Trash<'_>) -> Result<std::result::Result<(), String>> {
    let (hidden, visible) = (root.join(ORIGINALS), visible_originals(root));
    if listed(root, ORIGINALS) {
        if exists(&visible) {
            return Ok(Err(format!("{} is in the way", visible.display())));
        }
        if let Err(e) = std::fs::rename(&hidden, &visible) {
            return Ok(Err(e.to_string()));
        }
        crash(CrashPoint::AfterVisibleRename)?;
    }
    if !exists(&visible) {
        return Ok(Ok(())); // trashed before a crash
    }
    match trash(&visible) {
        Ok(()) => {
            crash(CrashPoint::AfterTrash)?;
            Ok(Ok(()))
        }
        Err(e) => {
            if !exists(&hidden) {
                let _ = std::fs::rename(&visible, &hidden);
            }
            Ok(Err(e.to_string()))
        }
    }
}

/// While the originals are pending: gives them their visible name for the
/// file manager, and says where they are.
pub fn show_originals(root: &Path) -> Result<PathBuf> {
    let root = canonical_root(root)?;
    let journal = read_journal(&root)?;
    if journal.as_ref().map(|j| j.phase) != Some(Phase::TrashPending) {
        return Err(ConvertError::Refused(
            "no originals are waiting here".into(),
        ));
    }
    let (hidden, visible) = (root.join(ORIGINALS), visible_originals(&root));
    if journal.is_some_and(|j| plain_is_ours(&root, &j)) && !exists(&visible) {
        std::fs::rename(&hidden, &visible).map_err(io(ORIGINALS))?;
    }
    if !exists(&visible) {
        return Err(VaultError::NotFound(visible.display().to_string()).into());
    }
    Ok(visible)
}

/// Undoes a conversion before `staged`: every original back from
/// `.liber-plain/` (a collision stops it, never overwrites), the staging
/// folder removed, the journal last. Refused from `staged` on.
pub fn rollback(root: &Path) -> Result<()> {
    let root = canonical_root(root)?;
    let Some(journal) = read_journal(&root)? else {
        return Ok(());
    };
    if journal.phase != Phase::Copying {
        return Err(ConvertError::Refused(
            "this conversion can't be undone any more: opening the vault finishes it".into(),
        ));
    }
    unstage(&root, &journal)
}

/// A `staged`/`committing` run that can't commit: its staging vault is gone
/// and nothing of it reached the root (an undo on another device raced it;
/// final re-check 3), while every original sits in our `.liber-plain`.
fn stranded(root: &Path, journal: &Journal) -> bool {
    !exists(&root.join(STAGING).join(HEADER_FILE))
        && !exists(&root.join(DATA_DIR))
        && verify_header(root, journal).is_err()
        && journal.plain_created
        && plain_is_ours(root, journal)
}

/// Rollback's moves: the originals back (all checked first, never
/// overwriting), then the staging folder this run made, then the journal.
fn unstage(root: &Path, journal: &Journal) -> Result<()> {
    let root = root.to_path_buf();
    let plain = root.join(ORIGINALS);
    if plain_is_ours(&root, journal) {
        let names: Vec<OsString> = std::fs::read_dir(&plain)
            .map_err(io(ORIGINALS))?
            .map(|e| e.map(|e| e.file_name()))
            .collect::<std::io::Result<_>>()
            .map_err(io(ORIGINALS))?;
        // OS junk the OS wrote again at the root meanwhile (Finder's
        // `.DS_Store`): both copies are junk, the staged one goes back.
        let rewritten = |n: &OsString| {
            n.to_str().is_some_and(|n| JUNK.contains(&n))
                && std::fs::symlink_metadata(root.join(n)).is_ok_and(|m| m.is_file())
        };
        // All checked first: a collision moves nothing back.
        if let Some(n) = names
            .iter()
            .find(|n| exists(&root.join(n)) && !rewritten(n))
        {
            return Err(ConvertError::Collision(root.join(n).display().to_string()));
        }
        crash(CrashPoint::Unstaging(0))?;
        for (i, n) in names.iter().enumerate() {
            if rewritten(n) {
                std::fs::remove_file(root.join(n)).map_err(io(ORIGINALS))?;
            }
            move_new(&plain.join(n), &root.join(n))?;
            crash(CrashPoint::Unstaging(i + 1))?;
        }
        std::fs::remove_dir(&plain).map_err(io(ORIGINALS))?;
    }
    remove_staging(&root, journal)?;
    if listed(&root, JOURNAL_TMP) {
        let _ = std::fs::remove_file(root.join(JOURNAL_TMP));
    }
    std::fs::remove_file(root.join(JOURNAL)).map_err(io(JOURNAL))?;
    sync_dir(&root);
    Ok(())
}

/// What an open does first (§8.2, §8.4): follows this device's journal to a
/// rollback or a finish. Another device's is left alone (`OtherDevice`); a
/// pending trash is reported from any device.
pub fn recover(
    root: &Path,
    install_id: &str,
    trash: Trash<'_>,
    drop_index: DropIndex<'_>,
) -> Result<RecoverOutcome> {
    let root = canonical_root(root)?;
    let Some(mut journal) = read_journal(&root)? else {
        return Ok(RecoverOutcome::Nothing);
    };
    if journal.phase == Phase::TrashPending {
        return Ok(RecoverOutcome::TrashPending);
    }
    if journal.install_id != install_id {
        // Committed there: the vault is safe to open; that device finishes.
        let committed = journal.phase == Phase::Committed && verify_header(&root, &journal).is_ok();
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
        Phase::Staged | Phase::Committing if stranded(&root, &journal) => {
            unstage(&root, &journal)?;
            return Ok(RecoverOutcome::RolledBack);
        }
        Phase::Staged | Phase::Committing => commit(&root, &mut journal)?,
        Phase::Committed | Phase::TrashPending => {}
    }
    finish(&root, trash, drop_index)?;
    Ok(RecoverOutcome::Finished)
}

// ---- the readable backup (encryption UX §9) ----

/// `dest`, canonical: itself if it exists, else its (existing) parent's
/// canonical path joined with its name.
fn backup_target(dest: &Path) -> Result<PathBuf> {
    match dunce::canonicalize(dest) {
        Ok(p) => Ok(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let (Some(parent), Some(name)) = (dest.parent(), dest.file_name()) else {
                return Err(VaultError::NotFound(dest.display().to_string()).into());
            };
            let parent = dunce::canonicalize(parent).map_err(io(parent.display()))?;
            Ok(parent.join(name))
        }
        Err(e) => Err(io(dest.display())(e)),
    }
}

/// Whether `dir` is a vault: an encrypted or damaged one, or a plain one the
/// app has opened (it holds the settings folder).
fn is_a_vault(dir: &Path) -> bool {
    !matches!(vault_kind(dir), VaultKind::Plain)
        || dir
            .join(crate::META_DIR)
            .symlink_metadata()
            .is_ok_and(|m| m.is_dir())
}

/// Checks the folder picked for the readable backup of `root` (§9.1): outside
/// the vault, not in another vault, and empty (OS junk aside) or new with an
/// existing parent. Changes nothing; the folder, canonical.
pub fn check_backup(root: &Path, dest: &Path) -> Result<PathBuf> {
    let root = canonical_root(root)?;
    let dest = backup_target(dest)?;
    let shown = || dest.display().to_string();
    if dest.starts_with(&root) || root.starts_with(&dest) {
        return Err(ConvertError::BackupInVault(shown()));
    }
    if let Some(vault) = dest
        .ancestors()
        .filter(|a| exists(a))
        .find(|a| is_a_vault(a))
    {
        return Err(ConvertError::BackupInOtherVault(
            vault.display().to_string(),
        ));
    }
    match dest.symlink_metadata() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(dest),
        Err(e) => Err(io(shown())(e)),
        Ok(m) if !m.is_dir() => Err(ConvertError::BackupNotEmpty(shown())),
        Ok(_) => {
            let items = std::fs::read_dir(&dest).map_err(io(shown()))?;
            let junk =
                |i: &std::fs::DirEntry| i.file_name().to_str().is_some_and(|n| JUNK.contains(&n));
            for item in items {
                if !junk(&item.map_err(io(shown()))?) {
                    return Err(ConvertError::BackupNotEmpty(shown()));
                }
            }
            Ok(dest)
        }
    }
}

/// Writes a readable copy of every file and folder [`copy`] will encrypt into
/// `dest` (checked again by [`check_backup`]), each file read back and its
/// SHA-256 compared, its mtime kept (§9.1). Call between [`begin`] and
/// [`copy`]: `copy` then refuses a tree that changed since. On any error the
/// entries this backup wrote are removed again (the folder was empty) and
/// nothing of the vault was changed; the caller undoes the conversion.
pub fn backup(
    c: &mut Converting,
    dest: &Path,
    mut progress: impl FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<()> {
    let dest = check_backup(&c.root, dest)?;
    let tree = scan(&c.root, true);
    if !tree.blocked.is_empty() {
        return Err(ConvertError::Blocked(tree.blocked));
    }
    let failed = |what: &str| {
        let what = what.to_string();
        move |e: std::io::Error| ConvertError::BackupFailed(format!("{what}: {e}"))
    };
    let made = !exists(&dest);
    if made {
        std::fs::create_dir(&dest).map_err(failed(&dest.display().to_string()))?;
    }
    // Exactly what this backup created, in order, each only once its
    // creation succeeded: on failure only those go (review: never anything a
    // sync put in the folder meanwhile).
    let mut created: Vec<Created> = Vec::new();
    let run = (|| {
        for dir in &tree.dirs {
            std::fs::create_dir(dest.join(dir)).map_err(failed(dir))?;
            created.push(Created::Dir(dest.join(dir)));
        }
        let total = tree.files.len() as u64;
        progress(0, total);
        for (done, (rel, recorded)) in tree.files.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(ConvertError::Cancelled);
            }
            backup_file(&c.root, &dest, rel, recorded, &mut created)?;
            progress(done as u64 + 1, total);
        }
        sync_dir(&dest);
        Ok(())
    })();
    if let Err(e) = run {
        // Newest first: a folder is empty of ours by the time it is reached,
        // and one still holding something else stays.
        for item in created.iter().rev() {
            let _ = match item {
                Created::File(p) => std::fs::remove_file(p),
                Created::Dir(p) => std::fs::remove_dir(p),
            };
        }
        if made {
            let _ = std::fs::remove_dir(&dest);
        }
        return Err(e);
    }
    c.backup = Some(tree);
    Ok(())
}

/// An entry the backup made (removed again if the backup fails).
enum Created {
    File(PathBuf),
    Dir(PathBuf),
}

fn backup_file(
    root: &Path,
    dest: &Path,
    rel: &str,
    recorded: &Stamp,
    created: &mut Vec<Created>,
) -> Result<()> {
    let (src, to) = (root.join(rel), dest.join(rel));
    let failed = |e: std::io::Error| ConvertError::BackupFailed(format!("{rel}: {e}"));
    let changed = || ConvertError::Changed(rel.to_string());
    let from = File::open(&src).map_err(io(rel))?;
    if stamp(&from.metadata().map_err(io(rel))?) != *recorded {
        return Err(changed());
    }
    let mut out = File::options()
        .write(true)
        .create_new(true)
        .open(&to)
        .map_err(failed)?;
    created.push(Created::File(to.clone()));
    let mut write_err = None;
    let wrote = sha256(from, |b| {
        out.write_all(b).inspect_err(|e| {
            write_err = Some(std::io::Error::new(e.kind(), e.to_string()));
        })
    });
    let wrote = match (wrote, write_err) {
        (_, Some(e)) => return Err(failed(e)),
        (Err(e), None) => return Err(io(rel)(e)),
        (Ok(h), None) => h,
    };
    if let Some(t) = recorded.mtime {
        out.set_modified(t).map_err(failed)?;
    }
    out.sync_all().map_err(failed)?;
    drop(out);
    // Changed while it was read: the copy may be torn.
    if src.symlink_metadata().map(|m| stamp(&m)).ok().as_ref() != Some(recorded) {
        return Err(changed());
    }
    let read = sha256(File::open(&to).map_err(failed)?, |_| Ok(())).map_err(failed)?;
    if read != wrote {
        return Err(ConvertError::BackupFailed(format!(
            "{rel} didn't read back as written"
        )));
    }
    Ok(())
}
