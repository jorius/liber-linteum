//! Plain-text and code files (M4b part 2 §6): which files open in the app's
//! text view, and their compare-and-swap reads and writes. They stay
//! attachments in the index; nothing here parses them as pages.

use crate::error::{Result, SessionError};
use crate::session::{VaultSession, clamp_ns, is_page_path, text_of, validate_name};
use liber_index::{FileKind, FileRow};
use liber_markdown::link_key;
use liber_vault::{Hash, VaultPath};

/// Larger files keep "Open in default app".
pub const TEXT_MAX_BYTES: usize = 2 * 1024 * 1024;

const EXTENSIONS: &[&str] = &[
    "txt", "text", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg",
    "conf", "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "py", "rb", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cs", "swift", "sh", "bash",
    "zsh", "fish", "ps1", "sql", "lua", "php", "r", "dart", "vue", "svelte",
];
const NAMES: &[&str] = &["Dockerfile", "Makefile", ".gitignore", ".editorconfig"];

/// Whether `path` names a file the text view opens (by extension or whole
/// name; the content is checked when it is read).
pub fn is_text_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if NAMES.contains(&name) {
        return true;
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext))
        }
        _ => false,
    }
}

/// UTF-8, no NUL bytes, at most [`TEXT_MAX_BYTES`].
pub fn is_text_content(bytes: &[u8]) -> bool {
    bytes.len() <= TEXT_MAX_BYTES && !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

fn not_a_text(path: &VaultPath) -> SessionError {
    SessionError::NotAText(path.to_string())
}

impl VaultSession {
    /// An eligible name that the index holds (so never a hidden file).
    fn check_text_file(&self, path: &VaultPath) -> Result<()> {
        if !is_text_path(path.as_str()) || is_page_path(path.as_str()) {
            return Err(not_a_text(path));
        }
        match self.index()?.stat(path.as_str())? {
            Some(stat) if stat.kind != FileKind::Folder => Ok(()),
            _ => Err(SessionError::NotIndexed(path.to_string())),
        }
    }

    /// The file's text and hash; `NotAText` when its content isn't eligible.
    pub fn read_text(&self, path: &VaultPath) -> Result<(String, Hash)> {
        self.check_text_file(path)?;
        let (bytes, hash) = self.vault.read(path)?;
        if !is_text_content(&bytes) {
            return Err(not_a_text(path));
        }
        let text = String::from_utf8(bytes).map_err(|_| not_a_text(path))?;
        Ok((text, hash))
    }

    /// Creates an empty text file `name` in `dir` — "Save as new file" for a
    /// text file deleted outside the app with unsaved edits (final review
    /// I6). `NotAText` for a name the text view doesn't open (pages
    /// included), `AlreadyExists` when the name is taken.
    pub fn create_text_file(&self, dir: &VaultPath, name: &str) -> Result<VaultPath> {
        let name = validate_name(name)?;
        let path = dir.join(name)?;
        if !is_text_path(name) || is_page_path(name) {
            return Err(not_a_text(&path));
        }
        self.create_attachment(&path, b"")?;
        Ok(path)
    }

    /// Writes a new file (never over one) and indexes it as an attachment;
    /// links to its name resolve at once.
    pub(crate) fn create_attachment(&self, path: &VaultPath, bytes: &[u8]) -> Result<Hash> {
        let hash = self.vault.write_cas(path, bytes, None)?;
        let entry = self
            .vault
            .stat(path)?
            .ok_or_else(|| SessionError::NotIndexed(path.to_string()))?;
        let row = FileRow {
            path: path.to_string(),
            kind: FileKind::Attachment,
            mtime_ns: clamp_ns(entry.mtime_ns),
            size: entry.size,
            hash: Some(hash.to_hex()),
        };
        let text = text_of(path.as_str(), bytes);
        let mut index = self.index()?;
        index.transaction(|tx| {
            tx.upsert_file(&row)?;
            text.as_deref()
                .map_or(Ok(()), |t| tx.upsert_text(&row.path, t))
        })?;
        let files = index.file_set()?;
        index.resolve_affected(&files, &[link_key(path.as_str())])?;
        Ok(hash)
    }

    /// Writes the file's full text if it still has `expected` as its hash,
    /// then re-indexes it as an attachment. A changed file returns
    /// `SessionError::Vault(VaultError::Conflict { .. })`.
    pub fn write_text(&self, path: &VaultPath, text: &str, expected: Hash) -> Result<Hash> {
        self.check_text_file(path)?;
        if !is_text_content(text.as_bytes()) {
            return Err(not_a_text(path));
        }
        let hash = self
            .vault
            .write_cas(path, text.as_bytes(), Some(expected))?;
        let entry = self
            .vault
            .stat(path)?
            .ok_or_else(|| SessionError::NotIndexed(path.to_string()))?;
        let row = FileRow {
            path: path.to_string(),
            kind: FileKind::Attachment,
            mtime_ns: clamp_ns(entry.mtime_ns),
            size: entry.size,
            hash: Some(hash.to_hex()),
        };
        self.index()?.transaction(|tx| {
            tx.upsert_file(&row)?;
            tx.upsert_text(&row.path, text)
        })?;
        Ok(hash)
    }
}
