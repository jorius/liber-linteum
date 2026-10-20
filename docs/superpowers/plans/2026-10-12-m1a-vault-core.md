# M1a Vault Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the M0 crate stubs into a tested, headless vault engine: open an Obsidian vault without changing it, index it into a SQLite cache, keep the index in sync with external changes, and create/rename/move/trash files with automatic link rewriting.

**Architecture:** Four library crates with one job each — `liber-vault` (filesystem only), `liber-markdown` (pure parsing and link resolution), `liber-index` (SQLite cache, never touches vault files) — composed by a new `liber-session` crate that owns one open vault (index + watcher + operations). None depends on Tauri; M1b will wrap `liber-session` in Tauri commands. A test-only `liber-testkit` crate holds fixture helpers and the 10k-note generator.

**Tech Stack:** Rust 1.99 (edition 2024), pulldown-cmark 0.13, yaml-rust2 0.13, unicode-normalization 0.1, rusqlite 0.40 (bundled SQLite 3.53), notify 8.2 via notify-debouncer-mini 0.7, blake3 1.8, globset 0.4, trash 5.2, rayon 1.12; tests: tempfile, proptest, criterion.

**Spec:** `docs/superpowers/specs/2026-10-12-m1a-vault-core-design.md` (binding; this plan argues from it). Parents: `docs/product-spec.md`, `docs/superpowers/specs/2026-10-12-architecture-design.md`, `docs/handoff/2026-10-12-m0-scaffold-handoff.md`.

**How this plan was verified:** every line of code below was compiled and tested before being written into the plan, and the whole plan was then *replayed* task by task on a fresh clone of the repository at `e294f87`. In that replay every RED step failed for the stated reason, every GREEN step passed (incl. `clippy -D warnings` and `cargo fmt --check`), the tree was clean after each commit, and the final workspace check and `cargo deny check` passed. Benchmarks were run once on the author's Mac (numbers in Task 12).

## Global Constraints

- License GPL-3.0-or-later; every new dependency must keep `cargo deny check` green (GPL-compatible licenses, no network crates — `deny.toml` bans reqwest, ureq, isahc, curl, hyper, h2, attohttpc, tungstenite, tokio-tungstenite and the Tauri http/updater/shell/websocket/upload plugins).
- `crates/*` never depend on `tauri`. `liber-markdown` does no I/O. `liber-index` never reads or writes vault files. Only `liber-session` composes the others.
- Opening a vault writes **nothing** inside it: no file bytes, no mtimes, no `.liber/` (VLT-02). The index lives at `<cache_root>/liber/<cache_dir_name(vault)>/index.sqlite`.
- Paths crossing crate boundaries are vault-relative, `/`-separated, **exactly as named on disk**; Unicode NFC + lowercase is applied only to matching keys.
- Exact resolved versions (verified in `Cargo.lock`): blake3 1.8.7, dunce 1.0.5, globset 0.4.20, notify 8.2.0 (through notify-debouncer-mini 0.7.0), percent-encoding 2.3.2, pulldown-cmark 0.13.4, rayon 1.12.0, rusqlite 0.40.2 (bundled SQLite 3.53.2), thiserror 2.0.21, trash 5.2.9, unicode-normalization 0.1.25, yaml-rust2 0.13.0; dev: criterion 0.8.2, proptest 1.12.0, tempfile 3.27.0.
- Toolchain and lints: Rust 1.99.0, edition 2024, `style_edition = "2024"`; core crates inherit `unsafe_code = "forbid"`; every task ends with `cargo clippy … -- -D warnings` and `cargo fmt --all --check` clean.
- Constants from the spec: debounce 200 ms; progress event every 200 files; index write batches ≤ 500 rows; rewrite retries 3; excerpt 200 characters; schema version 1.
- Out of scope (spec §8): Tauri commands, settings, UI (M1b); FTS/search (M5); Global View queries and layout (M3); writing `.liber/vault.json`; undo.
- Name tests after the requirement they pin (`vlt_02_…`, `pg_05_…`, `exp_04_…`, `nfr_08_…`); `review_focus_…` for the Review Focus pins below.
- Commits are conventional (`feat(scope): …`) and end with a `Co-Authored-By:` trailer naming **the model that actually wrote the commit** (M0 ruling); the trailer shown in each commit step is the controller's and must be adjusted by subagent implementers.

## Review Focus

1. **Symlinks that escape the vault or point at folders (incl. loops)** — a reasonable person expects them to be ignored, never followed or written through. Pinned by `review_focus_symlinks_outside_vault_and_folder_symlinks_are_skipped` (Task 2) and `review_focus_writes_through_symlink_escaping_the_vault_are_refused` (Task 3).
2. **Names that differ only by letter case or Unicode normalization** (`Ideas.md` vs `ideas.md` on Linux; `é` typed as one or two code points) — links resolve deterministically and never to a random file. Pinned by `pg_05_case_and_unicode_insensitive_matching` (Task 7) and `review_focus_names_differing_only_by_case_on_case_sensitive_fs` (Task 9).
3. **A corrupt, foreign or outdated index database** in the cache folder — the app silently rebuilds it (it is only a cache). Pinned by `review_focus_corrupt_or_foreign_or_old_db_is_rebuilt` (Task 8).
4. **A burst of external changes** (a `git checkout`, a sync client, a deleted folder, a file moved by Obsidian) — the index converges to what is on disk without a restart. Pinned by `review_focus_burst_of_changes_is_delivered_without_loss` (Task 4) and `review_focus_git_checkout_like_burst_converges` (Task 11).
5. **Very large or binary-looking `.md` files** — parsing never panics; invalid UTF-8 is indexed as an attachment with a warning. Pinned by `review_focus_large_and_binary_like_pages_do_not_panic` (Task 6) and `edge_cases_are_indexed_with_warnings_not_errors` (Task 9).

## File Structure

```
Cargo.toml                              workspace: M1a dependency versions (Task 1)
.gitattributes, .prettierignore         fixtures kept byte-exact / not formatted (Task 2)
fixtures/vaults/
  obsidian-basic/                       nested folders, .obsidian/app.json, .trash/, attachments,
                                        frontmatter (subtitle, cover, tags, related), all link forms
  ambiguous-names/                      four Ideas.md at different depths + links relying on tie-breaks
  edge-cases/                           links in code/HTML, malformed YAML, empty, CRLF, invalid UTF-8, Unicode
crates/liber-testkit/                    test-only: fixture copies, snapshots, polling, 10k generator
  src/lib.rs
crates/liber-vault/                      filesystem only
  src/lib.rs        exports + is_hidden_name (M0)
  src/error.rs      VaultError, Result, io_err
  src/hash.rs       Hash (BLAKE3)
  src/path.rs       VaultPath (validated vault-relative path)
  src/config.rs     AttachmentPolicy, .liber/vault.json + .obsidian/app.json readers
  src/vault.rs      Vault::open, warnings, excludes
  src/scan.rs       Entry/EntryKind/Scan, scan, scan_from, list_dir, stat
  src/fsops.rs      fs_path, read, write_cas, create_dir, rename, trash
  src/watch.rs      WatchEvent, Watcher, Vault::watch
  tests/            path_hash.rs, open_scan.rs, write_ops.rs, watch.rs
crates/liber-markdown/                   pure parsing
  src/lib.rs        exports
  src/title.rs      extract_title (M0, unchanged)
  src/types.rs      PageMeta, Tag, LinkKind, LinkRef
  src/wikilink.rs   [[…]] inner parser and finder
  src/frontmatter.rs YAML with byte ranges
  src/body.rs       body links, tags, excerpt
  src/page.rs       parse_page
  src/resolve.rs    FileSet, resolve, shortest_unique_target, link_key, name_key
  tests/            frontmatter_api.rs, fixture_pages.rs, resolve_api.rs
crates/liber-index/                      SQLite cache
  src/lib.rs        exports + cache_dir_name (M0)
  src/schema.rs     schema v1
  src/rows.rs       FileKind, FileRow, Stat, TreeNode, LinkRow, PageRow
  src/index.rs      Index, Tx, IndexError
  tests/index.rs
crates/liber-session/                    one open vault
  src/lib.rs        exports
  src/error.rs      SessionError
  src/events.rs     IndexReport, SessionEvent, RenameOutcome
  src/session.rs    open, reindex_all, load, reads, create/trash
  src/rename.rs     rename planner + rewrite
  src/watching.rs   start_watching, apply
  tests/            open.rs, rename.rs, rename_props.rs, watching.rs
  benches/vault.rs  criterion, 10k notes
docs/handoff/2026-10-12-m1a-vault-core-handoff.md   (Task 12)
```

---

### Task 1: liber-vault: `VaultPath`, `Hash` (BLAKE3) and `VaultError`

**Files:**
- Modify: `Cargo.toml` (workspace dependencies for all of M1a)
- Modify: `crates/liber-vault/Cargo.toml`
- Create: `crates/liber-vault/src/error.rs`, `crates/liber-vault/src/hash.rs`, `crates/liber-vault/src/path.rs`
- Modify: `crates/liber-vault/src/lib.rs`
- Test: `crates/liber-vault/tests/path_hash.rs` (+ unit tests inside `hash.rs` and `path.rs`)

**Interfaces:**
- Consumes: M0 `liber_vault::is_hidden_name(name: &str) -> bool` (kept unchanged).
- Produces (used by every later task):
  - `pub struct VaultPath` (Clone, Eq, Ord, Hash, Display, Debug): `root() -> VaultPath`, `new(&str) -> Result<VaultPath>`, `from_fs_path(root: &Path, path: &Path) -> Result<VaultPath>`, `is_root(&self) -> bool`, `as_str(&self) -> &str`, `parent(&self) -> Option<VaultPath>`, `file_name(&self) -> &str`, `stem(&self) -> &str`, `extension(&self) -> Option<&str>`, `join(&self, rel: &str) -> Result<VaultPath>`, `starts_with(&self, prefix: &VaultPath) -> bool`, `rebase(&self, from: &VaultPath, to: &VaultPath) -> Option<VaultPath>`, `to_fs_path(&self, root: &Path) -> PathBuf`.
  - `pub struct Hash` (Copy, Eq, Ord, Hash, Display = hex): `of(&[u8]) -> Hash`, `to_hex(&self) -> String`, `from_hex(&str) -> Option<Hash>`.
  - `pub enum VaultError { NotFound(String), AlreadyExists(String), Conflict { path: String, current: Hash }, OutsideVault(String), NotUtf8(String), InvalidConfig { file: String, reason: String }, Io { path: String, source: std::io::Error }, Watch(String) }` and `pub type Result<T> = std::result::Result<T, VaultError>`.

- [ ] **Step 1: Add every M1a dependency to the workspace once (unused workspace deps are inert) and the first two to `liber-vault`**

In `Cargo.toml`, replace:

```toml
sha2 = "0.11.1"
```

with:

```toml
sha2 = "0.11.1"
# M1a vault core
blake3 = "1.8.7"
dunce = "1.0.5"
globset = "0.4.20"
notify-debouncer-mini = "0.7.0"
percent-encoding = "2.3.2"
rayon = "1.12.0"
rusqlite = { version = "0.40.2", features = ["bundled"] }
thiserror = "2.0.21"
trash = "5.2.9"
unicode-normalization = "0.1.25"
yaml-rust2 = "0.13.0"
# M1a test/bench only
criterion = "0.8.2"
proptest = "1.12.0"
tempfile = "3.27.0"
```

`crates/liber-vault/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-vault"
description = "Vault filesystem model: scanning, watching, atomic writes, trash."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
blake3.workspace = true
thiserror.workspace = true

[lints]
workspace = true
```

- [ ] **Step 2: Write the failing integration test**

`crates/liber-vault/tests/path_hash.rs` (create or replace the whole file):

```rust
use liber_vault::{Hash, VaultError, VaultPath};

#[test]
fn vlt_path_public_api() {
    let p = VaultPath::new("Projects/Ideas.md").unwrap();
    assert_eq!(
        (p.as_str(), p.stem(), p.extension()),
        ("Projects/Ideas.md", "Ideas", Some("md"))
    );
    assert_eq!(
        p.parent().unwrap().join("Other.md").unwrap().as_str(),
        "Projects/Other.md"
    );
    assert!(matches!(
        VaultPath::new("../escape"),
        Err(VaultError::OutsideVault(_))
    ));
    assert!(VaultPath::root().is_root());
}

#[test]
fn nfr_08_hash_public_api() {
    let h = Hash::of(b"note");
    assert_eq!(Hash::from_hex(&h.to_hex()), Some(h));
    assert_eq!(h.to_string().len(), 64);
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cargo test -p liber-vault --test path_hash`

Expected: FAIL: compile error `unresolved imports liber_vault::Hash, liber_vault::VaultError, liber_vault::VaultPath`

- [ ] **Step 4: Implement (unit tests live next to the code)**

`crates/liber-vault/src/error.rs` (create or replace the whole file):

```rust
use crate::Hash;

/// Errors from vault filesystem operations. Paths are vault-relative strings.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("file changed on disk: {path}")]
    Conflict { path: String, current: Hash },
    #[error("path is outside the vault: {0}")]
    OutsideVault(String),
    #[error("not valid UTF-8: {0}")]
    NotUtf8(String),
    #[error("invalid config {file}: {reason}")]
    InvalidConfig { file: String, reason: String },
    #[error("I/O error on {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("file watcher error: {0}")]
    Watch(String),
}

pub type Result<T> = std::result::Result<T, VaultError>;
```

`crates/liber-vault/src/hash.rs` (create or replace the whole file):

```rust
use std::fmt;

/// BLAKE3 content hash used for compare-and-swap writes and rename detection.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hash([u8; 32]);

impl Hash {
    pub fn of(bytes: &[u8]) -> Hash {
        Hash(*blake3::hash(bytes).as_bytes())
    }

    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn from_hex(s: &str) -> Option<Hash> {
        if s.len() != 64 || !s.is_ascii() {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(Hash(out))
    }
}

impl fmt::Debug for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hash({})", &self.to_hex()[..12])
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::Hash;

    #[test]
    fn hash_is_blake3_and_round_trips_hex() {
        let h = Hash::of(b"hello");
        assert_eq!(
            h.to_hex(),
            "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f"
        );
        assert_eq!(Hash::from_hex(&h.to_hex()), Some(h));
        assert_ne!(Hash::of(b"hello"), Hash::of(b"hello!"));
    }

    #[test]
    fn from_hex_rejects_bad_input() {
        assert_eq!(Hash::from_hex("abc"), None);
        assert_eq!(Hash::from_hex(&"zz".repeat(32)), None);
        assert_eq!(Hash::from_hex(&"é".repeat(32)), None);
    }
}
```

`crates/liber-vault/src/path.rs` (create or replace the whole file):

```rust
use crate::error::{Result, VaultError};
use std::fmt;
use std::path::{Component, Path, PathBuf};

/// A validated vault-relative path with `/` separators, stored exactly as named
/// on disk (no Unicode normalization). The empty path is the vault root.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VaultPath(String);

impl VaultPath {
    pub fn root() -> VaultPath {
        VaultPath(String::new())
    }

    /// Validates a `/`-separated relative path. Rejects empty, absolute, `.`/`..`
    /// components, empty components, backslashes, drive prefixes and NUL bytes.
    pub fn new(s: &str) -> Result<VaultPath> {
        let bad = |why: &str| Err(VaultError::OutsideVault(format!("{s:?}: {why}")));
        if s.is_empty() {
            return bad("empty path");
        }
        if s.contains('\0') {
            return bad("NUL byte");
        }
        if s.contains('\\') {
            return bad("backslash");
        }
        if s.starts_with('/') {
            return bad("absolute path");
        }
        if s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic() {
            return bad("drive prefix");
        }
        for part in s.split('/') {
            match part {
                "" => return bad("empty component"),
                "." | ".." => return bad("dot component"),
                _ => {}
            }
        }
        Ok(VaultPath(s.to_string()))
    }

    /// Builds a vault path from an absolute filesystem path under `root`.
    pub fn from_fs_path(root: &Path, path: &Path) -> Result<VaultPath> {
        let rel = path
            .strip_prefix(root)
            .map_err(|_| VaultError::OutsideVault(path.display().to_string()))?;
        let mut parts = Vec::new();
        for c in rel.components() {
            match c {
                Component::Normal(os) => {
                    let s = os
                        .to_str()
                        .ok_or_else(|| VaultError::NotUtf8(path.display().to_string()))?;
                    parts.push(s);
                }
                _ => return Err(VaultError::OutsideVault(path.display().to_string())),
            }
        }
        if parts.is_empty() {
            return Ok(VaultPath::root());
        }
        VaultPath::new(&parts.join("/"))
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `None` for the root; the root for top-level entries.
    pub fn parent(&self) -> Option<VaultPath> {
        if self.is_root() {
            return None;
        }
        Some(match self.0.rfind('/') {
            Some(i) => VaultPath(self.0[..i].to_string()),
            None => VaultPath::root(),
        })
    }

    /// Last component (empty for the root).
    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or("")
    }

    /// File name without its last extension (`notes.md` → `notes`, `.x` → `.x`).
    pub fn stem(&self) -> &str {
        let name = self.file_name();
        match name.rfind('.') {
            Some(i) if i > 0 => &name[..i],
            _ => name,
        }
    }

    pub fn extension(&self) -> Option<&str> {
        let name = self.file_name();
        match name.rfind('.') {
            Some(i) if i > 0 && i + 1 < name.len() => Some(&name[i + 1..]),
            _ => None,
        }
    }

    /// Appends a relative `/`-separated path.
    pub fn join(&self, rel: &str) -> Result<VaultPath> {
        if self.is_root() {
            VaultPath::new(rel)
        } else {
            VaultPath::new(&format!("{}/{}", self.0, rel))
        }
    }

    /// Component-wise prefix test; every path starts with the root.
    pub fn starts_with(&self, prefix: &VaultPath) -> bool {
        prefix.is_root()
            || self.0 == prefix.0
            || (self.0.starts_with(&prefix.0) && self.0.as_bytes()[prefix.0.len()] == b'/')
    }

    /// Re-roots `self` from `from` to `to` (used for folder moves).
    /// Returns `None` when `self` is not `from` or inside it.
    pub fn rebase(&self, from: &VaultPath, to: &VaultPath) -> Option<VaultPath> {
        if !self.starts_with(from) || from.is_root() {
            return None;
        }
        let rest = &self.0[from.0.len()..];
        Some(VaultPath(format!("{}{}", to.0, rest)))
    }

    pub fn to_fs_path(&self, root: &Path) -> PathBuf {
        let mut p = root.to_path_buf();
        if !self.is_root() {
            for part in self.0.split('/') {
                p.push(part);
            }
        }
        p
    }
}

impl fmt::Display for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "VaultPath({:?})", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vlt_path_accepts_relative_paths() {
        for ok in ["a.md", "Projects/Ideas.md", "Café/ñandú 🎨.md", "a b/c d"] {
            assert_eq!(VaultPath::new(ok).unwrap().as_str(), ok);
        }
    }

    #[test]
    fn vlt_path_rejects_escapes_and_malformed_paths() {
        for bad in [
            "",
            "/abs",
            "../x",
            "a/../b",
            "./a",
            "a/./b",
            "a//b",
            "a/",
            "C:/x",
            "c:x",
            "a\\b",
            "nul\0byte",
        ] {
            assert!(
                matches!(VaultPath::new(bad), Err(VaultError::OutsideVault(_))),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn parent_name_stem_extension() {
        let p = VaultPath::new("Projects/Rex/draft.v2.md").unwrap();
        assert_eq!(p.parent().unwrap().as_str(), "Projects/Rex");
        assert_eq!(p.file_name(), "draft.v2.md");
        assert_eq!(p.stem(), "draft.v2");
        assert_eq!(p.extension(), Some("md"));
        let top = VaultPath::new("a.md").unwrap();
        assert!(top.parent().unwrap().is_root());
        assert_eq!(VaultPath::root().parent(), None);
        let dotfile = VaultPath::new(".hidden").unwrap();
        assert_eq!(dotfile.stem(), ".hidden");
        assert_eq!(dotfile.extension(), None);
        assert_eq!(VaultPath::new("noext").unwrap().extension(), None);
    }

    #[test]
    fn join_and_starts_with_are_component_wise() {
        let dir = VaultPath::new("Pro").unwrap();
        assert_eq!(dir.join("x.md").unwrap().as_str(), "Pro/x.md");
        assert_eq!(VaultPath::root().join("x.md").unwrap().as_str(), "x.md");
        assert!(dir.join("../x").is_err());
        let inside = VaultPath::new("Pro/x.md").unwrap();
        let sibling = VaultPath::new("Projects/x.md").unwrap();
        assert!(inside.starts_with(&dir));
        assert!(dir.starts_with(&dir));
        assert!(!sibling.starts_with(&dir));
        assert!(sibling.starts_with(&VaultPath::root()));
    }

    #[test]
    fn rebase_moves_subtree_paths() {
        let from = VaultPath::new("A").unwrap();
        let to = VaultPath::new("B/C").unwrap();
        let p = VaultPath::new("A/x/y.md").unwrap();
        assert_eq!(p.rebase(&from, &to).unwrap().as_str(), "B/C/x/y.md");
        assert_eq!(from.rebase(&from, &to).unwrap().as_str(), "B/C");
        assert_eq!(VaultPath::new("AB/x").unwrap().rebase(&from, &to), None);
    }

    #[test]
    fn fs_path_round_trip() {
        let root = Path::new("/vault");
        let p = VaultPath::new("a/b c.md").unwrap();
        let fs = p.to_fs_path(root);
        assert_eq!(VaultPath::from_fs_path(root, &fs).unwrap(), p);
        assert!(VaultPath::from_fs_path(root, root).unwrap().is_root());
        assert!(VaultPath::from_fs_path(root, Path::new("/elsewhere/x")).is_err());
    }
}
```

`crates/liber-vault/src/lib.rs` (create or replace the whole file):

```rust
//! Vault filesystem model: scanning, watching, atomic writes, trash.
//! Every path crossing this crate's boundary is vault-relative ([`VaultPath`]).

mod error;
mod hash;
mod path;

pub use error::{Result, VaultError};
pub use hash::Hash;
pub use path::VaultPath;

/// VLT-05: dot-entries (`.obsidian`, `.git`, `.liber`, …) are ignored everywhere.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::is_hidden_name;

    #[test]
    fn vlt_05_dot_folders_are_hidden() {
        for name in [".obsidian", ".git", ".liber", ".trash", ".", ".."] {
            assert!(is_hidden_name(name), "{name} should be hidden");
        }
    }

    #[test]
    fn vlt_05_regular_names_are_visible() {
        for name in ["Projects", "not.hidden", "notes.md", ""] {
            assert!(!is_hidden_name(name), "{name:?} should be visible");
        }
    }
}
```

- [ ] **Step 5: Run the crate's tests, clippy and rustfmt**

Run: `cargo test -p liber-vault && cargo clippy -p liber-vault --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 10 unit tests (2 M0 + 2 hash + 6 path) and 2 integration tests; no clippy warnings; no fmt diff

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock crates/liber-vault
git commit -m "feat(vault): VaultPath, BLAKE3 Hash and VaultError (VLT-05, NFR-08)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: liber-vault: `Vault::open`, `scan`, fixture vaults and the test kit

**Files:**
- Modify: `crates/liber-vault/Cargo.toml`, `crates/liber-vault/src/error.rs` (adds `io_err`), `crates/liber-vault/src/lib.rs`
- Create: `crates/liber-vault/src/config.rs`, `crates/liber-vault/src/vault.rs`, `crates/liber-vault/src/scan.rs`
- Create: `crates/liber-testkit/Cargo.toml`, `crates/liber-testkit/src/lib.rs`
- Create: `fixtures/vaults/{obsidian-basic,ambiguous-names,edge-cases}/…`, `.gitattributes`
- Modify: `.prettierignore`
- Test: `crates/liber-vault/tests/open_scan.rs` (+ unit tests in `config.rs`)

**Interfaces:**
- Consumes: Task 1 `VaultPath`, `VaultError`, `Result`, `is_hidden_name`.
- Produces:
  - `pub struct Vault`: `open(root: &Path) -> Result<Vault>` (writes nothing), `root(&self) -> &Path` (canonical, `\\?\` stripped), `attachment_policy(&self) -> &AttachmentPolicy`, `warnings(&self) -> &[String]`, `is_excluded(&self, rel: &str) -> bool`, `scan(&self) -> Result<Scan>`, `scan_from(&self, dir: &VaultPath) -> Result<Scan>`, `list_dir(&self, dir: &VaultPath) -> Result<Vec<Entry>>`, `stat(&self, path: &VaultPath) -> Result<Option<Entry>>`. Field `pub(crate) excludes: GlobSet` (used by Task 4).
  - `pub enum AttachmentPolicy { VaultRoot, Folder(VaultPath), SameAsNote, Subfolder(String) }` (default `Subfolder("attachments")`).
  - `pub enum EntryKind { File, Dir }`, `pub struct Entry { pub path: VaultPath, pub kind: EntryKind, pub mtime_ns: i128, pub size: u64 }`, `pub struct Scan { pub entries: Vec<Entry> /* sorted by path */, pub skipped: Vec<String> }`.
  - `pub(crate) fn io_err(path: impl Into<String>, source: std::io::Error) -> VaultError` (maps NotFound/AlreadyExists kinds).
  - Test kit (`liber-testkit`, dev-dependency only): `fixture_path(name: &str) -> PathBuf`, `copy_fixture(name: &str) -> TempDir`, `trashable_fixture(name: &str) -> TempDir` (temp dir inside `$HOME` so the OS trash works on Linux), `snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime)>`, `wait_until(timeout: Duration, check: impl FnMut() -> bool) -> bool`.
  - Fixture vaults used by Tasks 6, 9, 10, 11.

- [ ] **Step 1: Add the test kit crate, manifests, `.gitattributes` (keep fixture bytes exact: CRLF and invalid UTF-8 are on purpose) and ignore fixtures in Prettier**

`crates/liber-testkit/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-testkit"
description = "Test-only helpers shared by the vault, index and session crates: fixture vaults, snapshots, polling."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
tempfile.workspace = true

[lints]
workspace = true
```

`crates/liber-testkit/src/lib.rs` (create or replace the whole file):

```rust
//! Test-only helpers. Never a dependency of production code.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use tempfile::TempDir;

/// Absolute path of a committed fixture vault under `fixtures/vaults/`.
pub fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/vaults")
        .join(name)
}

/// Copies a fixture vault (hidden entries included) into a fresh temp dir.
/// Mutating tests must use this; committed fixtures are never written.
pub fn copy_fixture(name: &str) -> TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    copy_dir(&fixture_path(name), dir.path());
    dir
}

/// Like [`copy_fixture`], but inside the user's home folder so the OS trash
/// works (on Linux the system temp dir is often a different filesystem than
/// `~/.local/share/Trash`). Use only in tests that call `trash`.
pub fn trashable_fixture(name: &str) -> TempDir {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = tempfile::Builder::new()
        .prefix("liber-trash-test-")
        .tempdir_in(home)
        .expect("tempdir in home");
    copy_dir(&fixture_path(name), dir.path());
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    for item in std::fs::read_dir(from).expect("read fixture dir") {
        let item = item.expect("dir entry");
        let target = to.join(item.file_name());
        if item.file_type().expect("file type").is_dir() {
            std::fs::create_dir(&target).expect("create dir");
            copy_dir(&item.path(), &target);
        } else {
            std::fs::copy(item.path(), &target).expect("copy file");
        }
    }
}

/// Every file and folder under `root` (hidden included) → (bytes, mtime).
/// Folders map to empty bytes. Used to prove an operation changed nothing.
pub fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for item in std::fs::read_dir(&dir).expect("read dir") {
            let item = item.expect("dir entry");
            let meta = item.metadata().expect("metadata");
            let rel = item.path().strip_prefix(root).unwrap().to_path_buf();
            let bytes = if meta.is_dir() {
                stack.push(item.path());
                Vec::new()
            } else {
                std::fs::read(item.path()).expect("read file")
            };
            out.insert(rel, (bytes, meta.modified().expect("mtime")));
        }
    }
    out
}

/// Polls `check` every 25 ms until it returns true or `timeout` elapses.
pub fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    check()
}
```

`crates/liber-vault/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-vault"
description = "Vault filesystem model: scanning, watching, atomic writes, trash."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
blake3.workspace = true
dunce.workspace = true
globset.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true

[dev-dependencies]
liber-testkit = { path = "../liber-testkit" }
tempfile.workspace = true

[lints]
workspace = true
```

`.gitattributes` (create or replace the whole file):

```text
# Fixture vaults are byte-exact test data (CRLF and invalid UTF-8 on purpose).
fixtures/** -text
```

In `.prettierignore`, replace:

```text
design
```

with:

```text
design
fixtures
```

- [ ] **Step 2: Create the fixture vaults (byte-exact; run from anywhere inside the repo). Note: a nested `.git/` cannot be committed, so `.trash/` stands in for hidden folders; NFD file names are tested at runtime because git on macOS re-normalizes them**

````bash
cd "$(git rev-parse --show-toplevel)"
F=fixtures/vaults
mkdir -p "$F/ambiguous-names" "$F/ambiguous-names/Archive/Old" "$F/ambiguous-names/Elsewhere" "$F/ambiguous-names/Projects" "$F/ambiguous-names/Projects/Deep" "$F/edge-cases" "$F/edge-cases/unicode" "$F/obsidian-basic" "$F/obsidian-basic/.obsidian" "$F/obsidian-basic/.trash" "$F/obsidian-basic/Character Design" "$F/obsidian-basic/Character Design/DMC" "$F/obsidian-basic/Character Design/assets" "$F/obsidian-basic/Game Design"
cat > "$F/ambiguous-names/Archive/Old/Ideas.md" <<'EOF_FIXTURE'
# Old ideas
EOF_FIXTURE
cat > "$F/ambiguous-names/Elsewhere/Note.md" <<'EOF_FIXTURE'
# Note

[[Ideas]]
EOF_FIXTURE
cat > "$F/ambiguous-names/Ideas.md" <<'EOF_FIXTURE'
# Root ideas
EOF_FIXTURE
cat > "$F/ambiguous-names/Links.md" <<'EOF_FIXTURE'
# Links

- [[Ideas]]
- [[Projects/Ideas]]
- [[Deep/Ideas]]
- [[Old/Ideas]]
EOF_FIXTURE
cat > "$F/ambiguous-names/Projects/Deep/Ideas.md" <<'EOF_FIXTURE'
# Deep ideas
EOF_FIXTURE
cat > "$F/ambiguous-names/Projects/Ideas.md" <<'EOF_FIXTURE'
# Project ideas
EOF_FIXTURE
cat > "$F/ambiguous-names/Projects/Other.md" <<'EOF_FIXTURE'
# Other

[[Ideas]]
EOF_FIXTURE
cat > "$F/edge-cases/bad-yaml.md" <<'EOF_FIXTURE'
---
tags: [unclosed
subtitle: x
---
# Still indexed

Link to [[target]] and #ok
EOF_FIXTURE
cat > "$F/edge-cases/code.md" <<'EOF_FIXTURE'
# Code

`[[inline-no]]` and `#no-tag`

```md
[[fenced-no]] #fenced-no
```

    [[indented-no]] #indented-no

<div>
[[html-no]]
</div>

<!-- [[comment-no]] -->

Escaped \[[escaped-no]] and real: [[target]] #real-tag
EOF_FIXTURE
printf -- '---\r\nsubtitle: Windows\r\n---\r\n# CRLF page\r\n\r\nLink [[target]] #crlf\r\n' > "$F/edge-cases/crlf.md"
: > "$F/edge-cases/empty.md"
printf -- '\377\376 not utf-8 \377\n' > "$F/edge-cases/latin1.md"
cat > "$F/edge-cases/target.md" <<'EOF_FIXTURE'
# Target
EOF_FIXTURE
cat > "$F/edge-cases/unicode/Café ñandú 🎨.md" <<'EOF_FIXTURE'
# Café ñandú 🎨

Self link in other case: [[CAFÉ ÑANDÚ 🎨]]
EOF_FIXTURE
cat > "$F/obsidian-basic/.obsidian/app.json" <<'EOF_FIXTURE'
{
  "attachmentFolderPath": "./assets",
  "alwaysUpdateLinks": true
}
EOF_FIXTURE
cat > "$F/obsidian-basic/.trash/old.md" <<'EOF_FIXTURE'
# Deleted page

Obsidian keeps deleted notes here. [[Welcome]]
EOF_FIXTURE
cat > "$F/obsidian-basic/Character Design/DMC/Sparda.md" <<'EOF_FIXTURE'
# Sparda

## Coat

Coat studies. Back to [[My characters]].

## Palette

Dark reds. #character #study
EOF_FIXTURE
cat > "$F/obsidian-basic/Character Design/My characters.md" <<'EOF_FIXTURE'
---
subtitle: Index of originals
tags: [character, index]
---
# My characters

- [[rex-draft|Generator Rex]]
- [[Generator Rex]] stays unresolved: links use file names, not titles
- [[Sparda#Coat|the demon knight]]
- [[DMC/Sparda]]

#character/original
EOF_FIXTURE
cat > "$F/obsidian-basic/Character Design/assets/rex-cover.png" <<'EOF_FIXTURE'
PNG placeholder: cover
EOF_FIXTURE
cat > "$F/obsidian-basic/Character Design/assets/rex-turnaround.png" <<'EOF_FIXTURE'
PNG placeholder: turnaround
EOF_FIXTURE
cat > "$F/obsidian-basic/Character Design/assets/voice-reference.mp3" <<'EOF_FIXTURE'
MP3 placeholder
EOF_FIXTURE
cat > "$F/obsidian-basic/Character Design/rex-draft.md" <<'EOF_FIXTURE'
---
subtitle: Hero redesign · v3
cover: assets/rex-cover.png
cover-y: 40
tags:
  - character
  - redesign
related:
  - "[[Sparda]]"
  - { link: "[[Game 1]]", label: "playable version", directed: true }
---
# Generator Rex

## Concept

Teen agent who builds machines. Turnaround: ![[rex-turnaround.png]]
Voice note: ![[voice-reference.mp3]]

Palette notes in [Sparda's page](DMC/Sparda.md#Palette), [the game](</Game Design/Game 1.md>) and [encoded](../Game%20Design/Game%201.md).

External: [site](https://example.com) #redesign
EOF_FIXTURE
cat > "$F/obsidian-basic/Game Design/Game 1.md" <<'EOF_FIXTURE'
---
tags: game
---
# Game 1

Vertical slice plan. The hero is [[rex-draft]].
EOF_FIXTURE
cat > "$F/obsidian-basic/Game Design/notes.txt" <<'EOF_FIXTURE'
plain text attachment
EOF_FIXTURE
cat > "$F/obsidian-basic/Welcome.md" <<'EOF_FIXTURE'
# Welcome

This vault exercises Liber Linteum. Start at [[Character Design/My characters|my characters]].
EOF_FIXTURE
````

- [ ] **Step 3: Write the failing integration tests**

`crates/liber-vault/tests/open_scan.rs` (create or replace the whole file):

```rust
use liber_testkit::{copy_fixture, fixture_path, snapshot};
use liber_vault::{AttachmentPolicy, EntryKind, Vault, VaultError, VaultPath};

fn paths(vault: &Vault) -> Vec<String> {
    vault
        .scan()
        .unwrap()
        .entries
        .iter()
        .map(|e| e.path.to_string())
        .collect()
}

#[test]
fn vlt_01_open_reads_obsidian_attachment_setting() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    assert_eq!(
        vault.attachment_policy(),
        &AttachmentPolicy::Subfolder("assets".into())
    );
    assert!(vault.warnings().is_empty(), "{:?}", vault.warnings());
}

#[test]
fn vlt_01_open_missing_folder_is_not_found() {
    let err = Vault::open(std::path::Path::new("/definitely/not/here")).unwrap_err();
    assert!(matches!(err, VaultError::NotFound(_)), "{err:?}");
}

#[test]
fn vlt_05_scan_skips_hidden_entries_and_sorts() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let p = paths(&vault);
    assert!(
        p.iter()
            .all(|x| !x.contains(".obsidian") && !x.contains(".trash"))
    );
    let mut sorted = p.clone();
    sorted.sort();
    assert_eq!(p, sorted);
    assert!(p.contains(&"Character Design/assets/rex-cover.png".to_string()));
    assert!(p.contains(&"Character Design/DMC".to_string()));
}

#[test]
fn vlt_05_scan_reports_kinds_and_sizes() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let scan = vault.scan().unwrap();
    let welcome = scan
        .entries
        .iter()
        .find(|e| e.path.as_str() == "Welcome.md")
        .unwrap();
    assert_eq!(welcome.kind, EntryKind::File);
    assert!(welcome.size > 0 && welcome.mtime_ns > 0);
    let dir = scan
        .entries
        .iter()
        .find(|e| e.path.as_str() == "Game Design")
        .unwrap();
    assert_eq!(dir.kind, EntryKind::Dir);
}

#[test]
fn vlt_05_exclude_globs_and_bad_config_are_handled() {
    let dir = copy_fixture("obsidian-basic");
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{ "version": 1, "exclude": ["Game Design", "Game Design/**", "**/*.mp3", "[bad"],
            "attachments": { "mode": "same" } }"#,
    )
    .unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let p = paths(&vault);
    assert!(!p.iter().any(|x| x.starts_with("Game Design")), "{p:?}");
    assert!(!p.iter().any(|x| x.ends_with(".mp3")));
    assert_eq!(vault.attachment_policy(), &AttachmentPolicy::SameAsNote);
    assert_eq!(
        vault.warnings().len(),
        1,
        "bad glob reported: {:?}",
        vault.warnings()
    );

    std::fs::write(dir.path().join(".liber/vault.json"), "{ not json").unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert!(vault.warnings()[0].contains(".liber/vault.json"));
    assert_eq!(
        vault.attachment_policy(),
        &AttachmentPolicy::Subfolder("assets".into())
    );
}

#[test]
fn vlt_02_open_and_scan_write_nothing() {
    for name in ["obsidian-basic", "ambiguous-names", "edge-cases"] {
        let dir = copy_fixture(name);
        let before = snapshot(dir.path());
        let vault = Vault::open(dir.path()).unwrap();
        vault.scan().unwrap();
        assert_eq!(snapshot(dir.path()), before, "{name} changed");
        assert!(!dir.path().join(".liber").exists());
    }
}

#[cfg(unix)]
#[test]
fn review_focus_symlinks_outside_vault_and_folder_symlinks_are_skipped() {
    let dir = copy_fixture("ambiguous-names");
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), "# secret").unwrap();
    let root = dir.path();
    std::os::unix::fs::symlink(outside.path().join("secret.md"), root.join("leak.md")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("leakdir")).unwrap();
    std::os::unix::fs::symlink(root.join("Projects"), root.join("loop")).unwrap();
    std::os::unix::fs::symlink(root.join("Ideas.md"), root.join("alias.md")).unwrap();
    let vault = Vault::open(root).unwrap();
    let scan = vault.scan().unwrap();
    let p: Vec<_> = scan.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(!p.contains(&"leak.md"));
    assert!(
        !p.iter()
            .any(|x| x.starts_with("leakdir") || x.starts_with("loop"))
    );
    assert!(p.contains(&"alias.md"), "in-vault file symlink is kept");
    assert_eq!(scan.skipped.len(), 3, "{:?}", scan.skipped);
}

#[test]
fn vault_path_maps_back_from_fs() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let fs = VaultPath::new("Game Design/Game 1.md")
        .unwrap()
        .to_fs_path(vault.root());
    assert!(fs.is_file());
}

#[test]
fn scan_from_list_dir_and_stat() {
    let vault = Vault::open(&fixture_path("obsidian-basic")).unwrap();
    let dir = VaultPath::new("Character Design").unwrap();
    let sub: Vec<_> = vault
        .scan_from(&dir)
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.path.to_string())
        .collect();
    assert!(sub.contains(&"Character Design/DMC/Sparda.md".to_string()));
    assert!(sub.iter().all(|p| p.starts_with("Character Design/")));
    let children: Vec<_> = vault
        .list_dir(&dir)
        .unwrap()
        .into_iter()
        .map(|e| e.path.to_string())
        .collect();
    assert_eq!(
        children,
        vec![
            "Character Design/DMC",
            "Character Design/My characters.md",
            "Character Design/assets",
            "Character Design/rex-draft.md"
        ]
    );
    let st = vault
        .stat(&VaultPath::new("Welcome.md").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(st.kind, EntryKind::File);
    assert!(
        vault
            .stat(&VaultPath::new("nope.md").unwrap())
            .unwrap()
            .is_none()
    );
    assert!(
        vault
            .stat(&VaultPath::new(".obsidian/app.json").unwrap())
            .unwrap()
            .is_none()
    );
}
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cargo test -p liber-vault --test open_scan`

Expected: FAIL: compile error `unresolved imports liber_vault::AttachmentPolicy, liber_vault::EntryKind, liber_vault::Vault`

- [ ] **Step 5: Implement**

In `crates/liber-vault/src/error.rs`, replace:

```rust
pub type Result<T> = std::result::Result<T, VaultError>;
```

with:

```rust
pub type Result<T> = std::result::Result<T, VaultError>;

pub(crate) fn io_err(path: impl Into<String>, source: std::io::Error) -> VaultError {
    let path = path.into();
    match source.kind() {
        std::io::ErrorKind::NotFound => VaultError::NotFound(path),
        std::io::ErrorKind::AlreadyExists => VaultError::AlreadyExists(path),
        _ => VaultError::Io { path, source },
    }
}
```

`crates/liber-vault/src/config.rs` (create or replace the whole file):

```rust
use crate::path::VaultPath;
use serde::Deserialize;

/// Where new attachments go (Q-ED-1). Resolved from `.liber/vault.json`, else
/// Obsidian's `attachmentFolderPath`, else the default `attachments/` subfolder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentPolicy {
    /// Vault root.
    VaultRoot,
    /// One fixed folder in the vault.
    Folder(VaultPath),
    /// Same folder as the note.
    SameAsNote,
    /// A subfolder with this name next to the note.
    Subfolder(String),
}

impl Default for AttachmentPolicy {
    fn default() -> Self {
        AttachmentPolicy::Subfolder("attachments".to_string())
    }
}

impl AttachmentPolicy {
    /// Obsidian `attachmentFolderPath`: `/` root, `./` same folder, `./x` subfolder, `x` folder.
    pub(crate) fn from_obsidian(value: &str) -> Option<AttachmentPolicy> {
        let v = value.trim();
        if v == "/" || v.is_empty() {
            Some(AttachmentPolicy::VaultRoot)
        } else if v == "./" || v == "." {
            Some(AttachmentPolicy::SameAsNote)
        } else if let Some(sub) = v.strip_prefix("./") {
            let sub = sub.trim_end_matches('/');
            VaultPath::new(sub).ok()?;
            Some(AttachmentPolicy::Subfolder(sub.to_string()))
        } else {
            let folder = v.trim_matches('/');
            VaultPath::new(folder).ok().map(AttachmentPolicy::Folder)
        }
    }
}

/// `.liber/vault.json` (arch §3.1). Unknown fields are ignored; M1a only reads
/// `exclude` and `attachments`.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct LiberVaultJson {
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub attachments: Option<LiberAttachments>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LiberAttachments {
    pub mode: String,
    #[serde(default)]
    pub path: String,
}

impl LiberAttachments {
    pub(crate) fn policy(&self) -> Option<AttachmentPolicy> {
        match self.mode.as_str() {
            "vault" if self.path.trim_matches('/').is_empty() => Some(AttachmentPolicy::VaultRoot),
            "vault" => VaultPath::new(self.path.trim_matches('/'))
                .ok()
                .map(AttachmentPolicy::Folder),
            "same" => Some(AttachmentPolicy::SameAsNote),
            "subfolder" => {
                let sub = self.path.trim_matches('/');
                let sub = if sub.is_empty() { "attachments" } else { sub };
                VaultPath::new(sub).ok()?;
                Some(AttachmentPolicy::Subfolder(sub.to_string()))
            }
            _ => None,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ObsidianAppJson {
    #[serde(rename = "attachmentFolderPath")]
    pub attachment_folder_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q_ed_1_obsidian_attachment_folder_path_forms() {
        use AttachmentPolicy::*;
        assert_eq!(AttachmentPolicy::from_obsidian("/"), Some(VaultRoot));
        assert_eq!(AttachmentPolicy::from_obsidian("./"), Some(SameAsNote));
        assert_eq!(
            AttachmentPolicy::from_obsidian("./assets"),
            Some(Subfolder("assets".into()))
        );
        assert_eq!(
            AttachmentPolicy::from_obsidian("Media/Img"),
            Some(Folder(VaultPath::new("Media/Img").unwrap()))
        );
        assert_eq!(AttachmentPolicy::from_obsidian("../outside"), None);
        assert_eq!(AttachmentPolicy::default(), Subfolder("attachments".into()));
    }

    #[test]
    fn q_ed_1_liber_attachment_modes() {
        let p = |mode: &str, path: &str| {
            LiberAttachments {
                mode: mode.into(),
                path: path.into(),
            }
            .policy()
        };
        assert_eq!(p("vault", ""), Some(AttachmentPolicy::VaultRoot));
        assert_eq!(
            p("vault", "Files"),
            Some(AttachmentPolicy::Folder(VaultPath::new("Files").unwrap()))
        );
        assert_eq!(p("same", ""), Some(AttachmentPolicy::SameAsNote));
        assert_eq!(
            p("subfolder", ""),
            Some(AttachmentPolicy::Subfolder("attachments".into()))
        );
        assert_eq!(p("weird", "x"), None);
    }
}
```

`crates/liber-vault/src/vault.rs` (create or replace the whole file):

```rust
use crate::config::{AttachmentPolicy, LiberVaultJson, ObsidianAppJson};
use crate::error::{Result, VaultError};
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::{Path, PathBuf};

/// An open vault folder. Opening reads configuration but never writes (VLT-02).
#[derive(Debug)]
pub struct Vault {
    pub(crate) root: PathBuf,
    pub(crate) excludes: GlobSet,
    attachments: AttachmentPolicy,
    warnings: Vec<String>,
}

impl Vault {
    pub fn open(root: &Path) -> Result<Vault> {
        let root = dunce::canonicalize(root).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => VaultError::NotFound(root.display().to_string()),
            _ => VaultError::Io {
                path: root.display().to_string(),
                source: e,
            },
        })?;
        if !root.is_dir() {
            return Err(VaultError::NotFound(format!(
                "{} is not a folder",
                root.display()
            )));
        }
        let mut warnings = Vec::new();

        let liber: LiberVaultJson = read_json(&root, ".liber/vault.json", &mut warnings);
        let obsidian: ObsidianAppJson = read_json(&root, ".obsidian/app.json", &mut warnings);

        let mut builder = GlobSetBuilder::new();
        for pattern in &liber.exclude {
            match Glob::new(pattern) {
                Ok(g) => {
                    builder.add(g);
                }
                Err(e) => warnings.push(format!(".liber/vault.json: bad exclude {pattern:?}: {e}")),
            }
        }
        let excludes = builder.build().unwrap_or_else(|_| GlobSet::empty());

        let attachments = liber
            .attachments
            .as_ref()
            .and_then(|a| a.policy())
            .or_else(|| {
                obsidian
                    .attachment_folder_path
                    .as_deref()
                    .and_then(AttachmentPolicy::from_obsidian)
            })
            .unwrap_or_default();

        Ok(Vault {
            root,
            excludes,
            attachments,
            warnings,
        })
    }

    /// Canonical absolute root (Windows `\\?\` stripped).
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn attachment_policy(&self) -> &AttachmentPolicy {
        &self.attachments
    }

    /// Non-fatal configuration problems found while opening.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// True when a vault-relative path matches a user exclude glob.
    pub fn is_excluded(&self, rel: &str) -> bool {
        self.excludes.is_match(rel)
    }
}

fn read_json<T: serde::de::DeserializeOwned + Default>(
    root: &Path,
    rel: &str,
    warnings: &mut Vec<String>,
) -> T {
    let path = root.join(rel);
    let Ok(bytes) = std::fs::read(&path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(
                VaultError::InvalidConfig {
                    file: rel.to_string(),
                    reason: e.to_string(),
                }
                .to_string(),
            );
            T::default()
        }
    }
}
```

`crates/liber-vault/src/scan.rs` (create or replace the whole file):

```rust
use crate::error::{Result, io_err};
use crate::is_hidden_name;
use crate::path::VaultPath;
use crate::vault::Vault;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
}

/// One visible vault entry with the stat used for incremental indexing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: VaultPath,
    pub kind: EntryKind,
    pub mtime_ns: i128,
    pub size: u64,
}

/// Result of a scan: visible entries (sorted by path) and skipped items with reasons.
#[derive(Debug, Default)]
pub struct Scan {
    pub entries: Vec<Entry>,
    pub skipped: Vec<String>,
}

pub(crate) fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0)
}

impl Vault {
    /// Walks the whole vault. Skips hidden names at any depth, user-excluded
    /// paths, symlinked folders, symlinks resolving outside the vault, and names
    /// that are not valid UTF-8 (reported in `skipped`).
    pub fn scan(&self) -> Result<Scan> {
        self.walk(&VaultPath::root(), true)
    }

    /// Like [`Vault::scan`] but only below `dir` (the folder itself is not included).
    pub fn scan_from(&self, dir: &VaultPath) -> Result<Scan> {
        self.walk(dir, true)
    }

    /// Visible direct children of `dir`, with the same filters as `scan`.
    pub fn list_dir(&self, dir: &VaultPath) -> Result<Vec<Entry>> {
        Ok(self.walk(dir, false)?.entries)
    }

    /// Stat of one visible entry; `None` if it does not exist, is hidden,
    /// excluded, or a symlink that `scan` would skip.
    pub fn stat(&self, path: &VaultPath) -> Result<Option<Entry>> {
        if path.is_root()
            || path.as_str().split('/').any(is_hidden_name)
            || self.is_excluded(path.as_str())
        {
            return Ok(None);
        }
        let full = path.to_fs_path(&self.root);
        Ok(self.entry_for(path.clone(), &full, &mut Vec::new()))
    }

    fn walk(&self, start: &VaultPath, recursive: bool) -> Result<Scan> {
        let mut out = Scan::default();
        let mut stack = vec![start.clone()];
        while let Some(dir) = stack.pop() {
            let fs_dir = dir.to_fs_path(&self.root);
            let read = match std::fs::read_dir(&fs_dir) {
                Ok(read) => read,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && dir != *start => continue,
                Err(e) => return Err(io_err(dir.as_str(), e)),
            };
            for item in read {
                let item = item.map_err(|e| io_err(dir.as_str(), e))?;
                let os_name = item.file_name();
                let Some(name) = os_name.to_str() else {
                    out.skipped
                        .push(format!("{}: name is not UTF-8", item.path().display()));
                    continue;
                };
                if is_hidden_name(name) {
                    continue;
                }
                let Ok(path) = dir.join(name) else {
                    out.skipped
                        .push(format!("{}: invalid name", item.path().display()));
                    continue;
                };
                if self.is_excluded(path.as_str()) {
                    continue;
                }
                if let Some(entry) = self.entry_for(path, &item.path(), &mut out.skipped) {
                    if entry.kind == EntryKind::Dir && recursive {
                        stack.push(entry.path.clone());
                    }
                    out.entries.push(entry);
                }
            }
        }
        out.entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    fn entry_for(&self, path: VaultPath, full: &Path, skipped: &mut Vec<String>) -> Option<Entry> {
        let lmeta = full.symlink_metadata().ok()?;
        let meta = if lmeta.file_type().is_symlink() {
            match self.symlink_target_meta(full) {
                Some(m) if m.is_file() => m,
                Some(_) => {
                    skipped.push(format!("{path}: symlinked folder not followed"));
                    return None;
                }
                None => {
                    skipped.push(format!("{path}: symlink points outside the vault"));
                    return None;
                }
            }
        } else {
            lmeta
        };
        if meta.is_dir() {
            Some(Entry {
                path,
                kind: EntryKind::Dir,
                mtime_ns: mtime_ns(&meta),
                size: 0,
            })
        } else if meta.is_file() {
            Some(Entry {
                path,
                kind: EntryKind::File,
                mtime_ns: mtime_ns(&meta),
                size: meta.len(),
            })
        } else {
            None
        }
    }

    /// Metadata of a symlink's target if the target is inside the vault.
    fn symlink_target_meta(&self, link: &Path) -> Option<std::fs::Metadata> {
        let target = dunce::canonicalize(link).ok()?;
        if !target.starts_with(&self.root) {
            return None;
        }
        std::fs::metadata(&target).ok()
    }
}
```

`crates/liber-vault/src/lib.rs` (create or replace the whole file):

```rust
//! Vault filesystem model: scanning, watching, atomic writes, trash.
//! Every path crossing this crate's boundary is vault-relative ([`VaultPath`]).

mod config;
mod error;
mod hash;
mod path;
mod scan;
mod vault;

pub use config::AttachmentPolicy;
pub use error::{Result, VaultError};
pub use hash::Hash;
pub use path::VaultPath;
pub use scan::{Entry, EntryKind, Scan};
pub use vault::Vault;

/// VLT-05: dot-entries (`.obsidian`, `.git`, `.liber`, …) are ignored everywhere.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::is_hidden_name;

    #[test]
    fn vlt_05_dot_folders_are_hidden() {
        for name in [".obsidian", ".git", ".liber", ".trash", ".", ".."] {
            assert!(is_hidden_name(name), "{name} should be hidden");
        }
    }

    #[test]
    fn vlt_05_regular_names_are_visible() {
        for name in ["Projects", "not.hidden", "notes.md", ""] {
            assert!(!is_hidden_name(name), "{name:?} should be visible");
        }
    }
}
```

- [ ] **Step 6: Run the tests, clippy and rustfmt**

Run: `cargo test -p liber-vault -p liber-testkit && cargo clippy -p liber-vault -p liber-testkit --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 12 unit + 9 open_scan + 2 path_hash tests (the symlink test runs on Unix only)

- [ ] **Step 7: Commit**

```bash
git add .gitattributes .prettierignore Cargo.lock crates/liber-vault crates/liber-testkit fixtures
git commit -m "feat(vault): open, scan and fixture vaults (VLT-01, VLT-02, VLT-05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: liber-vault: `read`, compare-and-swap `write_cas`, `create_dir`, `rename`, `trash`

**Files:**
- Modify: `crates/liber-vault/Cargo.toml`, `crates/liber-vault/src/lib.rs`
- Create: `crates/liber-vault/src/fsops.rs`
- Test: `crates/liber-vault/tests/write_ops.rs` (+ fault-injection unit test in `fsops.rs`)

**Interfaces:**
- Consumes: Tasks 1–2 (`Vault`, `VaultPath`, `Hash`, `io_err`).
- Produces (on `impl Vault`): `fs_path(&self, path: &VaultPath) -> Result<PathBuf>` (refuses symlinks escaping the vault), `read(&self, path) -> Result<(Vec<u8>, Hash)>`, `read_to_string(&self, path) -> Result<(String, Hash)>` (`NotUtf8`), `write_cas(&self, path, content: &[u8], expected: Option<Hash>) -> Result<Hash>` (`None` = create-only/`AlreadyExists`; `Some(h)` = `Conflict { current }` or `NotFound`), `create_dir(&self, path) -> Result<()>`, `rename(&self, from, to) -> Result<()>` (`AlreadyExists` unless case-only rename of the same entry), `trash(&self, path) -> Result<()>`. Constant `pub const TMP_MARKER: &str = ".liber-tmp-"` (temp names start with `.`, so scans/watchers ignore them).

- [ ] **Step 1: Add `trash` and `proptest`**

`crates/liber-vault/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-vault"
description = "Vault filesystem model: scanning, watching, atomic writes, trash."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
blake3.workspace = true
dunce.workspace = true
globset.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
trash.workspace = true

[dev-dependencies]
liber-testkit = { path = "../liber-testkit" }
proptest.workspace = true
tempfile.workspace = true

[lints]
workspace = true
```

- [ ] **Step 2: Write the failing integration tests**

`crates/liber-vault/tests/write_ops.rs` (create or replace the whole file):

```rust
use liber_testkit::trashable_fixture;
use liber_vault::{Hash, Vault, VaultError, VaultPath};
use proptest::prelude::*;

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn fresh() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

#[test]
fn nfr_08_write_cas_create_update_and_conflict() {
    let (dir, vault) = fresh();
    let p = vp("note.md");
    let h1 = vault.write_cas(&p, b"one", None).unwrap();
    assert_eq!(h1, Hash::of(b"one"));
    assert!(matches!(
        vault.write_cas(&p, b"x", None),
        Err(VaultError::AlreadyExists(_))
    ));
    let h2 = vault.write_cas(&p, b"two", Some(h1)).unwrap();
    match vault.write_cas(&p, b"three", Some(h1)) {
        Err(VaultError::Conflict { current, .. }) => assert_eq!(current, h2),
        other => panic!("expected conflict, got {other:?}"),
    }
    assert_eq!(std::fs::read(dir.path().join("note.md")).unwrap(), b"two");
    assert!(matches!(
        vault.write_cas(&vp("missing.md"), b"x", Some(h1)),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        vault.write_cas(&vp("no/such/dir.md"), b"x", None),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn read_returns_bytes_hash_and_utf8_errors() {
    let (dir, vault) = fresh();
    std::fs::write(dir.path().join("bin.md"), [0xff, 0xfe]).unwrap();
    let (bytes, hash) = vault.read(&vp("bin.md")).unwrap();
    assert_eq!(hash, Hash::of(&bytes));
    assert!(matches!(
        vault.read_to_string(&vp("bin.md")),
        Err(VaultError::NotUtf8(_))
    ));
    assert!(matches!(
        vault.read(&vp("nope.md")),
        Err(VaultError::NotFound(_))
    ));
}

#[cfg(unix)]
#[test]
fn nfr_08_write_cas_preserves_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, vault) = fresh();
    let p = vp("x.md");
    let h = vault.write_cas(&p, b"a", None).unwrap();
    let full = dir.path().join("x.md");
    std::fs::set_permissions(&full, std::fs::Permissions::from_mode(0o640)).unwrap();
    vault.write_cas(&p, b"b", Some(h)).unwrap();
    assert_eq!(
        std::fs::metadata(&full).unwrap().permissions().mode() & 0o777,
        0o640
    );
}

#[test]
fn exp_02_create_dir_and_rename() {
    let (dir, vault) = fresh();
    vault.create_dir(&vp("A")).unwrap();
    assert!(matches!(
        vault.create_dir(&vp("A")),
        Err(VaultError::AlreadyExists(_))
    ));
    assert!(matches!(
        vault.create_dir(&vp("X/Y")),
        Err(VaultError::NotFound(_))
    ));
    vault.write_cas(&vp("A/n.md"), b"n", None).unwrap();
    vault.write_cas(&vp("m.md"), b"m", None).unwrap();
    assert!(matches!(
        vault.rename(&vp("A/n.md"), &vp("m.md")),
        Err(VaultError::AlreadyExists(_))
    ));
    vault.create_dir(&vp("B")).unwrap();
    vault.rename(&vp("A"), &vp("B/A2")).unwrap();
    assert!(dir.path().join("B/A2/n.md").is_file());
    assert!(matches!(
        vault.rename(&vp("gone.md"), &vp("z.md")),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        vault.rename(&vp("m.md"), &vp("no/dir.md")),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn exp_02_case_only_rename() {
    let (dir, vault) = fresh();
    vault.write_cas(&vp("ideas.md"), b"x", None).unwrap();
    vault.rename(&vp("ideas.md"), &vp("Ideas.md")).unwrap();
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, vec!["Ideas.md".to_string()]);
}

#[test]
fn exp_03_trash_moves_to_os_trash() {
    let dir = trashable_fixture("ambiguous-names");
    let vault = Vault::open(dir.path()).unwrap();
    vault.trash(&vp("Archive")).unwrap();
    assert!(!dir.path().join("Archive").exists());
    assert!(matches!(
        vault.trash(&vp("Archive")),
        Err(VaultError::NotFound(_))
    ));
}

#[cfg(unix)]
#[test]
fn review_focus_writes_through_symlink_escaping_the_vault_are_refused() {
    let (dir, vault) = fresh();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();
    assert!(matches!(
        vault.write_cas(&vp("out/evil.md"), b"x", None),
        Err(VaultError::OutsideVault(_))
    ));
    assert!(!outside.path().join("evil.md").exists());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn nfr_08_successive_writes_round_trip_without_temp_leftovers(
        contents in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..2048), 1..6)
    ) {
        let (dir, vault) = fresh();
        let p = vp("p.md");
        let mut expected = None;
        for c in &contents {
            expected = Some(vault.write_cas(&p, c, expected).unwrap());
            prop_assert_eq!(&std::fs::read(dir.path().join("p.md")).unwrap(), c);
        }
        let count = std::fs::read_dir(dir.path()).unwrap().count();
        prop_assert_eq!(count, 1);
    }
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cargo test -p liber-vault --test write_ops`

Expected: FAIL: compile errors `no method named write_cas / read / rename / trash found for struct Vault`

- [ ] **Step 4: Implement**

`crates/liber-vault/src/fsops.rs` (create or replace the whole file):

```rust
use crate::error::{Result, VaultError, io_err};
use crate::hash::Hash;
use crate::path::VaultPath;
use crate::vault::Vault;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Suffix marker of in-flight atomic writes. Temp names start with `.` so scans
/// and watchers ignore them (VLT-05).
pub const TMP_MARKER: &str = ".liber-tmp-";

impl Vault {
    /// Absolute path for `path`, refusing anything whose deepest existing
    /// ancestor resolves (through symlinks) outside the vault.
    pub fn fs_path(&self, path: &VaultPath) -> Result<PathBuf> {
        let full = path.to_fs_path(&self.root);
        let mut probe = full.as_path();
        loop {
            if probe.symlink_metadata().is_ok() {
                let real = dunce::canonicalize(probe).map_err(|e| io_err(path.as_str(), e))?;
                if !real.starts_with(&self.root) {
                    return Err(VaultError::OutsideVault(path.to_string()));
                }
                return Ok(full);
            }
            match probe.parent() {
                Some(parent) => probe = parent,
                None => return Ok(full),
            }
        }
    }

    pub fn read(&self, path: &VaultPath) -> Result<(Vec<u8>, Hash)> {
        let bytes = std::fs::read(self.fs_path(path)?).map_err(|e| io_err(path.as_str(), e))?;
        let hash = Hash::of(&bytes);
        Ok((bytes, hash))
    }

    pub fn read_to_string(&self, path: &VaultPath) -> Result<(String, Hash)> {
        let (bytes, hash) = self.read(path)?;
        let text = String::from_utf8(bytes).map_err(|_| VaultError::NotUtf8(path.to_string()))?;
        Ok((text, hash))
    }

    /// Atomic compare-and-swap write (NFR-08).
    /// `expected = Some(h)`: the file must exist with hash `h`, else `Conflict`/`NotFound`.
    /// `expected = None`: create-only, `AlreadyExists` if the path exists.
    pub fn write_cas(
        &self,
        path: &VaultPath,
        content: &[u8],
        expected: Option<Hash>,
    ) -> Result<Hash> {
        self.write_cas_inner(path, content, expected, false)
    }

    pub(crate) fn write_cas_inner(
        &self,
        path: &VaultPath,
        content: &[u8],
        expected: Option<Hash>,
        fail_before_rename: bool,
    ) -> Result<Hash> {
        if path.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot write the vault root".into(),
            ));
        }
        let target = self.fs_path(path)?;
        let existing = match std::fs::read(&target) {
            Ok(bytes) => Some((Hash::of(&bytes), std::fs::metadata(&target).ok())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_err(path.as_str(), e)),
        };
        match (&expected, &existing) {
            (None, Some(_)) => return Err(VaultError::AlreadyExists(path.to_string())),
            (Some(_), None) => return Err(VaultError::NotFound(path.to_string())),
            (Some(want), Some((current, _))) if want != current => {
                return Err(VaultError::Conflict {
                    path: path.to_string(),
                    current: *current,
                });
            }
            _ => {}
        }
        let parent = target.parent().expect("non-root path has a parent");
        if !parent.is_dir() {
            return Err(VaultError::NotFound(
                path.parent().map(|p| p.to_string()).unwrap_or_default(),
            ));
        }
        let tmp = parent.join(format!(
            ".{}{}{}-{}",
            path.file_name(),
            TMP_MARKER,
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            file.write_all(content)?;
            file.sync_all()?;
            drop(file);
            if let Some((_, Some(meta))) = &existing {
                std::fs::set_permissions(&tmp, meta.permissions())?;
            }
            if fail_before_rename {
                return Err(std::io::Error::other("injected failure before rename"));
            }
            std::fs::rename(&tmp, &target)?;
            sync_dir(parent);
            Ok(())
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_file(&tmp);
            return Err(VaultError::Io {
                path: path.to_string(),
                source: e,
            });
        }
        Ok(Hash::of(content))
    }

    /// Creates one folder; the parent must exist.
    pub fn create_dir(&self, path: &VaultPath) -> Result<()> {
        std::fs::create_dir(self.fs_path(path)?).map_err(|e| io_err(path.as_str(), e))
    }

    /// Renames/moves a file or folder. Fails with `AlreadyExists` if `to` exists,
    /// except case-only renames of the same entry on case-insensitive filesystems.
    pub fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        if from.is_root() || to.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot rename the vault root".into(),
            ));
        }
        let src = self.fs_path(from)?;
        let dst = self.fs_path(to)?;
        if src.symlink_metadata().is_err() {
            return Err(VaultError::NotFound(from.to_string()));
        }
        if !dst.parent().is_some_and(Path::is_dir) {
            return Err(VaultError::NotFound(
                to.parent().map(|p| p.to_string()).unwrap_or_default(),
            ));
        }
        if dst.symlink_metadata().is_ok() {
            if same_entry(&src, &dst) && from != to {
                // Case-only rename on a case-insensitive FS: go through a temp name.
                let tmp = src.with_file_name(format!(
                    ".{}{}{}",
                    from.file_name(),
                    TMP_MARKER,
                    TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
                ));
                std::fs::rename(&src, &tmp).map_err(|e| io_err(from.as_str(), e))?;
                return std::fs::rename(&tmp, &dst).map_err(|e| io_err(to.as_str(), e));
            }
            return Err(VaultError::AlreadyExists(to.to_string()));
        }
        std::fs::rename(&src, &dst).map_err(|e| io_err(from.as_str(), e))
    }

    /// Moves a file or folder to the OS trash (EXP-03).
    pub fn trash(&self, path: &VaultPath) -> Result<()> {
        if path.is_root() {
            return Err(VaultError::OutsideVault(
                "cannot trash the vault root".into(),
            ));
        }
        let full = self.fs_path(path)?;
        if full.symlink_metadata().is_err() {
            return Err(VaultError::NotFound(path.to_string()));
        }
        trash::delete(&full).map_err(|e| VaultError::Io {
            path: path.to_string(),
            source: std::io::Error::other(e.to_string()),
        })
    }
}

fn same_entry(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfr_08_injected_failure_leaves_target_untouched_and_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        let p = VaultPath::new("a.md").unwrap();
        let h = vault.write_cas(&p, b"original", None).unwrap();
        let err = vault
            .write_cas_inner(&p, b"new content", Some(h), true)
            .unwrap_err();
        assert!(matches!(err, VaultError::Io { .. }));
        assert_eq!(std::fs::read(dir.path().join("a.md")).unwrap(), b"original");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["a.md".to_string()]);
    }
}
```

`crates/liber-vault/src/lib.rs` (create or replace the whole file):

```rust
//! Vault filesystem model: scanning, watching, atomic writes, trash.
//! Every path crossing this crate's boundary is vault-relative ([`VaultPath`]).

mod config;
mod error;
mod fsops;
mod hash;
mod path;
mod scan;
mod vault;

pub use config::AttachmentPolicy;
pub use error::{Result, VaultError};
pub use fsops::TMP_MARKER;
pub use hash::Hash;
pub use path::VaultPath;
pub use scan::{Entry, EntryKind, Scan};
pub use vault::Vault;

/// VLT-05: dot-entries (`.obsidian`, `.git`, `.liber`, …) are ignored everywhere.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::is_hidden_name;

    #[test]
    fn vlt_05_dot_folders_are_hidden() {
        for name in [".obsidian", ".git", ".liber", ".trash", ".", ".."] {
            assert!(is_hidden_name(name), "{name} should be hidden");
        }
    }

    #[test]
    fn vlt_05_regular_names_are_visible() {
        for name in ["Projects", "not.hidden", "notes.md", ""] {
            assert!(!is_hidden_name(name), "{name:?} should be visible");
        }
    }
}
```

- [ ] **Step 5: Run the tests, clippy and rustfmt. `exp_03_trash_moves_to_os_trash` really moves a temp folder named `liber-trash-test-*` to your OS trash**

Run: `cargo test -p liber-vault && cargo clippy -p liber-vault --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 13 unit + 8 write_ops + 9 open_scan + 2 path_hash tests

- [ ] **Step 6: Commit**

```bash
git add Cargo.lock crates/liber-vault
git commit -m "feat(vault): atomic CAS writes, rename, trash (NFR-08, EXP-02, EXP-03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: liber-vault: file watcher (`notify` 8.2 via `notify-debouncer-mini` 0.7)

**Files:**
- Modify: `crates/liber-vault/Cargo.toml`, `crates/liber-vault/src/lib.rs`
- Create: `crates/liber-vault/src/watch.rs`
- Test: `crates/liber-vault/tests/watch.rs`

**Interfaces:**
- Consumes: Task 2 `Vault` (`root`, `excludes`), `is_hidden_name`, `VaultPath::from_fs_path`.
- Produces: `pub enum WatchEvent { Changed(VaultPath), Removed(VaultPath), Overflow }`, `pub struct Watcher` (drop = stop), `pub const DEBOUNCE: Duration` (200 ms), `Vault::watch<F: Fn(Vec<WatchEvent>) + Send + 'static>(&self, callback: F) -> Result<Watcher>` — one sorted, de-duplicated batch per debounce tick; hidden/excluded/outside paths dropped; events classified by what exists on disk *now* (see plan note 1).

- [ ] **Step 1: Add `notify-debouncer-mini` (it re-exports `notify` 8.2, so `notify` is not declared separately)**

`crates/liber-vault/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-vault"
description = "Vault filesystem model: scanning, watching, atomic writes, trash."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
blake3.workspace = true
dunce.workspace = true
globset.workspace = true
notify-debouncer-mini.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
trash.workspace = true

[dev-dependencies]
liber-testkit = { path = "../liber-testkit" }
proptest.workspace = true
tempfile.workspace = true

[lints]
workspace = true
```

- [ ] **Step 2: Write the failing integration tests (they poll with timeouts, never fixed sleeps, apart from 300 ms to arm the backend)**

`crates/liber-vault/tests/watch.rs` (create or replace the whole file):

```rust
use liber_testkit::{copy_fixture, wait_until};
use liber_vault::{Vault, VaultPath, WatchEvent};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);
type Seen = Arc<Mutex<Vec<WatchEvent>>>;

fn watch(dir: &std::path::Path) -> (liber_vault::Watcher, Seen) {
    let vault = Vault::open(dir).unwrap();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let w = vault
        .watch(move |batch| sink.lock().unwrap().extend(batch))
        .unwrap();
    std::thread::sleep(Duration::from_millis(300)); // let the backend arm
    (w, seen)
}

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn saw(seen: &Seen, event: WatchEvent) -> bool {
    wait_until(WAIT, || seen.lock().unwrap().contains(&event))
}

#[test]
fn vlt_04_external_create_modify_remove_are_reported() {
    let dir = copy_fixture("ambiguous-names");
    let (_w, seen) = watch(dir.path());
    std::fs::write(dir.path().join("New.md"), "# new").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("New.md"))));
    std::fs::write(dir.path().join("Ideas.md"), "# changed").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("Ideas.md"))));
    std::fs::remove_file(dir.path().join("Links.md")).unwrap();
    assert!(
        saw(&seen, WatchEvent::Removed(vp("Links.md"))),
        "{:?}",
        seen.lock().unwrap()
    );
}

#[test]
fn vlt_04_external_rename_reports_new_path_and_old_path_gone() {
    let dir = copy_fixture("ambiguous-names");
    let (_w, seen) = watch(dir.path());
    std::fs::rename(dir.path().join("Links.md"), dir.path().join("Renamed.md")).unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("Renamed.md"))));
    // Some backends only report the new name; the session reconciles the
    // parent folder to notice the old one is gone (liber-session Task 11).
}

#[test]
fn vlt_05_hidden_and_excluded_changes_are_dropped() {
    let dir = copy_fixture("ambiguous-names");
    std::fs::create_dir(dir.path().join(".liber")).unwrap();
    std::fs::write(
        dir.path().join(".liber/vault.json"),
        r#"{"exclude":["Archive/**"]}"#,
    )
    .unwrap();
    let (_w, seen) = watch(dir.path());
    std::fs::write(dir.path().join(".liber/layout.json"), "{}").unwrap();
    std::fs::write(dir.path().join("Archive/Old/x.md"), "x").unwrap();
    std::fs::write(dir.path().join("visible.md"), "v").unwrap();
    assert!(saw(&seen, WatchEvent::Changed(vp("visible.md"))));
    let all = seen.lock().unwrap().clone();
    assert!(
        all.iter()
            .all(|e| !format!("{e:?}").contains(".liber") && !format!("{e:?}").contains("Archive")),
        "{all:?}"
    );
}

#[test]
fn review_focus_burst_of_changes_is_delivered_without_loss() {
    let dir = copy_fixture("ambiguous-names");
    let (_w, seen) = watch(dir.path());
    for i in 0..200 {
        std::fs::write(dir.path().join(format!("burst-{i}.md")), format!("# {i}")).unwrap();
    }
    let all_seen = || {
        let s = seen.lock().unwrap();
        s.contains(&WatchEvent::Overflow)
            || (0..200).all(|i| s.contains(&WatchEvent::Changed(vp(&format!("burst-{i}.md")))))
    };
    assert!(
        wait_until(Duration::from_secs(10), all_seen),
        "every file reported, or Overflow"
    );
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cargo test -p liber-vault --test watch`

Expected: FAIL: compile errors `unresolved import liber_vault::WatchEvent`, `no method named watch`

- [ ] **Step 4: Implement**

`crates/liber-vault/src/watch.rs` (create or replace the whole file):

```rust
use crate::error::{Result, VaultError};
use crate::is_hidden_name;
use crate::path::VaultPath;
use crate::vault::Vault;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Debounce window for file-system events (arch §4.1).
pub const DEBOUNCE: Duration = Duration::from_millis(200);

/// A change observed on disk (VLT-04), classified by what exists on disk *now*.
/// Backends disagree on event kinds (macOS FSEvents merges created/removed
/// flags), so the watcher only says "this path changed" or "this path is gone";
/// the session decides created-vs-modified and detects renames by content hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// The path exists and may be new or modified.
    Changed(VaultPath),
    /// The path no longer exists.
    Removed(VaultPath),
    /// Events may have been lost: rescan everything.
    Overflow,
}

/// Active watch; dropping it stops watching.
pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl std::fmt::Debug for Watcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Watcher")
    }
}

impl Vault {
    /// Watches the vault recursively. `callback` receives one batch per debounce
    /// tick (sorted, de-duplicated); hidden, excluded and outside paths are dropped.
    pub fn watch<F>(&self, callback: F) -> Result<Watcher>
    where
        F: Fn(Vec<WatchEvent>) + Send + 'static,
    {
        let filter = PathFilter {
            root: self.root.clone(),
            excludes: self.excludes.clone(),
        };
        let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            let batch = filter.translate(result);
            if !batch.is_empty() {
                callback(batch);
            }
        })
        .map_err(|e| VaultError::Watch(e.to_string()))?;
        debouncer
            .watcher()
            .watch(&self.root, RecursiveMode::Recursive)
            .map_err(|e| VaultError::Watch(e.to_string()))?;
        Ok(Watcher {
            _debouncer: debouncer,
        })
    }
}

struct PathFilter {
    root: PathBuf,
    excludes: globset::GlobSet,
}

impl PathFilter {
    fn translate(&self, result: DebounceEventResult) -> Vec<WatchEvent> {
        let events = match result {
            Ok(events) => events,
            Err(_) => return vec![WatchEvent::Overflow],
        };
        let mut out: Vec<WatchEvent> = events
            .iter()
            .filter_map(|ev| {
                let path = self.visible(&ev.path)?;
                Some(if ev.path.exists() {
                    WatchEvent::Changed(path)
                } else {
                    WatchEvent::Removed(path)
                })
            })
            .collect();
        out.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
        out.dedup();
        out
    }

    /// Vault path for `p` unless it is outside, the root, hidden or excluded.
    fn visible(&self, p: &Path) -> Option<VaultPath> {
        let canonical_parent = p.parent().and_then(|d| dunce::canonicalize(d).ok());
        let p = match (canonical_parent, p.file_name()) {
            (Some(dir), Some(name)) => dir.join(name),
            _ => p.to_path_buf(),
        };
        let vp = VaultPath::from_fs_path(&self.root, &p).ok()?;
        if vp.is_root()
            || vp.as_str().split('/').any(is_hidden_name)
            || self.excludes.is_match(vp.as_str())
        {
            return None;
        }
        Some(vp)
    }
}
```

`crates/liber-vault/src/lib.rs` (create or replace the whole file):

```rust
//! Vault filesystem model: scanning, watching, atomic writes, trash.
//! Every path crossing this crate's boundary is vault-relative ([`VaultPath`]).

mod config;
mod error;
mod fsops;
mod hash;
mod path;
mod scan;
mod vault;
mod watch;

pub use config::AttachmentPolicy;
pub use error::{Result, VaultError};
pub use fsops::TMP_MARKER;
pub use hash::Hash;
pub use path::VaultPath;
pub use scan::{Entry, EntryKind, Scan};
pub use vault::Vault;
pub use watch::{DEBOUNCE, WatchEvent, Watcher};

/// VLT-05: dot-entries (`.obsidian`, `.git`, `.liber`, …) are ignored everywhere.
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::is_hidden_name;

    #[test]
    fn vlt_05_dot_folders_are_hidden() {
        for name in [".obsidian", ".git", ".liber", ".trash", ".", ".."] {
            assert!(is_hidden_name(name), "{name} should be hidden");
        }
    }

    #[test]
    fn vlt_05_regular_names_are_visible() {
        for name in ["Projects", "not.hidden", "notes.md", ""] {
            assert!(!is_hidden_name(name), "{name:?} should be visible");
        }
    }
}
```

- [ ] **Step 5: Run the tests three times (watchers are timing-sensitive; all three runs must pass), then clippy and rustfmt**

Run: `for i in 1 2 3; do cargo test -p liber-vault --test watch || exit 1; done && cargo test -p liber-vault && cargo clippy -p liber-vault --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 4 watch tests in each run; whole crate green

- [ ] **Step 6: Commit**

```bash
git add Cargo.lock crates/liber-vault
git commit -m "feat(vault): debounced file watcher classified by disk state (VLT-04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: liber-markdown: types, `[[…]]` inner parser and frontmatter (yaml-rust2 with byte positions)

**Files:**
- Modify: `crates/liber-markdown/Cargo.toml`, `crates/liber-markdown/src/lib.rs`
- Create: `crates/liber-markdown/src/types.rs`, `src/wikilink.rs`, `src/frontmatter.rs`, `src/page.rs`
- Test: `crates/liber-markdown/tests/frontmatter_api.rs` (+ unit tests in `wikilink.rs`, `frontmatter.rs`)

**Interfaces:**
- Consumes: M0 `extract_title(source: &str, file_stem: &str) -> String` (unchanged).
- Produces:
  - `pub struct PageMeta { title: String, subtitle: Option<String>, cover: Option<String>, cover_y: Option<u8>, tags: Vec<Tag>, links: Vec<LinkRef> /* sorted by range.start */, excerpt: String, has_image: bool, has_audio: bool, frontmatter_error: Option<String> }` (all fields `pub`, `Default`).
  - `pub struct Tag { pub text: String, pub key: String }` with `Tag::new(text: &str)` (key = lowercase).
  - `pub enum LinkKind { Wiki, Embed, Markdown, MarkdownImage, FrontmatterRelated, FrontmatterCover }` with `as_str(self) -> &'static str` (`"wiki"`, `"embed"`, `"markdown"`, `"markdown_image"`, `"related"`, `"cover"`), `parse(&str) -> Option<LinkKind>`, `is_wiki_style(self) -> bool` (Wiki, Embed, FrontmatterRelated).
  - `pub struct LinkRef { kind, target: String /* decoded, no #heading/|alias */, heading: Option<String>, alias: Option<String>, range: Range<usize> /* bytes of the target as written */, encoded: bool, angle: bool, label: Option<String>, directed: bool }` (fields `pub`; `pub(crate) fn new(kind, target, range)`).
  - `pub fn parse_page(source: &str, file_stem: &str) -> PageMeta` — this task: title + frontmatter; Task 6 adds the body.
  - crate-internal: `wikilink::parse_inner(&str) -> Option<WikiParts>`, `frontmatter::split(&str) -> Option<(Range<usize>, usize)>`, `frontmatter::parse(&str, Range<usize>) -> Frontmatter`.

- [ ] **Step 1: Manifest (all markdown dependencies at once)**

`crates/liber-markdown/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-markdown"
description = "Metadata extraction from Markdown pages (title, frontmatter, tags, links)."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
percent-encoding.workspace = true
pulldown-cmark.workspace = true
unicode-normalization.workspace = true
yaml-rust2.workspace = true

[lints]
workspace = true
```

- [ ] **Step 2: Write the failing integration test**

`crates/liber-markdown/tests/frontmatter_api.rs` (create or replace the whole file):

```rust
use liber_markdown::{LinkKind, parse_page};

#[test]
fn pg_02_03_04_frontmatter_through_parse_page() {
    let src = "---\nsubtitle: Hero\ncover: assets/c.png\ncover-y: 40\ntags: [a, b]\nrelated:\n  - \"[[Sparda]]\"\n---\n# Rex\n";
    let m = parse_page(src, "rex-draft");
    assert_eq!(m.title, "Rex");
    assert_eq!(m.subtitle.as_deref(), Some("Hero"));
    assert_eq!(m.cover.as_deref(), Some("assets/c.png"));
    assert_eq!(m.cover_y, Some(40));
    assert_eq!(
        m.tags.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(
        m.links.iter().map(|l| l.kind).collect::<Vec<_>>(),
        vec![LinkKind::FrontmatterCover, LinkKind::FrontmatterRelated]
    );
    assert_eq!(&src[m.links[1].range.clone()], "Sparda");
    assert!(
        parse_page("---\ntags: [x\n---\n", "bad")
            .frontmatter_error
            .is_some()
    );
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cargo test -p liber-markdown --test frontmatter_api`

Expected: FAIL: compile errors `unresolved imports liber_markdown::parse_page, liber_markdown::LinkKind`

- [ ] **Step 4: Implement. yaml-rust2's `Marker::index()` is a **character** index (not bytes, despite its docs) and points at the opening quote of quoted scalars — `frontmatter.rs` maps both**

`crates/liber-markdown/src/types.rs` (create or replace the whole file):

```rust
use std::ops::Range;

/// Everything the index needs from one Markdown page.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageMeta {
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    pub cover_y: Option<u8>,
    pub tags: Vec<Tag>,
    /// Sorted by `range.start`.
    pub links: Vec<LinkRef>,
    pub excerpt: String,
    pub has_image: bool,
    pub has_audio: bool,
    pub frontmatter_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    /// As written, without `#`.
    pub text: String,
    /// Lowercase matching key.
    pub key: String,
}

impl Tag {
    pub fn new(text: &str) -> Tag {
        Tag {
            text: text.to_string(),
            key: text.to_lowercase(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LinkKind {
    Wiki,
    Embed,
    Markdown,
    MarkdownImage,
    FrontmatterRelated,
    FrontmatterCover,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Wiki => "wiki",
            LinkKind::Embed => "embed",
            LinkKind::Markdown => "markdown",
            LinkKind::MarkdownImage => "markdown_image",
            LinkKind::FrontmatterRelated => "related",
            LinkKind::FrontmatterCover => "cover",
        }
    }

    pub fn parse(s: &str) -> Option<LinkKind> {
        Some(match s {
            "wiki" => LinkKind::Wiki,
            "embed" => LinkKind::Embed,
            "markdown" => LinkKind::Markdown,
            "markdown_image" => LinkKind::MarkdownImage,
            "related" => LinkKind::FrontmatterRelated,
            "cover" => LinkKind::FrontmatterCover,
            _ => return None,
        })
    }

    /// Wiki-style kinds resolve by name (Obsidian rules); the others by path.
    pub fn is_wiki_style(self) -> bool {
        matches!(
            self,
            LinkKind::Wiki | LinkKind::Embed | LinkKind::FrontmatterRelated
        )
    }
}

/// One reference from a page to a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRef {
    pub kind: LinkKind,
    /// Decoded target without `#heading` or `|alias`.
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    /// Byte range of the target text in the source, as written.
    pub range: Range<usize>,
    /// The target was %-encoded in the source (Markdown links).
    pub encoded: bool,
    /// Markdown destination written as `<…>`.
    pub angle: bool,
    /// `related:` object form.
    pub label: Option<String>,
    pub directed: bool,
}

impl LinkRef {
    pub(crate) fn new(kind: LinkKind, target: &str, range: Range<usize>) -> LinkRef {
        LinkRef {
            kind,
            target: target.to_string(),
            heading: None,
            alias: None,
            range,
            encoded: false,
            angle: false,
            label: None,
            directed: false,
        }
    }
}
```

`crates/liber-markdown/src/wikilink.rs` (create or replace the whole file):

```rust
use std::ops::Range;

/// Parsed inside of `[[…]]`, with the target's byte range relative to `inner`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct WikiParts<'a> {
    pub target: &'a str,
    pub target_range: Range<usize>,
    pub heading: Option<&'a str>,
    pub alias: Option<&'a str>,
}

/// Splits `target#heading|alias`. Returns `None` for an empty target
/// (e.g. `[[#Heading]]`, a link to the same page).
pub(crate) fn parse_inner(inner: &str) -> Option<WikiParts<'_>> {
    let (target_part, alias) = match inner.find('|') {
        Some(i) => (&inner[..i], Some(&inner[i + 1..])),
        None => (inner, None),
    };
    let (target_raw, heading) = match target_part.find('#') {
        Some(i) => (&target_part[..i], Some(&target_part[i + 1..])),
        None => (target_part, None),
    };
    let lead = target_raw.len() - target_raw.trim_start().len();
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    Some(WikiParts {
        target,
        target_range: lead..lead + target.len(),
        heading: heading.filter(|h| !h.is_empty()),
        alias: alias.filter(|a| !a.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_05_parse_inner_forms() {
        let p = parse_inner("Sparda#Coat|the knight").unwrap();
        assert_eq!(
            (p.target, p.heading, p.alias),
            ("Sparda", Some("Coat"), Some("the knight"))
        );
        assert_eq!(p.target_range, 0..6);
        let p = parse_inner("  spaced  ").unwrap();
        assert_eq!(p.target, "spaced");
        assert_eq!(p.target_range, 2..8);
        assert!(parse_inner("#Heading").is_none());
        assert!(parse_inner("").is_none());
        let p = parse_inner("a|").unwrap();
        assert_eq!(p.alias, None);
    }
}
```

`crates/liber-markdown/src/frontmatter.rs` (create or replace the whole file):

```rust
use crate::types::{LinkKind, LinkRef, Tag};
use crate::wikilink;
use std::ops::Range;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// App-owned frontmatter values (arch §3.3). Unknown keys are ignored.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Frontmatter {
    pub subtitle: Option<String>,
    pub cover_y: Option<u8>,
    pub tags: Vec<Tag>,
    pub links: Vec<LinkRef>,
    pub cover: Option<String>,
    pub error: Option<String>,
}

/// Byte range of the YAML between the opening `---` line and the closing
/// `---`/`...` line, and the byte offset where the body starts.
pub(crate) fn split(src: &str) -> Option<(Range<usize>, usize)> {
    let first_len = if src.starts_with("---\n") {
        4
    } else if src.starts_with("---\r\n") {
        5
    } else {
        return None;
    };
    let mut pos = first_len;
    while pos <= src.len() {
        let line_end = src[pos..].find('\n').map(|i| pos + i).unwrap_or(src.len());
        let line = src[pos..line_end].trim_end_matches('\r');
        if line == "---" || line == "..." {
            let body = (line_end + 1).min(src.len());
            return Some((first_len..pos, body));
        }
        if line_end == src.len() {
            return None;
        }
        pos = line_end + 1;
    }
    None
}

#[derive(Debug)]
enum Node {
    Scalar { value: String, start: usize },
    Seq(Vec<Node>),
    Map(Vec<(Node, Node)>),
}

impl Node {
    fn as_scalar(&self) -> Option<&str> {
        match self {
            Node::Scalar { value, .. } => Some(value),
            _ => None,
        }
    }
}

/// Builds a tiny document tree with byte offsets (yaml-rust2 markers are
/// *character* indices, so they are mapped to bytes here).
struct Builder<'a> {
    yaml: &'a str,
    char_to_byte: Vec<usize>,
    stack: Vec<Node>,
    keys: Vec<Option<Node>>,
    root: Option<Node>,
}

impl<'a> Builder<'a> {
    fn new(yaml: &'a str) -> Self {
        let mut char_to_byte: Vec<usize> = yaml.char_indices().map(|(b, _)| b).collect();
        char_to_byte.push(yaml.len());
        Builder {
            yaml,
            char_to_byte,
            stack: Vec::new(),
            keys: Vec::new(),
            root: None,
        }
    }

    fn byte(&self, mark: Marker) -> usize {
        *self
            .char_to_byte
            .get(mark.index())
            .unwrap_or(&self.yaml.len())
    }

    fn push_value(&mut self, node: Node) {
        match self.stack.last_mut() {
            None => self.root = Some(node),
            Some(Node::Seq(items)) => items.push(node),
            Some(Node::Map(entries)) => {
                let slot = self.keys.last_mut().expect("map has a key slot");
                match slot.take() {
                    None => *slot = Some(node),
                    Some(key) => entries.push((key, node)),
                }
            }
            Some(Node::Scalar { .. }) => unreachable!("scalars are never on the stack"),
        }
    }
}

impl MarkedEventReceiver for Builder<'_> {
    fn on_event(&mut self, ev: Event, mark: Marker) {
        match ev {
            Event::Scalar(value, style, ..) => {
                let start = self.byte(mark)
                    + usize::from(matches!(
                        style,
                        TScalarStyle::SingleQuoted | TScalarStyle::DoubleQuoted
                    ));
                self.push_value(Node::Scalar { value, start });
            }
            Event::SequenceStart(..) => self.stack.push(Node::Seq(Vec::new())),
            Event::MappingStart(..) => {
                self.stack.push(Node::Map(Vec::new()));
                self.keys.push(None);
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let node = self.stack.pop().expect("balanced events");
                if matches!(node, Node::Map(_)) {
                    self.keys.pop();
                }
                self.push_value(node);
            }
            _ => {}
        }
    }
}

/// Parses the frontmatter at `yaml` (absolute byte range in `src`).
pub(crate) fn parse(src: &str, yaml: Range<usize>) -> Frontmatter {
    let text = &src[yaml.clone()];
    let mut builder = Builder::new(text);
    if let Err(e) = Parser::new_from_str(text).load(&mut builder, false) {
        return Frontmatter {
            error: Some(e.to_string()),
            ..Frontmatter::default()
        };
    }
    let mut fm = Frontmatter::default();
    let Some(Node::Map(entries)) = builder.root else {
        return fm;
    };
    // Absolute byte range of a scalar's value, if its raw text equals the value.
    let locate = |node: &Node| -> Option<(String, Range<usize>)> {
        let Node::Scalar { value, start, .. } = node else {
            return None;
        };
        let abs = yaml.start + start;
        let line_end = src[abs..].find('\n').map(|i| abs + i).unwrap_or(src.len());
        let found = src[abs..line_end].find(value.as_str())?;
        Some((value.clone(), abs + found..abs + found + value.len()))
    };
    for (key, value) in &entries {
        match key.as_scalar() {
            Some("subtitle") => fm.subtitle = value.as_scalar().map(str::to_string),
            Some("cover") => {
                if let Some((v, range)) = locate(value) {
                    fm.cover = Some(v.clone());
                    fm.links
                        .push(LinkRef::new(LinkKind::FrontmatterCover, &v, range));
                } else {
                    fm.cover = value.as_scalar().map(str::to_string);
                }
            }
            Some("cover-y") => {
                fm.cover_y = value
                    .as_scalar()
                    .and_then(|s| s.trim().parse::<f64>().ok())
                    .map(|n| n.clamp(0.0, 100.0).round() as u8);
            }
            Some("tags") => {
                let raw: Vec<String> = match value {
                    Node::Seq(items) => items
                        .iter()
                        .filter_map(|n| n.as_scalar())
                        .map(str::to_string)
                        .collect(),
                    Node::Scalar { value, .. } => value
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .map(str::to_string)
                        .collect(),
                    Node::Map(_) => Vec::new(),
                };
                for t in raw {
                    let t = t.trim().trim_start_matches('#');
                    if !t.is_empty() {
                        fm.tags.push(Tag::new(t));
                    }
                }
            }
            Some("related") => {
                if let Node::Seq(items) = value {
                    for item in items {
                        if let Some(link) = related_link(item, &locate) {
                            fm.links.push(link);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    fm
}

/// Finds a scalar's value and its absolute byte range in the source.
type Locate<'a> = dyn Fn(&Node) -> Option<(String, Range<usize>)> + 'a;

fn related_link(item: &Node, locate: &Locate<'_>) -> Option<LinkRef> {
    let (link_node, label, directed) = match item {
        Node::Scalar { .. } => (item, None, false),
        Node::Map(entries) => {
            let get = |k: &str| {
                entries
                    .iter()
                    .find(|(key, _)| key.as_scalar() == Some(k))
                    .map(|(_, v)| v)
            };
            (
                get("link")?,
                get("label").and_then(|n| n.as_scalar()).map(str::to_string),
                get("directed").and_then(|n| n.as_scalar()) == Some("true"),
            )
        }
        Node::Seq(_) => return None,
    };
    let (value, range) = locate(link_node)?;
    let inner_start = value.find("[[")? + 2;
    let inner_end = inner_start + value[inner_start..].find("]]")?;
    let parts = wikilink::parse_inner(&value[inner_start..inner_end])?;
    let abs = range.start + inner_start + parts.target_range.start;
    let mut link = LinkRef::new(
        LinkKind::FrontmatterRelated,
        parts.target,
        abs..abs + parts.target.len(),
    );
    link.heading = parts.heading.map(str::to_string);
    link.alias = parts.alias.map(str::to_string);
    link.label = label;
    link.directed = directed;
    Some(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm(src: &str) -> Frontmatter {
        let (yaml, _) = split(src).expect("has frontmatter");
        parse(src, yaml)
    }

    #[test]
    fn split_finds_yaml_and_body() {
        let src = "---\na: 1\n---\n# Body\n";
        let (yaml, body) = split(src).unwrap();
        assert_eq!(&src[yaml], "a: 1\n");
        assert_eq!(&src[body..], "# Body\n");
        assert!(split("# no frontmatter\n---\n").is_none());
        assert!(split("---\nnever closed\n").is_none());
        let crlf = "---\r\na: 1\r\n---\r\nbody";
        assert_eq!(&crlf[split(crlf).unwrap().1..], "body");
        assert_eq!(split("---\n---\n").unwrap().0, 4..4);
    }

    #[test]
    fn pg_02_03_subtitle_cover_and_cover_y() {
        let src =
            "---\nsubtitle: Hero redesign · v3\ncover: 'assets/rex cover.png'\ncover-y: 140\n---\n";
        let f = fm(src);
        assert_eq!(f.subtitle.as_deref(), Some("Hero redesign · v3"));
        assert_eq!(f.cover.as_deref(), Some("assets/rex cover.png"));
        assert_eq!(f.cover_y, Some(100));
        let cover = &f.links[0];
        assert_eq!(cover.kind, LinkKind::FrontmatterCover);
        assert_eq!(&src[cover.range.clone()], "assets/rex cover.png");
        assert_eq!(fm("---\ncover-y: abc\n---\n").cover_y, None);
    }

    #[test]
    fn pg_04_tags_list_and_string_forms() {
        let keys = |s: &str| fm(s).tags.into_iter().map(|t| t.text).collect::<Vec<_>>();
        assert_eq!(
            keys("---\ntags: [Character, '#index']\n---\n"),
            vec!["Character", "index"]
        );
        assert_eq!(keys("---\ntags:\n  - a\n  - b/c\n---\n"), vec!["a", "b/c"]);
        assert_eq!(
            keys("---\ntags: game, art  x\n---\n"),
            vec!["game", "art", "x"]
        );
        assert_eq!(fm("---\ntags: [Character]\n---\n").tags[0].key, "character");
    }

    #[test]
    fn gv_22_related_string_and_object_forms_with_target_ranges() {
        let src = "---\nsubtitle: «é»\nrelated:\n  - \"[[Spárda]]\"\n  - { link: \"[[Game 1#Plan|the game]]\", label: playable version, directed: true }\n  - link: '[[ Z ]]'\n  - not a link\n---\n";
        let f = fm(src);
        let targets: Vec<_> = f
            .links
            .iter()
            .map(|l| (&src[l.range.clone()], l.target.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![("Spárda", "Spárda"), ("Game 1", "Game 1"), ("Z", "Z")]
        );
        let game = &f.links[1];
        assert_eq!(game.heading.as_deref(), Some("Plan"));
        assert_eq!(game.alias.as_deref(), Some("the game"));
        assert_eq!(game.label.as_deref(), Some("playable version"));
        assert!(game.directed);
        assert!(!f.links[0].directed);
    }

    #[test]
    fn malformed_yaml_sets_error_and_no_values() {
        let f = fm("---\ntags: [unclosed\nsubtitle: x\n---\n");
        assert!(f.error.is_some());
        assert_eq!(f.subtitle, None);
        assert!(f.tags.is_empty());
    }

    #[test]
    fn non_mapping_frontmatter_is_ignored() {
        assert_eq!(fm("---\n- just\n- a list\n---\n"), Frontmatter::default());
    }
}
```

`crates/liber-markdown/src/page.rs` (create or replace the whole file):

```rust
use crate::types::PageMeta;
use crate::{frontmatter, title};

/// Parses one page: title (PG-01) and app-owned frontmatter (PG-02, PG-03,
/// PG-04 tags, `related`/`cover` links). Body links and tags arrive in Task 6.
pub fn parse_page(source: &str, file_stem: &str) -> PageMeta {
    let mut meta = PageMeta {
        title: title::extract_title(source, file_stem),
        ..PageMeta::default()
    };
    if let Some((yaml, _)) = frontmatter::split(source) {
        let fm = frontmatter::parse(source, yaml);
        meta.subtitle = fm.subtitle;
        meta.cover = fm.cover;
        meta.cover_y = fm.cover_y;
        meta.tags = fm.tags;
        meta.links = fm.links;
        meta.frontmatter_error = fm.error;
    }
    meta
}
```

`crates/liber-markdown/src/lib.rs` (create or replace the whole file):

```rust
//! Metadata extraction from Markdown pages (title, frontmatter, tags, links).
//! Pure functions, no I/O.

mod frontmatter;
mod page;
mod title;
mod types;
mod wikilink;

pub use page::parse_page;
pub use title::extract_title;
pub use types::{LinkKind, LinkRef, PageMeta, Tag};
```

- [ ] **Step 5: Run the tests, clippy and rustfmt**

Run: `cargo test -p liber-markdown && cargo clippy -p liber-markdown --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 8 title + 1 wikilink + 6 frontmatter unit tests, 1 integration test

- [ ] **Step 6: Commit**

```bash
git add Cargo.lock crates/liber-markdown
git commit -m "feat(markdown): page types and frontmatter extraction with byte ranges (PG-02, PG-03, PG-04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: liber-markdown: body links, tags, excerpt and the full `parse_page`

**Files:**
- Modify: `crates/liber-markdown/src/wikilink.rs` (adds `find_all`), `src/page.rs` (full version), `src/lib.rs`
- Create: `crates/liber-markdown/src/body.rs`
- Test: `crates/liber-markdown/tests/fixture_pages.rs` (+ unit tests in `body.rs`, `page.rs`, `wikilink.rs`)

**Interfaces:**
- Consumes: Task 5 types, `wikilink::parse_inner`, `frontmatter`; fixture files from Task 2.
- Produces: final `parse_page(source, file_stem) -> PageMeta` — frontmatter + body links (wikilinks, embeds, Markdown links/images; code/HTML/comments ignored), tags (frontmatter first, then body, de-duplicated by key), excerpt (≤ 200 chars after the first H1), `has_image`/`has_audio`. Crate-internal: `wikilink::find_all(&str) -> Vec<Occurrence { inner, embed, whole }>`.

- [ ] **Step 1: Write the failing integration test (reads the committed fixtures)**

`crates/liber-markdown/tests/fixture_pages.rs` (create or replace the whole file):

```rust
use liber_markdown::{LinkKind, parse_page};
use std::path::Path;

fn fixture(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/vaults")
        .join(rel);
    std::fs::read_to_string(path).unwrap()
}

#[test]
fn pg_04_05_rex_draft_fixture() {
    let src = fixture("obsidian-basic/Character Design/rex-draft.md");
    let m = parse_page(&src, "rex-draft");
    let links: Vec<_> = m
        .links
        .iter()
        .map(|l| (l.kind, l.target.as_str()))
        .collect();
    assert_eq!(
        links,
        vec![
            (LinkKind::FrontmatterCover, "assets/rex-cover.png"),
            (LinkKind::FrontmatterRelated, "Sparda"),
            (LinkKind::FrontmatterRelated, "Game 1"),
            (LinkKind::Embed, "rex-turnaround.png"),
            (LinkKind::Embed, "voice-reference.mp3"),
            (LinkKind::Markdown, "DMC/Sparda.md"),
            (LinkKind::Markdown, "/Game Design/Game 1.md"),
            (LinkKind::Markdown, "../Game Design/Game 1.md"),
        ]
    );
    assert_eq!(
        m.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        vec!["character", "redesign"]
    );
    assert!(m.has_image && m.has_audio);
    assert!(
        m.excerpt.starts_with("Teen agent who builds machines."),
        "{}",
        m.excerpt
    );
}

#[test]
fn pg_05_edge_case_code_fixture_has_one_real_link() {
    let src = fixture("edge-cases/code.md");
    let m = parse_page(&src, "code");
    assert_eq!(
        m.links
            .iter()
            .map(|l| l.target.as_str())
            .collect::<Vec<_>>(),
        vec!["target"]
    );
    assert_eq!(
        m.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        vec!["real-tag"]
    );
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p liber-markdown --test fixture_pages`

Expected: FAIL: assertion failures — body links, tags and excerpt are still empty

- [ ] **Step 3: Implement. pulldown-cmark splits text at `[`, so `[[x]]` arrives as several adjacent Text events: `body.rs` merges touching ranges before scanning**

`crates/liber-markdown/src/wikilink.rs` (create or replace the whole file):

```rust
use std::ops::Range;

/// Parsed inside of `[[…]]`, with the target's byte range relative to `inner`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct WikiParts<'a> {
    pub target: &'a str,
    pub target_range: Range<usize>,
    pub heading: Option<&'a str>,
    pub alias: Option<&'a str>,
}

/// Splits `target#heading|alias`. Returns `None` for an empty target
/// (e.g. `[[#Heading]]`, a link to the same page).
pub(crate) fn parse_inner(inner: &str) -> Option<WikiParts<'_>> {
    let (target_part, alias) = match inner.find('|') {
        Some(i) => (&inner[..i], Some(&inner[i + 1..])),
        None => (inner, None),
    };
    let (target_raw, heading) = match target_part.find('#') {
        Some(i) => (&target_part[..i], Some(&target_part[i + 1..])),
        None => (target_part, None),
    };
    let lead = target_raw.len() - target_raw.trim_start().len();
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    Some(WikiParts {
        target,
        target_range: lead..lead + target.len(),
        heading: heading.filter(|h| !h.is_empty()),
        alias: alias.filter(|a| !a.is_empty()),
    })
}

/// A `[[…]]` occurrence found in a text slice: byte range of the inner text
/// (between the brackets) and whether it is an embed (`![[…]]`).
pub(crate) struct Occurrence {
    pub inner: Range<usize>,
    pub embed: bool,
    pub whole: Range<usize>,
}

/// Finds `[[…]]` in `text` (single line, no nested `[[`, not escaped `\[[`).
pub(crate) fn find_all(text: &str) -> Vec<Occurrence> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(off) = text[i..].find("[[") {
        let start = i + off;
        if start > 0 && bytes[start - 1] == b'\\' {
            i = start + 2;
            continue;
        }
        let inner_start = start + 2;
        let Some(close) = text[inner_start..].find("]]") else {
            break;
        };
        let inner_end = inner_start + close;
        let inner = &text[inner_start..inner_end];
        if inner.contains('\n') || inner.contains("[[") {
            i = start + 2;
            continue;
        }
        let embed = start > 0 && bytes[start - 1] == b'!';
        let whole_start = if embed { start - 1 } else { start };
        out.push(Occurrence {
            inner: inner_start..inner_end,
            embed,
            whole: whole_start..inner_end + 2,
        });
        i = inner_end + 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_05_parse_inner_forms() {
        let p = parse_inner("Sparda#Coat|the knight").unwrap();
        assert_eq!(
            (p.target, p.heading, p.alias),
            ("Sparda", Some("Coat"), Some("the knight"))
        );
        assert_eq!(p.target_range, 0..6);
        let p = parse_inner("  spaced  ").unwrap();
        assert_eq!(p.target, "spaced");
        assert_eq!(p.target_range, 2..8);
        assert!(parse_inner("#Heading").is_none());
        assert!(parse_inner("").is_none());
        let p = parse_inner("a|").unwrap();
        assert_eq!(p.alias, None);
    }

    #[test]
    fn pg_05_find_all_handles_embeds_escapes_and_newlines() {
        let t = "a [[x]] ![[img.png]] \\[[no]] [[multi\nline]] [[y|z]]";
        let found: Vec<_> = find_all(t)
            .iter()
            .map(|o| (&t[o.inner.clone()], o.embed))
            .collect();
        assert_eq!(found, vec![("x", false), ("img.png", true), ("y|z", false)]);
    }
}
```

`crates/liber-markdown/src/body.rs` (create or replace the whole file):

````rust
use crate::types::{LinkKind, LinkRef, Tag};
use crate::wikilink;
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag as MdTag, TagEnd};
use std::ops::Range;

const EXCERPT_CHARS: usize = 200;

#[derive(Debug, Default)]
pub(crate) struct Body {
    pub links: Vec<LinkRef>,
    pub tags: Vec<Tag>,
    pub excerpt: String,
}

/// Extracts links, tags and the excerpt from the Markdown body. Code (fenced,
/// indented, inline), HTML blocks/inline HTML and comments are ignored.
pub(crate) fn extract(src: &str) -> Body {
    let options = Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH;
    let mut body = Body::default();
    let mut regions: Vec<Range<usize>> = Vec::new();
    let mut excerpt_regions: Vec<Range<usize>> = Vec::new();
    let mut in_code = 0usize;
    let mut in_meta = false;
    let mut in_heading = false;
    for (event, range) in Parser::new_ext(src, options).into_offset_iter() {
        match event {
            Event::Start(MdTag::MetadataBlock(_)) => in_meta = true,
            Event::End(TagEnd::MetadataBlock(_)) => in_meta = false,
            Event::Start(MdTag::CodeBlock(_)) => in_code += 1,
            Event::End(TagEnd::CodeBlock) => in_code = in_code.saturating_sub(1),
            Event::Start(MdTag::Heading { level, .. }) => {
                in_heading = true;
                if level == HeadingLevel::H1 {
                    excerpt_regions.clear();
                }
            }
            Event::End(TagEnd::Heading(_)) => in_heading = false,
            Event::Start(MdTag::Link {
                link_type,
                dest_url,
                ..
            }) => {
                if let Some(link) =
                    markdown_link(src, &range, link_type, &dest_url, LinkKind::Markdown)
                {
                    body.links.push(link);
                }
            }
            Event::Start(MdTag::Image {
                link_type,
                dest_url,
                ..
            }) => {
                if let Some(link) =
                    markdown_link(src, &range, link_type, &dest_url, LinkKind::MarkdownImage)
                {
                    body.links.push(link);
                }
            }
            Event::Text(_) if in_code == 0 && !in_meta => {
                push_merged(&mut regions, range.clone());
                if !in_heading {
                    push_merged(&mut excerpt_regions, range);
                }
            }
            Event::SoftBreak | Event::HardBreak if !in_heading => {
                push_merged(&mut excerpt_regions, range);
            }
            _ => {}
        }
    }
    for region in &regions {
        let text = &src[region.clone()];
        for occ in wikilink::find_all(text) {
            // An escaped `[[` has its backslash just before the text region.
            let open = region.start + occ.inner.start - 2;
            if !occ.embed && open > 0 && src.as_bytes()[open - 1] == b'\\' {
                continue;
            }
            let Some(parts) = wikilink::parse_inner(&text[occ.inner.clone()]) else {
                continue;
            };
            let start = region.start + occ.inner.start + parts.target_range.start;
            let kind = if occ.embed {
                LinkKind::Embed
            } else {
                LinkKind::Wiki
            };
            let mut link = LinkRef::new(kind, parts.target, start..start + parts.target.len());
            link.heading = parts.heading.map(str::to_string);
            link.alias = parts.alias.map(str::to_string);
            body.links.push(link);
        }
        tags_in(text, &mut body.tags);
    }
    body.links.sort_by_key(|l| l.range.start);
    body.excerpt = excerpt(src, &excerpt_regions);
    body
}

/// Appends `r`, merging it with the previous range when they touch.
/// (pulldown-cmark splits text at `[`, so `[[x]]` arrives in pieces.)
fn push_merged(regions: &mut Vec<Range<usize>>, r: Range<usize>) {
    match regions.last_mut() {
        Some(last) if last.end == r.start => last.end = r.end,
        _ => regions.push(r),
    }
}

fn has_scheme(dest: &str) -> bool {
    let Some(colon) = dest.find(':') else {
        return false;
    };
    let scheme = &dest[..colon];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.')
}

fn markdown_link(
    src: &str,
    range: &Range<usize>,
    link_type: LinkType,
    dest_url: &str,
    kind: LinkKind,
) -> Option<LinkRef> {
    if link_type != LinkType::Inline
        || dest_url.is_empty()
        || dest_url.starts_with('#')
        || has_scheme(dest_url)
    {
        return None;
    }
    let slice = &src[range.clone()];
    let mut search = 0;
    let (dest_start, angle) = loop {
        let pos = search + slice[search..].find("](")?;
        let after = pos + 2;
        if slice[after..].starts_with(dest_url) {
            break (after, false);
        }
        if slice[after..].starts_with('<') && slice[after + 1..].starts_with(dest_url) {
            break (after + 1, true);
        }
        search = after;
    };
    let (path_part, heading) = match dest_url.find('#') {
        Some(i) => (&dest_url[..i], Some(&dest_url[i + 1..])),
        None => (dest_url, None),
    };
    if path_part.is_empty() {
        return None;
    }
    let target = percent_decode_str(path_part)
        .decode_utf8()
        .ok()?
        .to_string();
    let abs = range.start + dest_start;
    let mut link = LinkRef::new(kind, &target, abs..abs + path_part.len());
    link.heading = heading.filter(|h| !h.is_empty()).map(str::to_string);
    link.encoded = path_part.contains('%');
    link.angle = angle;
    Some(link)
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

/// Obsidian tag rules: `#` at the start or after whitespace, then tag
/// characters with at least one non-digit; trailing `/` dropped.
fn tags_in(text: &str, out: &mut Vec<Tag>) {
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if c == '#' && prev.is_none_or(char::is_whitespace) {
            let rest = &text[i + 1..];
            let len: usize = rest
                .chars()
                .take_while(|&c| is_tag_char(c))
                .map(char::len_utf8)
                .sum();
            let tag = rest[..len].trim_end_matches('/');
            if !tag.is_empty()
                && tag.chars().any(|c| !c.is_ascii_digit())
                && !tag.starts_with('/')
                && !out.iter().any(|t| t.key == tag.to_lowercase())
            {
                out.push(Tag::new(tag));
            }
        }
        prev = Some(c);
    }
}

/// Plain text of non-heading paragraphs after the first H1, with wikilinks
/// shown as their alias or target and embeds dropped; ≤ 200 chars.
fn excerpt(src: &str, regions: &[Range<usize>]) -> String {
    let mut words = String::new();
    for region in regions {
        let text = &src[region.clone()];
        let mut rendered = String::new();
        let mut last = 0;
        for occ in wikilink::find_all(text) {
            rendered.push_str(&text[last..occ.whole.start]);
            if !occ.embed
                && let Some(p) = wikilink::parse_inner(&text[occ.inner.clone()])
            {
                rendered.push_str(p.alias.unwrap_or(p.target));
            }
            last = occ.whole.end;
        }
        rendered.push_str(&text[last..]);
        words.push(' ');
        words.push_str(&rendered.replace('\\', ""));
    }
    let collapsed = words.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= EXCERPT_CHARS {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(EXCERPT_CHARS).collect();
        format!("{}…", cut.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(src: &str) -> Vec<(LinkKind, String, String)> {
        extract(src)
            .links
            .into_iter()
            .map(|l| (l.kind, l.target, src[l.range].to_string()))
            .collect()
    }

    #[test]
    fn pg_05_wikilinks_and_embeds_with_target_ranges() {
        let src = "See [[Sparda#Coat|the knight]], ![[img.png]] and [[ spaced ]].";
        assert_eq!(
            targets(src),
            vec![
                (LinkKind::Wiki, "Sparda".into(), "Sparda".into()),
                (LinkKind::Embed, "img.png".into(), "img.png".into()),
                (LinkKind::Wiki, "spaced".into(), "spaced".into()),
            ]
        );
        let l = &extract(src).links[0];
        assert_eq!(
            (l.heading.as_deref(), l.alias.as_deref()),
            (Some("Coat"), Some("the knight"))
        );
    }

    #[test]
    fn pg_05_ignored_regions_yield_no_links_or_tags() {
        let src = "`[[a]]` `#t`\n\n```\n[[b]] #b\n```\n\n    [[c]] #c\n\n<div>\n[[d]] #d\n</div>\n\n<!-- [[e]] #e -->\n\n\\[[f]] [[ok]] #ok";
        let b = extract(src);
        assert_eq!(
            b.links
                .iter()
                .map(|l| l.target.as_str())
                .collect::<Vec<_>>(),
            vec!["ok"]
        );
        assert_eq!(
            b.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["ok"]
        );
    }

    #[test]
    fn pg_05_markdown_links_encoded_angle_rooted_and_skipped() {
        let src = "[a](DMC/Sparda.md#Palette) [b](</Game Design/Game 1.md>) [c](../Game%20Design/Game%201.md) \
                   ![i](img/x.png) [w](https://e.com) [m](mailto:a@b.c) [f](#local) [r][ref]\n\n[ref]: other.md\n";
        let links = extract(src).links;
        let got: Vec<_> = links
            .iter()
            .map(|l| {
                (
                    l.kind,
                    l.target.as_str(),
                    &src[l.range.clone()],
                    l.encoded,
                    l.angle,
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    LinkKind::Markdown,
                    "DMC/Sparda.md",
                    "DMC/Sparda.md",
                    false,
                    false
                ),
                (
                    LinkKind::Markdown,
                    "/Game Design/Game 1.md",
                    "/Game Design/Game 1.md",
                    false,
                    true
                ),
                (
                    LinkKind::Markdown,
                    "../Game Design/Game 1.md",
                    "../Game%20Design/Game%201.md",
                    true,
                    false
                ),
                (
                    LinkKind::MarkdownImage,
                    "img/x.png",
                    "img/x.png",
                    false,
                    false
                ),
            ]
        );
        assert_eq!(links[0].heading.as_deref(), Some("Palette"));
    }

    #[test]
    fn pg_04_tag_rules() {
        let tags = |s: &str| {
            extract(s)
                .tags
                .into_iter()
                .map(|t| t.text)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            tags("#art/sketch #2024 #y2024 #trailing/ a#b (#paren) #ñandú"),
            vec!["art/sketch", "y2024", "trailing", "ñandú"]
        );
        assert_eq!(tags("# Heading\n\n#Tag and #tag"), vec!["Tag"]);
        assert_eq!(tags("## Section #inheading"), vec!["inheading"]);
        assert_eq!(tags("https://x.com/#anchor"), Vec::<String>::new());
    }

    #[test]
    fn excerpt_skips_title_renders_links_and_truncates() {
        let b = extract(
            "---\nsubtitle: s\n---\n# Title\n\nHello [[rex-draft|Rex]] and ![[x.png]] world.\n\n## Sub\n\nMore.",
        );
        assert_eq!(b.excerpt, "Hello Rex and world. More.");
        let long = format!("# T\n\n{}", "word ".repeat(100));
        let e = extract(&long).excerpt;
        assert!(e.ends_with('…') && e.chars().count() <= 201);
        assert_eq!(extract("Intro\n\n# Title\n\nAfter").excerpt, "After");
    }
}
````

`crates/liber-markdown/src/page.rs` (create or replace the whole file):

```rust
use crate::types::{LinkKind, PageMeta};
use crate::{body, frontmatter, title};

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];
const AUDIO_EXT: &[&str] = &["wav", "mp3", "m4a"];

/// Parses one page (PG-01, PG-02, PG-03, PG-04, PG-05 extraction).
pub fn parse_page(source: &str, file_stem: &str) -> PageMeta {
    let mut meta = PageMeta {
        title: title::extract_title(source, file_stem),
        ..PageMeta::default()
    };
    if let Some((yaml, _)) = frontmatter::split(source) {
        let fm = frontmatter::parse(source, yaml);
        meta.subtitle = fm.subtitle;
        meta.cover = fm.cover;
        meta.cover_y = fm.cover_y;
        meta.tags = fm.tags;
        meta.links = fm.links;
        meta.frontmatter_error = fm.error;
    }
    let body = body::extract(source);
    for tag in body.tags {
        if !meta.tags.iter().any(|t| t.key == tag.key) {
            meta.tags.push(tag);
        }
    }
    meta.links.extend(body.links);
    meta.links.sort_by_key(|l| l.range.start);
    meta.excerpt = body.excerpt;
    let ext_in = |target: &str, list: &[&str]| {
        target
            .rsplit_once('.')
            .is_some_and(|(_, ext)| list.contains(&ext.to_ascii_lowercase().as_str()))
    };
    let media = |l: &&crate::types::LinkRef| {
        matches!(
            l.kind,
            LinkKind::Embed | LinkKind::MarkdownImage | LinkKind::Markdown
        )
    };
    meta.has_image = meta
        .links
        .iter()
        .filter(media)
        .any(|l| ext_in(&l.target, IMAGE_EXT));
    meta.has_audio = meta
        .links
        .iter()
        .filter(media)
        .any(|l| ext_in(&l.target, AUDIO_EXT));
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_01_04_05_full_page() {
        let src = "---\nsubtitle: Hero\ncover: assets/c.png\ntags: [character]\nrelated:\n  - \"[[Sparda]]\"\n---\n# Generator Rex\n\nSee ![[turn.png]] and ![[voice.MP3]] and [[Game 1]] #Character #redesign\n";
        let m = parse_page(src, "rex-draft");
        assert_eq!(m.title, "Generator Rex");
        assert_eq!(m.subtitle.as_deref(), Some("Hero"));
        assert_eq!(
            m.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
            vec!["character", "redesign"]
        );
        let kinds: Vec<_> = m
            .links
            .iter()
            .map(|l| (l.kind, l.target.as_str()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (LinkKind::FrontmatterCover, "assets/c.png"),
                (LinkKind::FrontmatterRelated, "Sparda"),
                (LinkKind::Embed, "turn.png"),
                (LinkKind::Embed, "voice.MP3"),
                (LinkKind::Wiki, "Game 1"),
            ]
        );
        assert!(m.has_image && m.has_audio);
        assert!(
            m.links
                .windows(2)
                .all(|w| w[0].range.start < w[1].range.start)
        );
    }

    #[test]
    fn malformed_frontmatter_still_parses_body() {
        let m = parse_page("---\ntags: [unclosed\n---\n# T\n\n[[target]] #ok\n", "x");
        assert!(m.frontmatter_error.is_some());
        assert_eq!(m.links[0].target, "target");
        assert_eq!(m.tags[0].text, "ok");
    }

    #[test]
    fn review_focus_large_and_binary_like_pages_do_not_panic() {
        let big = format!("# Big\n\n{}", "[[a]] #t text ".repeat(200_000));
        let m = parse_page(&big, "big");
        assert_eq!(m.links.len(), 200_000);
        let junk: String = (0u32..5000).filter_map(char::from_u32).collect();
        let _ = parse_page(&junk, "junk");
        let _ = parse_page("---\n\u{0}\u{1}: [\n---\n\u{0}", "nul");
    }
}
```

`crates/liber-markdown/src/lib.rs` (create or replace the whole file):

```rust
//! Metadata extraction from Markdown pages (title, frontmatter, tags, links).
//! Pure functions, no I/O.

mod body;
mod frontmatter;
mod page;
mod title;
mod types;
mod wikilink;

pub use page::parse_page;
pub use title::extract_title;
pub use types::{LinkKind, LinkRef, PageMeta, Tag};
```

- [ ] **Step 4: Run the tests, clippy and rustfmt**

Run: `cargo test -p liber-markdown && cargo clippy -p liber-markdown --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 24 unit tests (incl. the 200,000-link and binary-junk Review Focus test) + 3 integration tests

- [ ] **Step 5: Commit**

```bash
git add crates/liber-markdown
git commit -m "feat(markdown): body links, tags and excerpt (PG-04, PG-05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: liber-markdown: `FileSet`, `resolve`, `shortest_unique_target`, `link_key`

**Files:**
- Modify: `crates/liber-markdown/src/lib.rs`
- Create: `crates/liber-markdown/src/resolve.rs`
- Test: `crates/liber-markdown/tests/resolve_api.rs` (+ unit tests in `resolve.rs`)

**Interfaces:**
- Consumes: Task 5 `LinkKind`.
- Produces:
  - `pub fn name_key(s: &str) -> String` (NFC + lowercase), `pub fn link_key(target_or_path: &str) -> String` (key of the base name without `.md`; shared by link targets and file paths), `pub fn normalize_join(base_dir: &str, rel: &str) -> Option<String>`.
  - `pub struct FileSet` (Clone, Default): `new(impl IntoIterator<Item = String>)`, `insert(String)`, `remove(&str)`, `contains(&str) -> bool`, `iter()`, `len()`, `is_empty()`.
  - `pub fn resolve(kind: LinkKind, target: &str, source: &str, files: &FileSet) -> Option<String>` (spec §4.4 + plan note 3).
  - `pub fn shortest_unique_target(target_path: &str, source: &str, files: &FileSet, kind: LinkKind, rooted: bool) -> String`.

- [ ] **Step 1: Write the failing integration test**

`crates/liber-markdown/tests/resolve_api.rs` (create or replace the whole file):

```rust
use liber_markdown::{FileSet, LinkKind, link_key, resolve, shortest_unique_target};

#[test]
fn pg_05_resolve_public_api() {
    let files = FileSet::new(["Ideas.md", "Projects/Ideas.md", "img/a.png"].map(String::from));
    assert_eq!(
        resolve(LinkKind::Wiki, "Ideas", "Projects/x.md", &files).as_deref(),
        Some("Projects/Ideas.md")
    );
    assert_eq!(
        resolve(LinkKind::Embed, "a.png", "x.md", &files).as_deref(),
        Some("img/a.png")
    );
    assert_eq!(
        resolve(LinkKind::Markdown, "../Ideas.md", "Projects/x.md", &files).as_deref(),
        Some("Ideas.md")
    );
    assert_eq!(
        shortest_unique_target("Projects/Ideas.md", "x.md", &files, LinkKind::Wiki, false),
        "Projects/Ideas"
    );
    assert_eq!(link_key("Projects/Ideas.md"), link_key("IDEAS"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p liber-markdown --test resolve_api`

Expected: FAIL: compile error `unresolved imports liber_markdown::{link_key, resolve, shortest_unique_target, FileSet}`

- [ ] **Step 3: Implement**

`crates/liber-markdown/src/resolve.rs` (create or replace the whole file):

```rust
use crate::types::LinkKind;
use std::collections::{BTreeSet, HashMap};
use unicode_normalization::UnicodeNormalization;

/// Matching key: Unicode NFC + lowercase (PG-05; paths themselves are kept as on disk).
pub fn name_key(s: &str) -> String {
    s.nfc().collect::<String>().to_lowercase()
}

/// Key shared by link targets and file paths: NFC-lowercased base name without
/// a trailing `.md`. A file can only satisfy links whose target has its key, so
/// creates/removes/renames only re-resolve links with these keys.
pub fn link_key(target_or_path: &str) -> String {
    let key = name_key(basename(target_or_path));
    match key.strip_suffix(".md") {
        Some(stem) if !stem.is_empty() => stem.to_string(),
        _ => key,
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn dir_of(path: &str) -> &str {
    path.rfind('/').map(|i| &path[..i]).unwrap_or("")
}

/// All vault file paths (pages and attachments), indexed for resolution.
#[derive(Debug, Clone, Default)]
pub struct FileSet {
    paths: BTreeSet<String>,
    by_key: HashMap<String, Vec<String>>,
    by_name: HashMap<String, Vec<String>>,
}

impl FileSet {
    pub fn new<I: IntoIterator<Item = String>>(paths: I) -> FileSet {
        let mut set = FileSet::default();
        for p in paths {
            set.insert(p);
        }
        set
    }

    pub fn insert(&mut self, path: String) {
        if self.paths.insert(path.clone()) {
            self.by_key
                .entry(name_key(&path))
                .or_default()
                .push(path.clone());
            self.by_name
                .entry(name_key(basename(&path)))
                .or_default()
                .push(path);
        }
    }

    pub fn remove(&mut self, path: &str) {
        if self.paths.remove(path) {
            for map_key in [name_key(path), name_key(basename(path))] {
                for map in [&mut self.by_key, &mut self.by_name] {
                    if let Some(v) = map.get_mut(&map_key) {
                        v.retain(|p| p != path);
                        if v.is_empty() {
                            map.remove(&map_key);
                        }
                    }
                }
            }
        }
    }

    pub fn contains(&self, path: &str) -> bool {
        self.paths.contains(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = &String> {
        self.paths.iter()
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    fn exact(&self, path: &str) -> Option<&String> {
        let hits = self.by_key.get(&name_key(path))?;
        hits.iter()
            .find(|p| p.as_str() == path)
            .or_else(|| hits.first())
    }
}

/// Joins `rel` onto `base_dir`, resolving `.` and `..`; `None` if it escapes the vault.
pub fn normalize_join(base_dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') || base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Candidate file names for a wiki-style target: `X` means `X.md` first, then `X` itself.
fn wiki_candidates(target: &str) -> Vec<String> {
    if target.to_lowercase().ends_with(".md") {
        vec![target.to_string()]
    } else {
        vec![format!("{target}.md"), target.to_string()]
    }
}

/// Resolves a link target to a vault path (PG-05, spec §4.4).
pub fn resolve(kind: LinkKind, target: &str, source: &str, files: &FileSet) -> Option<String> {
    let source_dir = dir_of(source);
    if !kind.is_wiki_style() {
        let joined = normalize_join(source_dir, target)?;
        return files
            .exact(&joined)
            .or_else(|| {
                if basename(&joined).contains('.') {
                    None
                } else {
                    files.exact(&format!("{joined}.md"))
                }
            })
            .cloned();
    }
    if let Some(rooted) = target.strip_prefix('/') {
        // `[[/Name]]`: vault-root path only (used when no suffix is unique).
        return wiki_candidates(rooted)
            .iter()
            .find_map(|c| files.exact(c))
            .cloned();
    }
    for cand in wiki_candidates(target) {
        // A target with `/` is a path: exact vault path, then relative to the
        // source folder. Bare names go straight to the name search below so the
        // same-folder tie-break applies.
        if cand.contains('/') {
            if let Some(hit) = files.exact(&cand) {
                return Some(hit.clone());
            }
            if let Some(rel) = normalize_join(source_dir, &cand)
                && let Some(hit) = files.exact(&rel)
            {
                return Some(hit.clone());
            }
        }
        let key = name_key(&cand);
        let suffix = format!("/{key}");
        let mut matches: Vec<&String> = files
            .by_name
            .get(&name_key(basename(&cand)))
            .map(|v| {
                v.iter()
                    .filter(|p| {
                        let k = name_key(p);
                        k == key || k.ends_with(&suffix)
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !matches.is_empty() {
            // Same folder as the source first, then fewest components, then path order.
            matches.sort_by_key(|p| (dir_of(p) != source_dir, p.matches('/').count(), p.as_str()));
            return Some(matches[0].clone());
        }
    }
    None
}

/// The text to write so that a link of `kind` from `source` points at
/// `target_path` (spec §4.4.5). Wiki-style: the shortest path suffix (without
/// `.md` for pages) that still resolves to exactly `target_path`, or the
/// vault-rooted `/path` when no suffix is unique (a same-folder file shadows a
/// root file). Path-style: relative to the source folder, or `/`-rooted when `rooted`.
pub fn shortest_unique_target(
    target_path: &str,
    source: &str,
    files: &FileSet,
    kind: LinkKind,
    rooted: bool,
) -> String {
    if !kind.is_wiki_style() {
        if rooted {
            return format!("/{target_path}");
        }
        return relative_path(dir_of(source), target_path);
    }
    let display = if target_path.to_lowercase().ends_with(".md") {
        &target_path[..target_path.len() - 3]
    } else {
        target_path
    };
    let parts: Vec<&str> = display.split('/').collect();
    for take in 1..=parts.len() {
        let candidate = parts[parts.len() - take..].join("/");
        if resolve(kind, &candidate, source, files).as_deref() == Some(target_path) {
            return candidate;
        }
    }
    format!("/{display}")
}

fn relative_path(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use LinkKind::*;

    fn set(paths: &[&str]) -> FileSet {
        FileSet::new(paths.iter().map(|s| s.to_string()))
    }

    fn ambiguous() -> FileSet {
        set(&[
            "Ideas.md",
            "Projects/Ideas.md",
            "Projects/Deep/Ideas.md",
            "Archive/Old/Ideas.md",
            "Links.md",
            "Projects/Other.md",
            "Elsewhere/Note.md",
        ])
    }

    #[test]
    fn pg_05_resolution_order_and_tie_breaks() {
        let f = ambiguous();
        let r = |t: &str, src: &str| resolve(Wiki, t, src, &f);
        assert_eq!(r("Ideas", "Links.md").as_deref(), Some("Ideas.md"));
        assert_eq!(
            r("Ideas", "Projects/Other.md").as_deref(),
            Some("Projects/Ideas.md"),
            "same folder wins"
        );
        assert_eq!(
            r("Ideas", "Elsewhere/Note.md").as_deref(),
            Some("Ideas.md"),
            "fewest components"
        );
        assert_eq!(
            r("Projects/Ideas", "Links.md").as_deref(),
            Some("Projects/Ideas.md"),
            "exact path"
        );
        assert_eq!(
            r("Deep/Ideas", "Links.md").as_deref(),
            Some("Projects/Deep/Ideas.md"),
            "suffix"
        );
        assert_eq!(
            r("Deep/Ideas", "Projects/Other.md").as_deref(),
            Some("Projects/Deep/Ideas.md"),
            "relative"
        );
        assert_eq!(r("Nope", "Links.md"), None);
    }

    #[test]
    fn pg_05_case_and_unicode_insensitive_matching() {
        let f = set(&[
            "unicode/Café ñandú 🎨.md",
            "Notes/v1.2 plan.md",
            "img/Photo.PNG",
        ]);
        assert_eq!(
            resolve(Wiki, "CAFÉ ÑANDÚ 🎨", "x.md", &f).as_deref(),
            Some("unicode/Café ñandú 🎨.md")
        );
        assert_eq!(
            resolve(Wiki, "cafe\u{301} n\u{303}andu\u{301} 🎨", "x.md", &f).as_deref(),
            Some("unicode/Café ñandú 🎨.md"),
            "NFD typed"
        );
        assert_eq!(
            resolve(Wiki, "v1.2 plan", "x.md", &f).as_deref(),
            Some("Notes/v1.2 plan.md"),
            "dots are not extensions"
        );
        assert_eq!(
            resolve(Embed, "photo.png", "x.md", &f).as_deref(),
            Some("img/Photo.PNG")
        );
    }

    #[test]
    fn pg_05_markdown_links_are_path_relative() {
        let f = set(&[
            "Character Design/DMC/Sparda.md",
            "Game Design/Game 1.md",
            "a.md",
        ]);
        let src = "Character Design/rex-draft.md";
        assert_eq!(
            resolve(Markdown, "DMC/Sparda.md", src, &f).as_deref(),
            Some("Character Design/DMC/Sparda.md")
        );
        assert_eq!(
            resolve(Markdown, "../Game Design/Game 1.md", src, &f).as_deref(),
            Some("Game Design/Game 1.md")
        );
        assert_eq!(
            resolve(Markdown, "/Game Design/Game 1.md", src, &f).as_deref(),
            Some("Game Design/Game 1.md")
        );
        assert_eq!(
            resolve(Markdown, "Sparda.md", src, &f),
            None,
            "no name search for path links"
        );
        assert_eq!(
            resolve(Markdown, "../../../a.md", src, &f),
            None,
            "escaping the vault"
        );
        assert_eq!(
            resolve(FrontmatterCover, "../a", src, &f).as_deref(),
            Some("a.md")
        );
    }

    #[test]
    fn pg_05_shortest_unique_target() {
        let f = ambiguous();
        assert_eq!(
            shortest_unique_target("Ideas.md", "Links.md", &f, Wiki, false),
            "Ideas"
        );
        assert_eq!(
            shortest_unique_target("Projects/Ideas.md", "Links.md", &f, Wiki, false),
            "Projects/Ideas"
        );
        assert_eq!(
            shortest_unique_target("Projects/Ideas.md", "Projects/Other.md", &f, Wiki, false),
            "Ideas"
        );
        assert_eq!(
            shortest_unique_target("Projects/Deep/Ideas.md", "Links.md", &f, Wiki, false),
            "Deep/Ideas"
        );
        assert_eq!(
            shortest_unique_target("img/x.png", "a.md", &set(&["img/x.png"]), Embed, false),
            "x.png"
        );
        assert_eq!(
            shortest_unique_target(
                "Game Design/Game 1.md",
                "Character Design/rex.md",
                &f,
                Markdown,
                false
            ),
            "../Game Design/Game 1.md"
        );
        assert_eq!(
            shortest_unique_target(
                "Game Design/Game 1.md",
                "Character Design/rex.md",
                &f,
                Markdown,
                true
            ),
            "/Game Design/Game 1.md"
        );
        assert_eq!(
            shortest_unique_target("A/B/c.md", "A/x.md", &f, Markdown, false),
            "B/c.md"
        );
        let shadowed = set(&["Ideas.md", "Elsewhere/Ideas.md", "Elsewhere/Note.md"]);
        assert_eq!(
            shortest_unique_target("Ideas.md", "Elsewhere/Note.md", &shadowed, Wiki, false),
            "/Ideas"
        );
        assert_eq!(
            resolve(Wiki, "/Ideas", "Elsewhere/Note.md", &shadowed).as_deref(),
            Some("Ideas.md")
        );
        assert_eq!(resolve(Wiki, "/Nope", "Elsewhere/Note.md", &shadowed), None);
    }

    #[test]
    fn link_key_matches_targets_and_paths() {
        assert_eq!(link_key("Projects/Ideas.md"), "ideas");
        assert_eq!(link_key("Deep/IDEAS"), "ideas");
        assert_eq!(link_key("img/Photo.PNG"), "photo.png");
        assert_eq!(link_key("Cafe\u{301}"), link_key("café.md"));
        assert_eq!(link_key(".md"), ".md");
    }

    #[test]
    fn fileset_insert_remove() {
        let mut f = set(&["a/Ideas.md"]);
        f.insert("Ideas.md".into());
        assert_eq!(
            resolve(Wiki, "ideas", "z.md", &f).as_deref(),
            Some("Ideas.md")
        );
        f.remove("Ideas.md");
        assert_eq!(
            resolve(Wiki, "ideas", "z.md", &f).as_deref(),
            Some("a/Ideas.md")
        );
        assert_eq!(f.len(), 1);
        assert!(f.contains("a/Ideas.md"));
    }
}
```

`crates/liber-markdown/src/lib.rs` (create or replace the whole file):

```rust
//! Metadata extraction from Markdown pages (title, frontmatter, tags, links).
//! Pure functions, no I/O.

mod body;
mod frontmatter;
mod page;
mod resolve;
mod title;
mod types;
mod wikilink;

pub use page::parse_page;
pub use resolve::{FileSet, link_key, name_key, normalize_join, resolve, shortest_unique_target};
pub use title::extract_title;
pub use types::{LinkKind, LinkRef, PageMeta, Tag};
```

- [ ] **Step 4: Run the tests, clippy and rustfmt**

Run: `cargo test -p liber-markdown && cargo clippy -p liber-markdown --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 30 unit + 4 integration tests

- [ ] **Step 5: Commit**

```bash
git add crates/liber-markdown
git commit -m "feat(markdown): Obsidian link resolution and shortest unique targets (PG-05)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: liber-index: SQLite cache (schema v1), writes, reads and link resolution

**Files:**
- Modify: `crates/liber-index/Cargo.toml`, `crates/liber-index/src/lib.rs`
- Create: `crates/liber-index/src/schema.rs`, `src/rows.rs`, `src/index.rs`
- Test: `crates/liber-index/tests/index.rs`

**Interfaces:**
- Consumes: Tasks 5–7 (`PageMeta`, `Tag`, `LinkKind`, `FileSet`, `resolve`, `link_key`, `name_key`); M0 `cache_dir_name` (kept).
- Produces:
  - `pub const SCHEMA_VERSION: i64 = 1`; `pub enum IndexError { Db(rusqlite::Error), Io(std::io::Error) }`; `pub type Result<T>`.
  - Rows: `pub enum FileKind { Page, Folder, Attachment }` (`as_str`, `parse`), `pub struct FileRow { path: String, kind: FileKind, mtime_ns: i64, size: u64, hash: Option<String> }`, `pub struct Stat { kind, mtime_ns: i64, size: u64, hash: Option<String> }`, `pub struct TreeNode { path, parent, name, kind, title: Option<String> }`, `pub struct LinkRow { id: i64, src, kind: LinkKind, target_raw, target_key, target_path: Option<String>, heading, alias, start: usize, end: usize, encoded, angle, label, directed }`, `pub struct PageRow { path, title, subtitle, cover, cover_y: Option<u8>, excerpt, has_image, has_audio, frontmatter_error, tags: Vec<Tag>, links: Vec<LinkRow> }` (all fields `pub`).
  - `pub struct Index`: `open(db_path: &Path) -> Result<Index>` (rebuilds on corrupt/foreign/old files), `open_in_memory()`, `transaction<T>(&mut self, f: impl FnOnce(&Tx<'_>) -> Result<T>) -> Result<T>`, `stats() -> HashMap<String, Stat>`, `stat(&str) -> Option<Stat>`, `file_set() -> FileSet`, `tree() -> Vec<TreeNode>` (by parent, folders first, then name key), `page(&str) -> Option<PageRow>`, `links_from(&str)`, `backlinks(&str)`, `links_into(prefix: &str)`, `links_by_key(&[String]) -> Vec<LinkRow>`, `counts() -> (files, pages)`, `resolve_all(&mut self, &FileSet) -> usize`, `resolve_affected(&mut self, &FileSet, keys: &[String]) -> usize`, `resolve_from(&mut self, &FileSet, src: &str) -> usize`.
  - `pub struct Tx<'a>`: `upsert_file(&FileRow)` (non-page kinds drop page data), `upsert_page(path, &PageMeta)` (links start unresolved), `remove(path)` (subtree; links to it become unresolved), `rename(from, to)` (subtree, incl. resolved link targets).

- [ ] **Step 1: Manifest**

`crates/liber-index/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-index"
description = "SQLite + FTS5 index cache and Global View / search queries."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
liber-markdown = { path = "../liber-markdown" }
rusqlite.workspace = true
sha2.workspace = true
thiserror.workspace = true
[dev-dependencies]
tempfile.workspace = true

[lints]
workspace = true
```

- [ ] **Step 2: Write the failing integration tests**

`crates/liber-index/tests/index.rs` (create or replace the whole file):

```rust
use liber_index::{FileKind, FileRow, Index, SCHEMA_VERSION};
use liber_markdown::{LinkKind, parse_page};

fn file(path: &str, kind: FileKind) -> FileRow {
    FileRow {
        path: path.into(),
        kind,
        mtime_ns: 1,
        size: 1,
        hash: (kind != FileKind::Folder).then(|| "h".into()),
    }
}

/// Small vault: folder A with a page and an image, a root page linking into A.
fn sample() -> Index {
    let mut idx = Index::open_in_memory().unwrap();
    idx.transaction(|tx| {
        tx.upsert_file(&file("A", FileKind::Folder))?;
        tx.upsert_file(&file("A/Ideas.md", FileKind::Page))?;
        tx.upsert_file(&file("A/pic.png", FileKind::Attachment))?;
        tx.upsert_file(&file("Home.md", FileKind::Page))?;
        tx.upsert_page(
            "A/Ideas.md",
            &parse_page("# Ideas\n\n![[pic.png]] #idea", "Ideas"),
        )?;
        tx.upsert_page(
            "Home.md",
            &parse_page("# Home\n\n[[Ideas]] and [[Missing]] #Home", "Home"),
        )?;
        Ok(())
    })
    .unwrap();
    let files = idx.file_set().unwrap();
    idx.resolve_all(&files).unwrap();
    idx
}

#[test]
fn pg_05_resolve_all_and_backlinks() {
    let idx = sample();
    let home = idx.page("Home.md").unwrap().unwrap();
    assert_eq!(home.title, "Home");
    let targets: Vec<_> = home
        .links
        .iter()
        .map(|l| (l.target_raw.as_str(), l.target_path.as_deref()))
        .collect();
    assert_eq!(
        targets,
        vec![("Ideas", Some("A/Ideas.md")), ("Missing", None)]
    );
    assert_eq!(idx.backlinks("A/Ideas.md").unwrap()[0].src, "Home.md");
    assert_eq!(
        idx.page("A/Ideas.md").unwrap().unwrap().links[0].kind,
        LinkKind::Embed
    );
    assert_eq!(
        idx.links_into("A").unwrap().len(),
        2,
        "link to page + embed of image"
    );
}

#[test]
fn pg_04_tags_are_stored_with_keys() {
    let idx = sample();
    let tags = idx.page("Home.md").unwrap().unwrap().tags;
    assert_eq!(
        (tags[0].text.as_str(), tags[0].key.as_str()),
        ("Home", "home")
    );
}

#[test]
fn pg_05_resolve_affected_picks_up_created_and_removed_files() {
    let mut idx = sample();
    idx.transaction(|tx| tx.upsert_file(&file("Missing.md", FileKind::Page)))
        .unwrap();
    let files = idx.file_set().unwrap();
    assert_eq!(
        idx.resolve_affected(&files, &["missing".into()]).unwrap(),
        1
    );
    assert_eq!(idx.backlinks("Missing.md").unwrap().len(), 1);
    idx.transaction(|tx| tx.remove("Missing.md")).unwrap();
    assert!(idx.backlinks("Missing.md").unwrap().is_empty());
    let home = idx.page("Home.md").unwrap().unwrap();
    assert_eq!(home.links[1].target_path, None);
}

#[test]
fn exp_02_rename_folder_moves_subtree_and_link_targets() {
    let mut idx = sample();
    idx.transaction(|tx| tx.rename("A", "B/A2")).unwrap();
    let paths: Vec<_> = idx.tree().unwrap().into_iter().map(|n| n.path).collect();
    assert!(
        paths.contains(&"B/A2/Ideas.md".to_string()) && !paths.iter().any(|p| p.starts_with("A/"))
    );
    assert_eq!(idx.backlinks("B/A2/Ideas.md").unwrap()[0].src, "Home.md");
    assert!(
        idx.page("B/A2/Ideas.md").unwrap().is_some(),
        "page row followed via ON UPDATE CASCADE"
    );
    assert_eq!(idx.links_from("B/A2/Ideas.md").unwrap().len(), 1);
}

#[test]
fn exp_03_remove_folder_removes_subtree() {
    let mut idx = sample();
    idx.transaction(|tx| tx.remove("A")).unwrap();
    assert_eq!(idx.counts().unwrap(), (1, 1));
    assert_eq!(
        idx.page("Home.md").unwrap().unwrap().links[0].target_path,
        None
    );
}

#[test]
fn exp_01_tree_orders_folders_first_then_name() {
    let mut idx = sample();
    idx.transaction(|tx| {
        tx.upsert_file(&file("b.md", FileKind::Page))?;
        tx.upsert_file(&file("Z", FileKind::Folder))?;
        tx.upsert_page("b.md", &parse_page("", "b"))
    })
    .unwrap();
    let root: Vec<_> = idx
        .tree()
        .unwrap()
        .into_iter()
        .filter(|n| n.parent.is_empty())
        .map(|n| n.name)
        .collect();
    assert_eq!(root, vec!["A", "Z", "b.md", "Home.md"]);
    let home = idx
        .tree()
        .unwrap()
        .into_iter()
        .find(|n| n.path == "Home.md")
        .unwrap();
    assert_eq!(home.title.as_deref(), Some("Home"));
}

#[test]
fn upsert_file_as_attachment_drops_page_data() {
    let mut idx = sample();
    idx.transaction(|tx| tx.upsert_file(&file("Home.md", FileKind::Attachment)))
        .unwrap();
    assert!(idx.page("Home.md").unwrap().is_none());
    assert!(idx.links_from("Home.md").unwrap().is_empty());
}

#[test]
fn review_focus_corrupt_or_foreign_or_old_db_is_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("liber/abc/index.sqlite");
    {
        let mut idx = Index::open(&db).unwrap();
        idx.transaction(|tx| tx.upsert_file(&file("x.md", FileKind::Page)))
            .unwrap();
    }
    assert_eq!(
        Index::open(&db).unwrap().counts().unwrap().0,
        1,
        "reopen keeps data"
    );

    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'schema_version'",
            [(SCHEMA_VERSION + 1).to_string()],
        )
        .unwrap();
    }
    assert_eq!(
        Index::open(&db).unwrap().counts().unwrap().0,
        0,
        "version mismatch → fresh"
    );

    std::fs::write(&db, b"this is not a database at all, just junk bytes").unwrap();
    assert_eq!(
        Index::open(&db).unwrap().counts().unwrap().0,
        0,
        "garbage → fresh"
    );

    let foreign = dir.path().join("foreign.sqlite");
    rusqlite::Connection::open(&foreign)
        .unwrap()
        .execute_batch("CREATE TABLE other (x);")
        .unwrap();
    assert_eq!(
        Index::open(&foreign).unwrap().counts().unwrap().0,
        0,
        "foreign db → fresh"
    );
}

#[test]
fn stats_return_stored_stat() {
    let idx = sample();
    let stats = idx.stats().unwrap();
    assert_eq!(stats["A"].kind, FileKind::Folder);
    assert_eq!(
        idx.stat("Home.md").unwrap().unwrap().hash.as_deref(),
        Some("h")
    );
    assert!(idx.stat("nope").unwrap().is_none());
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cargo test -p liber-index --test index`

Expected: FAIL: compile errors `unresolved imports liber_index::{FileKind, FileRow, Index, SCHEMA_VERSION}`

- [ ] **Step 4: Implement**

`crates/liber-index/src/schema.rs` (create or replace the whole file):

```rust
pub const SCHEMA_VERSION: i64 = 1;

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
    path TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'folder', 'attachment')),
    mtime_ns INTEGER NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT
);
CREATE INDEX files_parent ON files(parent);
CREATE TABLE pages (
    path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
    title TEXT NOT NULL,
    subtitle TEXT,
    cover TEXT,
    cover_y INTEGER,
    excerpt TEXT NOT NULL,
    has_image INTEGER NOT NULL,
    has_audio INTEGER NOT NULL,
    frontmatter_error TEXT
);
CREATE TABLE tags (
    path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
    tag TEXT NOT NULL,
    tag_key TEXT NOT NULL
);
CREATE INDEX tags_key ON tags(tag_key);
CREATE INDEX tags_path ON tags(path);
CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    src TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
    kind TEXT NOT NULL,
    target_raw TEXT NOT NULL,
    target_key TEXT NOT NULL,
    target_path TEXT,
    heading TEXT,
    alias TEXT,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    encoded INTEGER NOT NULL,
    angle INTEGER NOT NULL,
    label TEXT,
    directed INTEGER NOT NULL
);
CREATE INDEX links_target_path ON links(target_path);
CREATE INDEX links_target_key ON links(target_key);
CREATE INDEX links_src ON links(src);
"#;
```

`crates/liber-index/src/rows.rs` (create or replace the whole file):

```rust
use liber_markdown::{LinkKind, Tag};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Page,
    Folder,
    Attachment,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Page => "page",
            FileKind::Folder => "folder",
            FileKind::Attachment => "attachment",
        }
    }

    pub fn parse(s: &str) -> FileKind {
        match s {
            "page" => FileKind::Page,
            "folder" => FileKind::Folder,
            _ => FileKind::Attachment,
        }
    }
}

/// One visible vault entry as stored in `files`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRow {
    pub path: String,
    pub kind: FileKind,
    pub mtime_ns: i64,
    pub size: u64,
    /// BLAKE3 hex; `None` for folders.
    pub hash: Option<String>,
}

/// Stored stat of a file, used to skip unchanged files on open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub kind: FileKind,
    pub mtime_ns: i64,
    pub size: u64,
    pub hash: Option<String>,
}

/// An explorer row (EXP-01). `title` is set for pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    pub path: String,
    pub parent: String,
    pub name: String,
    pub kind: FileKind,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRow {
    pub id: i64,
    pub src: String,
    pub kind: LinkKind,
    pub target_raw: String,
    pub target_key: String,
    pub target_path: Option<String>,
    pub heading: Option<String>,
    pub alias: Option<String>,
    pub start: usize,
    pub end: usize,
    pub encoded: bool,
    pub angle: bool,
    pub label: Option<String>,
    pub directed: bool,
}

/// A page with its tags and outgoing links (read-only page view, M1b).
#[derive(Debug, Clone, PartialEq)]
pub struct PageRow {
    pub path: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub cover: Option<String>,
    pub cover_y: Option<u8>,
    pub excerpt: String,
    pub has_image: bool,
    pub has_audio: bool,
    pub frontmatter_error: Option<String>,
    pub tags: Vec<Tag>,
    pub links: Vec<LinkRow>,
}

/// `parent` and `name` columns for a vault path (`""` parent at the root).
pub(crate) fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

pub(crate) fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}
```

`crates/liber-index/src/index.rs` (create or replace the whole file):

```rust
use crate::rows::{FileKind, FileRow, LinkRow, PageRow, Stat, TreeNode, ext_of, split_path};
use crate::schema::{SCHEMA, SCHEMA_VERSION};
use liber_markdown::{FileSet, LinkKind, PageMeta, Tag, link_key, name_key, resolve};
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("index database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("index file error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, IndexError>;

/// The SQLite cache of one vault (spec §5). Never touches vault files.
pub struct Index {
    conn: Connection,
}

impl std::fmt::Debug for Index {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Index")
    }
}

/// Writes inside one transaction.
pub struct Tx<'a> {
    tx: rusqlite::Transaction<'a>,
}

const LINK_COLUMNS: &str = "id, src, kind, target_raw, target_key, target_path, heading, alias, start, end, encoded, angle, label, directed";

fn link_row(r: &Row<'_>) -> rusqlite::Result<LinkRow> {
    Ok(LinkRow {
        id: r.get(0)?,
        src: r.get(1)?,
        kind: LinkKind::parse(&r.get::<_, String>(2)?).unwrap_or(LinkKind::Wiki),
        target_raw: r.get(3)?,
        target_key: r.get(4)?,
        target_path: r.get(5)?,
        heading: r.get(6)?,
        alias: r.get(7)?,
        start: r.get::<_, i64>(8)? as usize,
        end: r.get::<_, i64>(9)? as usize,
        encoded: r.get(10)?,
        angle: r.get(11)?,
        label: r.get(12)?,
        directed: r.get(13)?,
    })
}

/// `?1` is the path itself or a folder containing it.
const IN_SUBTREE: &str =
    "(path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1) + 1) = ?1 || '/'))";

impl Index {
    /// Opens (or creates) the cache at `db_path`. A wrong schema version, a
    /// corrupt or foreign file is deleted and rebuilt: the index is only a cache.
    pub fn open(db_path: &Path) -> Result<Index> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        match Self::try_open(db_path) {
            Ok(Some(index)) => Ok(index),
            _ => {
                for suffix in ["", "-wal", "-shm"] {
                    let mut p = db_path.as_os_str().to_owned();
                    p.push(suffix);
                    let _ = std::fs::remove_file(p);
                }
                let conn = Connection::open(db_path)?;
                Self::init(conn)
            }
        }
    }

    pub fn open_in_memory() -> Result<Index> {
        Self::init(Connection::open_in_memory()?)
    }

    /// `Ok(None)` when the file exists but is not a usable v1 index.
    fn try_open(db_path: &Path) -> Result<Option<Index>> {
        let fresh = !db_path.exists();
        let conn = Connection::open(db_path)?;
        if fresh {
            return Self::init(conn).map(Some);
        }
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Ok(None);
        }
        let version: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if version.as_deref() != Some(&SCHEMA_VERSION.to_string()) {
            return Ok(None);
        }
        Self::configure(&conn)?;
        Ok(Some(Index { conn }))
    }

    fn configure(conn: &Connection) -> Result<()> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    }

    fn init(conn: Connection) -> Result<Index> {
        Self::configure(&conn)?;
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)",
            [SCHEMA_VERSION.to_string()],
        )?;
        Ok(Index { conn })
    }

    /// Runs `f` in one transaction (committed if it returns `Ok`).
    pub fn transaction<T>(&mut self, f: impl FnOnce(&Tx<'_>) -> Result<T>) -> Result<T> {
        let tx = Tx {
            tx: self.conn.transaction()?,
        };
        let out = f(&tx)?;
        tx.tx.commit()?;
        Ok(out)
    }

    // ---- reads ----

    /// Every stored entry's stat, keyed by path (for incremental indexing).
    pub fn stats(&self) -> Result<HashMap<String, Stat>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, kind, mtime_ns, size, hash FROM files")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Stat {
                    kind: FileKind::parse(&r.get::<_, String>(1)?),
                    mtime_ns: r.get(2)?,
                    size: r.get::<_, i64>(3)? as u64,
                    hash: r.get(4)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn stat(&self, path: &str) -> Result<Option<Stat>> {
        Ok(self
            .conn
            .query_row(
                "SELECT kind, mtime_ns, size, hash FROM files WHERE path = ?1",
                [path],
                |r| {
                    Ok(Stat {
                        kind: FileKind::parse(&r.get::<_, String>(0)?),
                        mtime_ns: r.get(1)?,
                        size: r.get::<_, i64>(2)? as u64,
                        hash: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// All non-folder paths, for link resolution.
    pub fn file_set(&self) -> Result<FileSet> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM files WHERE kind != 'folder'")?;
        let paths = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(FileSet::new(paths.collect::<rusqlite::Result<Vec<_>>>()?))
    }

    /// Explorer rows: grouped by parent, folders first, then by name (case- and
    /// accent-insensitive key).
    pub fn tree(&self) -> Result<Vec<TreeNode>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.path, f.parent, f.name, f.kind, p.title FROM files f LEFT JOIN pages p ON p.path = f.path",
        )?;
        let mut nodes = stmt
            .query_map([], |r| {
                Ok(TreeNode {
                    path: r.get(0)?,
                    parent: r.get(1)?,
                    name: r.get(2)?,
                    kind: FileKind::parse(&r.get::<_, String>(3)?),
                    title: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        nodes.sort_by_cached_key(|n| {
            (
                n.parent.clone(),
                n.kind != FileKind::Folder,
                name_key(&n.name),
                n.name.clone(),
            )
        });
        Ok(nodes)
    }

    pub fn page(&self, path: &str) -> Result<Option<PageRow>> {
        let page = self
            .conn
            .query_row(
                "SELECT title, subtitle, cover, cover_y, excerpt, has_image, has_audio, frontmatter_error FROM pages WHERE path = ?1",
                [path],
                |r| {
                    Ok(PageRow {
                        path: path.to_string(),
                        title: r.get(0)?,
                        subtitle: r.get(1)?,
                        cover: r.get(2)?,
                        cover_y: r.get::<_, Option<i64>>(3)?.map(|v| v as u8),
                        excerpt: r.get(4)?,
                        has_image: r.get(5)?,
                        has_audio: r.get(6)?,
                        frontmatter_error: r.get(7)?,
                        tags: Vec::new(),
                        links: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut page) = page else {
            return Ok(None);
        };
        let mut stmt = self
            .conn
            .prepare("SELECT tag FROM tags WHERE path = ?1 ORDER BY rowid")?;
        page.tags = stmt
            .query_map([path], |r| r.get::<_, String>(0))?
            .map(|t| t.map(|t| Tag::new(&t)))
            .collect::<rusqlite::Result<_>>()?;
        page.links = self.links_from(path)?;
        Ok(Some(page))
    }

    pub fn links_from(&self, src: &str) -> Result<Vec<LinkRow>> {
        self.query_links(
            &format!("SELECT {LINK_COLUMNS} FROM links WHERE src = ?1 ORDER BY start"),
            [src],
        )
    }

    /// Links whose resolved target is `path` (EXP-04 input; backlinks panel later).
    pub fn backlinks(&self, path: &str) -> Result<Vec<LinkRow>> {
        self.query_links(
            &format!("SELECT {LINK_COLUMNS} FROM links WHERE target_path = ?1 ORDER BY src, start"),
            [path],
        )
    }

    /// Links whose resolved target is `prefix` or inside the folder `prefix`.
    pub fn links_into(&self, prefix: &str) -> Result<Vec<LinkRow>> {
        let cond = IN_SUBTREE.replace("path", "target_path");
        self.query_links(
            &format!("SELECT {LINK_COLUMNS} FROM links WHERE {cond} ORDER BY src, start"),
            [prefix],
        )
    }

    /// Links whose `target_key` is one of `keys` (see `liber_markdown::link_key`).
    pub fn links_by_key(&self, keys: &[String]) -> Result<Vec<LinkRow>> {
        let mut out = Vec::new();
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {LINK_COLUMNS} FROM links WHERE target_key = ?1 ORDER BY src, start"
        ))?;
        for key in keys {
            out.extend(
                stmt.query_map([key], link_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }
        Ok(out)
    }

    fn query_links<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<LinkRow>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, link_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn counts(&self) -> Result<(usize, usize)> {
        let files: i64 = self
            .conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))?;
        let pages: i64 = self
            .conn
            .query_row("SELECT count(*) FROM pages", [], |r| r.get(0))?;
        Ok((files as usize, pages as usize))
    }

    // ---- resolution ----

    /// Re-resolves every link against `files`.
    pub fn resolve_all(&mut self, files: &FileSet) -> Result<usize> {
        let links = self.query_links(&format!("SELECT {LINK_COLUMNS} FROM links"), [])?;
        self.apply_resolution(files, links)
    }

    /// Re-resolves links whose `target_key` is in `keys`.
    pub fn resolve_affected(&mut self, files: &FileSet, keys: &[String]) -> Result<usize> {
        let links = self.links_by_key(keys)?;
        self.apply_resolution(files, links)
    }

    /// Re-resolves the outgoing links of `src` (after it was re-parsed or moved).
    pub fn resolve_from(&mut self, files: &FileSet, src: &str) -> Result<usize> {
        let links = self.links_from(src)?;
        self.apply_resolution(files, links)
    }

    fn apply_resolution(&mut self, files: &FileSet, links: Vec<LinkRow>) -> Result<usize> {
        self.transaction(|tx| {
            let mut stmt = tx
                .tx
                .prepare_cached("UPDATE links SET target_path = ?2 WHERE id = ?1")?;
            let mut changed = 0;
            for l in &links {
                let target = resolve(l.kind, &l.target_raw, &l.src, files);
                if target != l.target_path {
                    stmt.execute(params![l.id, target])?;
                    changed += 1;
                }
            }
            Ok(changed)
        })
    }
}

impl Tx<'_> {
    pub fn upsert_file(&self, row: &FileRow) -> Result<()> {
        let (parent, name) = split_path(&row.path);
        self.tx.prepare_cached(
            "INSERT INTO files (path, parent, name, ext, kind, mtime_ns, size, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(path) DO UPDATE SET kind = ?5, mtime_ns = ?6, size = ?7, hash = ?8",
        )?
        .execute(params![row.path, parent, name, ext_of(name), row.kind.as_str(), row.mtime_ns, row.size as i64, row.hash])?;
        if row.kind != FileKind::Page {
            self.tx
                .prepare_cached("DELETE FROM pages WHERE path = ?1")?
                .execute([&row.path])?;
            self.tx
                .prepare_cached("DELETE FROM tags WHERE path = ?1")?
                .execute([&row.path])?;
            self.tx
                .prepare_cached("DELETE FROM links WHERE src = ?1")?
                .execute([&row.path])?;
        }
        Ok(())
    }

    /// Replaces the page row, tags and links of `path` (which must be in `files`).
    /// New links start unresolved; call a `resolve_*` method afterwards.
    pub fn upsert_page(&self, path: &str, meta: &PageMeta) -> Result<()> {
        self.tx.prepare_cached(
            "INSERT OR REPLACE INTO pages (path, title, subtitle, cover, cover_y, excerpt, has_image, has_audio, frontmatter_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?
        .execute(params![
            path, meta.title, meta.subtitle, meta.cover, meta.cover_y.map(i64::from), meta.excerpt,
            meta.has_image, meta.has_audio, meta.frontmatter_error
        ])?;
        self.tx
            .prepare_cached("DELETE FROM tags WHERE path = ?1")?
            .execute([path])?;
        self.tx
            .prepare_cached("DELETE FROM links WHERE src = ?1")?
            .execute([path])?;
        let mut tag_stmt = self
            .tx
            .prepare_cached("INSERT INTO tags (path, tag, tag_key) VALUES (?1, ?2, ?3)")?;
        for tag in &meta.tags {
            tag_stmt.execute(params![path, tag.text, tag.key])?;
        }
        let mut link_stmt = self.tx.prepare_cached(
            "INSERT INTO links (src, kind, target_raw, target_key, target_path, heading, alias, start, end, encoded, angle, label, directed)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        for l in &meta.links {
            link_stmt.execute(params![
                path,
                l.kind.as_str(),
                l.target,
                link_key(&l.target),
                l.heading,
                l.alias,
                l.range.start as i64,
                l.range.end as i64,
                l.encoded,
                l.angle,
                l.label,
                l.directed
            ])?;
        }
        Ok(())
    }

    /// Removes `path` and, for folders, everything inside it. Links pointing at
    /// removed files become unresolved.
    pub fn remove(&self, path: &str) -> Result<()> {
        let cond = IN_SUBTREE.replace("path", "target_path");
        self.tx.execute(
            &format!("UPDATE links SET target_path = NULL WHERE {cond}"),
            [path],
        )?;
        self.tx
            .execute(&format!("DELETE FROM files WHERE {IN_SUBTREE}"), [path])?;
        Ok(())
    }

    /// Moves `from` (file or folder subtree) to `to`, including resolved link targets.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let mut stmt = self
            .tx
            .prepare(&format!("SELECT path FROM files WHERE {IN_SUBTREE}"))?;
        let paths: Vec<String> = stmt
            .query_map([from], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut update = self.tx.prepare_cached(
            "UPDATE files SET path = ?2, parent = ?3, name = ?4, ext = ?5 WHERE path = ?1",
        )?;
        let mut retarget = self
            .tx
            .prepare_cached("UPDATE links SET target_path = ?2 WHERE target_path = ?1")?;
        for old in paths {
            let new = format!("{to}{}", &old[from.len()..]);
            let (parent, name) = split_path(&new);
            update.execute(params![old, new, parent, name, ext_of(name)])?;
            retarget.execute(params![old, new])?;
        }
        Ok(())
    }
}
```

`crates/liber-index/src/lib.rs` (create or replace the whole file):

```rust
//! SQLite cache of one vault (spec §5): files, pages, tags, links.
//! Never reads or writes vault files; `liber-session` feeds it.

mod index;
mod rows;
mod schema;

pub use index::{Index, IndexError, Result, Tx};
pub use rows::{FileKind, FileRow, LinkRow, PageRow, Stat, TreeNode};
pub use schema::SCHEMA_VERSION;

use sha2::{Digest, Sha256};
use std::path::Path;

/// Folder name for a vault's index cache inside the OS cache dir
/// (`liber/<name>/index.sqlite`): first 16 hex chars of SHA-256 of the
/// canonical absolute vault path. Callers must pass a canonicalized path.
pub fn cache_dir_name(vault_abs_path: &Path) -> String {
    let digest = Sha256::digest(vault_abs_path.as_os_str().as_encoded_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::cache_dir_name;
    use std::path::Path;

    #[test]
    fn cache_name_is_sha256_prefix_of_path() {
        assert_eq!(
            cache_dir_name(Path::new("/Users/ana/Notes")),
            "33055923156cea57"
        );
        assert_eq!(
            cache_dir_name(Path::new("/Users/ana/Notes2")),
            "5e2f1a1b5dd864e0"
        );
    }

    #[test]
    fn cache_name_is_16_lowercase_hex_chars() {
        let name = cache_dir_name(Path::new("/tmp/Bóveda con espacios"));
        assert_eq!(name.len(), 16);
        assert!(
            name.chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        );
    }
}
```

- [ ] **Step 5: Run the tests, clippy and rustfmt**

Run: `cargo test -p liber-index && cargo clippy -p liber-index --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 2 unit (M0) + 9 integration tests

- [ ] **Step 6: Commit**

```bash
git add Cargo.lock crates/liber-index
git commit -m "feat(index): SQLite cache with link resolution (PG-05, EXP-01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: liber-session: open + incremental index, reads, create/trash operations

**Files:**
- Create: `crates/liber-session/Cargo.toml`, `src/lib.rs`, `src/error.rs`, `src/events.rs`, `src/session.rs`
- Test: `crates/liber-session/tests/open.rs`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:
  - `pub enum SessionError { Vault(VaultError), Index(IndexError), NotIndexed(String), InvalidName(String) }`, `pub type Result<T>`.
  - `pub struct IndexReport { files, pages, parsed, skipped_unchanged, removed: usize, warnings: Vec<String>, duration: Duration }`; `pub enum SessionEvent { Progress { done, total }, Indexed(IndexReport), Changed { created, modified, removed: Vec<String>, renamed: Vec<(String, String)> } }`; `pub struct RenameOutcome { moved: Vec<(String, String)>, updated_files: Vec<String>, updated_links: usize, failed: Vec<(String, String)> }` (used from Task 10).
  - `pub fn index_db_path(cache_root: &Path, vault_root: &Path) -> PathBuf` (`<cache_root>/liber/<cache_dir_name>/index.sqlite`).
  - `pub struct VaultSession`: `open(root: &Path, cache_root: &Path, sink: impl Fn(SessionEvent) + Send + Sync + 'static) -> Result<(VaultSession, IndexReport)>`, `vault(&self) -> &Vault`, `tree() -> Vec<TreeNode>`, `page(&VaultPath) -> Option<PageRow>`, `backlinks(&VaultPath) -> Vec<LinkRow>`, `create_page(dir: &VaultPath, name: &str) -> Result<VaultPath>`, `create_folder(parent: &VaultPath, name: &str) -> Result<VaultPath>`, `trash(&VaultPath) -> Result<()>`.
  - crate-internal (used by Tasks 10–11): `index()`, `emit(SessionEvent)`, `reindex_all()`, `load(&Entry, old_hash, &mut warnings) -> Option<Loaded>`, `reindex_written(&VaultPath, text, Hash)`, `enum Loaded { StatOnly(FileRow), Page(FileRow, Box<PageMeta>), Attachment(FileRow) }`, `write_loaded`, `folder_row`, `unchanged`, `clamp_ns`, `validate_name`, `is_page_path`.

- [ ] **Step 1: Create the crate manifest**

`crates/liber-session/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-session"
description = "One open vault: indexing, watching and file operations over liber-vault, liber-markdown and liber-index."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
liber-index = { path = "../liber-index" }
liber-markdown = { path = "../liber-markdown" }
liber-vault = { path = "../liber-vault" }
percent-encoding.workspace = true
rayon.workspace = true
thiserror.workspace = true

[dev-dependencies]
liber-testkit = { path = "../liber-testkit" }
proptest.workspace = true
tempfile.workspace = true

[lints]
workspace = true
```

- [ ] **Step 2: Write the failing integration tests**

`crates/liber-session/tests/open.rs` (create or replace the whole file):

```rust
use liber_markdown::LinkKind;
use liber_session::{SessionError, SessionEvent, VaultSession};
use liber_testkit::{copy_fixture, snapshot, trashable_fixture};
use liber_vault::VaultPath;
use std::sync::{Arc, Mutex};

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn open(
    root: &std::path::Path,
    cache: &std::path::Path,
) -> (
    VaultSession,
    liber_session::IndexReport,
    Arc<Mutex<Vec<SessionEvent>>>,
) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (s, r) = VaultSession::open(root, cache, move |e| sink.lock().unwrap().push(e)).unwrap();
    (s, r, events)
}

fn targets(s: &VaultSession, page: &str) -> Vec<(String, Option<String>)> {
    s.page(&vp(page))
        .unwrap()
        .unwrap()
        .links
        .into_iter()
        .map(|l| (l.target_raw, l.target_path))
        .collect()
}

#[test]
fn vlt_02_opening_any_fixture_changes_nothing() {
    for name in ["obsidian-basic", "ambiguous-names", "edge-cases"] {
        let vault = copy_fixture(name);
        let cache = tempfile::tempdir().unwrap();
        let before = snapshot(vault.path());
        let _ = open(vault.path(), cache.path());
        assert_eq!(
            snapshot(vault.path()),
            before,
            "{name}: vault bytes or mtimes changed"
        );
        assert!(
            !vault.path().join(".liber").exists(),
            "{name}: .liber created"
        );
        assert!(
            cache.path().join("liber").is_dir(),
            "index lives in the cache dir"
        );
    }
}

#[test]
fn pg_01_04_05_obsidian_basic_is_indexed_and_resolved() {
    let vault = copy_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (s, report, events) = open(vault.path(), cache.path());
    assert_eq!(report.pages, 5);
    assert_eq!(report.removed, 0);
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, SessionEvent::Indexed(_)))
    );

    let rex = s
        .page(&vp("Character Design/rex-draft.md"))
        .unwrap()
        .unwrap();
    assert_eq!(rex.title, "Generator Rex");
    assert_eq!(rex.subtitle.as_deref(), Some("Hero redesign · v3"));
    assert_eq!(rex.cover_y, Some(40));
    assert!(rex.has_image && rex.has_audio);
    assert_eq!(
        rex.tags.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        vec!["character", "redesign"]
    );
    let got: Vec<_> = rex
        .links
        .iter()
        .map(|l| (l.kind, l.target_path.clone().unwrap_or_default()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                LinkKind::FrontmatterCover,
                "Character Design/assets/rex-cover.png".into()
            ),
            (
                LinkKind::FrontmatterRelated,
                "Character Design/DMC/Sparda.md".into()
            ),
            (LinkKind::FrontmatterRelated, "Game Design/Game 1.md".into()),
            (
                LinkKind::Embed,
                "Character Design/assets/rex-turnaround.png".into()
            ),
            (
                LinkKind::Embed,
                "Character Design/assets/voice-reference.mp3".into()
            ),
            (LinkKind::Markdown, "Character Design/DMC/Sparda.md".into()),
            (LinkKind::Markdown, "Game Design/Game 1.md".into()),
            (LinkKind::Markdown, "Game Design/Game 1.md".into()),
        ]
    );
    assert_eq!(
        targets(&s, "Character Design/My characters.md"),
        vec![
            (
                "rex-draft".into(),
                Some("Character Design/rex-draft.md".into())
            ),
            ("Generator Rex".into(), None),
            (
                "Sparda".into(),
                Some("Character Design/DMC/Sparda.md".into())
            ),
            (
                "DMC/Sparda".into(),
                Some("Character Design/DMC/Sparda.md".into())
            ),
        ]
    );
    assert_eq!(s.backlinks(&vp("Game Design/Game 1.md")).unwrap().len(), 3);
    let tree = s.tree().unwrap();
    assert!(tree.iter().any(|n| n.path == "Game Design/notes.txt"));
    assert!(
        !tree
            .iter()
            .any(|n| n.path.contains(".obsidian") || n.path.contains(".trash"))
    );
}

#[test]
fn pg_05_ambiguous_names_follow_tie_breaks() {
    let vault = copy_fixture("ambiguous-names");
    let cache = tempfile::tempdir().unwrap();
    let (s, ..) = open(vault.path(), cache.path());
    let t = |p| {
        targets(&s, p)
            .into_iter()
            .map(|(_, t)| t.unwrap())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        t("Links.md"),
        vec![
            "Ideas.md",
            "Projects/Ideas.md",
            "Projects/Deep/Ideas.md",
            "Archive/Old/Ideas.md"
        ]
    );
    assert_eq!(t("Projects/Other.md"), vec!["Projects/Ideas.md"]);
    assert_eq!(t("Elsewhere/Note.md"), vec!["Ideas.md"]);
}

#[test]
fn edge_cases_are_indexed_with_warnings_not_errors() {
    let vault = copy_fixture("edge-cases");
    let cache = tempfile::tempdir().unwrap();
    let (s, report, _) = open(vault.path(), cache.path());
    let w = report.warnings.join("\n");
    assert!(w.contains("latin1.md") && w.contains("bad-yaml.md"), "{w}");
    assert!(
        s.page(&vp("latin1.md")).unwrap().is_none(),
        "non-UTF-8 page is an attachment"
    );
    assert_eq!(
        targets(&s, "code.md"),
        vec![("target".into(), Some("target.md".into()))]
    );
    assert_eq!(
        targets(&s, "bad-yaml.md"),
        vec![("target".into(), Some("target.md".into()))]
    );
    let crlf = s.page(&vp("crlf.md")).unwrap().unwrap();
    assert_eq!(
        (crlf.title.as_str(), crlf.subtitle.as_deref()),
        ("CRLF page", Some("Windows"))
    );
    assert_eq!(
        targets(&s, "unicode/Café ñandú 🎨.md")[0].1.as_deref(),
        Some("unicode/Café ñandú 🎨.md")
    );
    assert_eq!(s.page(&vp("empty.md")).unwrap().unwrap().title, "empty");
}

#[test]
fn nfr_03_reopen_is_incremental() {
    let vault = copy_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (_, first, _) = open(vault.path(), cache.path());
    let (_, second, _) = open(vault.path(), cache.path());
    assert_eq!(second.parsed, 0);
    assert_eq!(second.skipped_unchanged, first.parsed);
    std::fs::write(vault.path().join("Welcome.md"), "# Welcome back\n").unwrap();
    std::fs::remove_file(vault.path().join("Game Design/notes.txt")).unwrap();
    let (s, third, _) = open(vault.path(), cache.path());
    assert_eq!((third.parsed, third.removed), (1, 1));
    assert_eq!(
        s.page(&vp("Welcome.md")).unwrap().unwrap().title,
        "Welcome back"
    );
}

#[test]
fn exp_02_create_page_and_folder_resolve_waiting_links() {
    let vault = copy_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (s, ..) = open(vault.path(), cache.path());
    let dir = s.create_folder(&vp("Character Design"), "Heroes").unwrap();
    assert!(vault.path().join("Character Design/Heroes").is_dir());
    let page = s.create_page(&dir, "Generator Rex").unwrap();
    assert_eq!(page.as_str(), "Character Design/Heroes/Generator Rex.md");
    assert_eq!(
        std::fs::read(vault.path().join(page.as_str())).unwrap(),
        b""
    );
    assert_eq!(
        targets(&s, "Character Design/My characters.md")[1]
            .1
            .as_deref(),
        Some("Character Design/Heroes/Generator Rex.md")
    );
    assert!(matches!(
        s.create_page(&dir, "Generator Rex.md"),
        Err(SessionError::Vault(_))
    ));
    for bad in ["", "  ", "a/b", ".hidden"] {
        assert!(
            matches!(s.create_page(&dir, bad), Err(SessionError::InvalidName(_))),
            "{bad:?}"
        );
    }
}

#[test]
fn exp_03_trash_removes_from_index_and_unresolves_links() {
    let vault = trashable_fixture("obsidian-basic");
    let cache = tempfile::tempdir().unwrap();
    let (s, ..) = open(vault.path(), cache.path());
    s.trash(&vp("Character Design/DMC")).unwrap();
    assert!(!vault.path().join("Character Design/DMC").exists());
    assert!(
        s.page(&vp("Character Design/DMC/Sparda.md"))
            .unwrap()
            .is_none()
    );
    assert_eq!(targets(&s, "Character Design/My characters.md")[2].1, None);
}

#[test]
fn review_focus_names_differing_only_by_case_on_case_sensitive_fs() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("ideas.md"), "# lower").unwrap();
    if vault.path().join("IDEAS.md").exists() {
        return; // case-insensitive filesystem (macOS/Windows default): nothing to test
    }
    std::fs::write(vault.path().join("Ideas.md"), "# upper").unwrap();
    std::fs::write(vault.path().join("Link.md"), "[[IDEAS]]").unwrap();
    let cache = tempfile::tempdir().unwrap();
    let (s, report, _) = open(vault.path(), cache.path());
    assert_eq!(report.pages, 3);
    assert_eq!(
        targets(&s, "Link.md")[0].1.as_deref(),
        Some("Ideas.md"),
        "deterministic: path order"
    );
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cargo test -p liber-session --test open`

Expected: FAIL: `can't find library liber_session` (no `src/lib.rs` yet)

- [ ] **Step 4: Implement**

`crates/liber-session/src/error.rs` (create or replace the whole file):

```rust
use liber_index::IndexError;
use liber_vault::VaultError;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error("not in the index: {0}")]
    NotIndexed(String),
    #[error("invalid name: {0}")]
    InvalidName(String),
}

pub type Result<T> = std::result::Result<T, SessionError>;
```

`crates/liber-session/src/events.rs` (create or replace the whole file):

```rust
use std::time::Duration;

/// Summary of a full (incremental) index pass.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IndexReport {
    /// Visible entries in the vault (files + folders).
    pub files: usize,
    pub pages: usize,
    /// Files read and parsed (new or changed content).
    pub parsed: usize,
    /// Files whose stat matched the index and were not read.
    pub skipped_unchanged: usize,
    pub removed: usize,
    pub warnings: Vec<String>,
    pub duration: Duration,
}

/// Notifications for the UI layer (M1b forwards them as Tauri events).
#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    Progress {
        done: usize,
        total: usize,
    },
    Indexed(IndexReport),
    /// External changes applied from the watcher (one event per batch).
    Changed {
        created: Vec<String>,
        modified: Vec<String>,
        removed: Vec<String>,
        renamed: Vec<(String, String)>,
    },
}

/// Result of [`crate::VaultSession::rename`] (EXP-02, EXP-04).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenameOutcome {
    /// Every file that moved (old, new); one entry per file inside a moved folder.
    pub moved: Vec<(String, String)>,
    /// Files whose links were rewritten (paths after the move).
    pub updated_files: Vec<String>,
    pub updated_links: usize,
    /// Files that could not be rewritten (path, reason); the move itself succeeded.
    pub failed: Vec<(String, String)>,
}
```

`crates/liber-session/src/session.rs` (create or replace the whole file):

```rust
use crate::error::{Result, SessionError};
use crate::events::{IndexReport, SessionEvent};
use liber_index::{FileKind, FileRow, Index, Stat, cache_dir_name};
use liber_markdown::{PageMeta, link_key, parse_page};
use liber_vault::{Entry, EntryKind, Hash, Vault, VaultPath, is_hidden_name};
use rayon::prelude::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

const PROGRESS_EVERY: usize = 200;
const BATCH_ROWS: usize = 500;

pub(crate) type Sink = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// One open vault: the vault folder, its index cache and (optionally) a watcher.
pub struct VaultSession {
    pub(crate) vault: Vault,
    pub(crate) index: Mutex<Index>,
    pub(crate) sink: Sink,
}

impl std::fmt::Debug for VaultSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultSession")
            .field("root", &self.vault.root())
            .finish()
    }
}

/// What reading one changed file produced.
pub(crate) enum Loaded {
    /// Same content hash as stored: only the stat changed.
    StatOnly(FileRow),
    Page(FileRow, Box<PageMeta>),
    Attachment(FileRow),
}

pub(crate) fn is_page_path(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("md"))
}

/// Index database path for a vault: `<cache_root>/liber/<cache_dir_name>/index.sqlite`.
pub fn index_db_path(cache_root: &Path, vault_root: &Path) -> PathBuf {
    cache_root
        .join("liber")
        .join(cache_dir_name(vault_root))
        .join("index.sqlite")
}

impl VaultSession {
    /// Opens `root` (writing nothing inside it), opens its index under
    /// `cache_root`, and brings the index up to date (spec §6.2).
    pub fn open(
        root: &Path,
        cache_root: &Path,
        sink: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<(VaultSession, IndexReport)> {
        let vault = Vault::open(root)?;
        let index = Index::open(&index_db_path(cache_root, vault.root()))?;
        let session = VaultSession {
            vault,
            index: Mutex::new(index),
            sink: Arc::new(sink),
        };
        let report = session.reindex_all()?;
        Ok((session, report))
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    pub(crate) fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn emit(&self, event: SessionEvent) {
        (self.sink)(event);
    }

    /// Full incremental pass (spec §6.2).
    pub(crate) fn reindex_all(&self) -> Result<IndexReport> {
        let started = Instant::now();
        let scan = self.vault.scan()?;
        let mut report = IndexReport {
            warnings: self.vault.warnings().to_vec(),
            ..IndexReport::default()
        };
        report.warnings.extend(scan.skipped.iter().cloned());
        report.files = scan.entries.len();
        let stored = self.index().stats()?;
        let on_disk: HashSet<&str> = scan.entries.iter().map(|e| e.path.as_str()).collect();
        let removed: Vec<String> = stored
            .keys()
            .filter(|p| !on_disk.contains(p.as_str()))
            .cloned()
            .collect();

        let mut folders = Vec::new();
        let mut changed = Vec::new();
        for entry in &scan.entries {
            let old = stored.get(entry.path.as_str());
            match entry.kind {
                EntryKind::Dir => {
                    if old.is_none_or(|s| s.kind != FileKind::Folder) {
                        folders.push(folder_row(entry));
                    }
                }
                EntryKind::File => {
                    if old.is_some_and(|s| unchanged(s, entry)) {
                        report.skipped_unchanged += 1;
                    } else {
                        changed.push((entry.clone(), old.and_then(|s| s.hash.clone())));
                    }
                }
            }
        }

        let total = changed.len();
        let done = AtomicUsize::new(0);
        let warnings = Mutex::new(Vec::new());
        let loaded: Vec<Loaded> = changed
            .par_iter()
            .filter_map(|(entry, old_hash)| {
                let out = self.load(entry, old_hash.as_deref(), &mut warnings.lock().unwrap());
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n.is_multiple_of(PROGRESS_EVERY) || n == total {
                    self.emit(SessionEvent::Progress { done: n, total });
                }
                out
            })
            .collect();
        report.warnings.extend(warnings.into_inner().unwrap());

        report.parsed = loaded
            .iter()
            .filter(|l| !matches!(l, Loaded::StatOnly(_)))
            .count();
        report.removed = removed.len();

        {
            let mut index = self.index();
            for chunk in removed.chunks(BATCH_ROWS) {
                index.transaction(|tx| chunk.iter().try_for_each(|p| tx.remove(p)))?;
            }
            for chunk in folders.chunks(BATCH_ROWS) {
                index.transaction(|tx| chunk.iter().try_for_each(|r| tx.upsert_file(r)))?;
            }
            for chunk in loaded.chunks(BATCH_ROWS) {
                index.transaction(|tx| chunk.iter().try_for_each(|l| write_loaded(tx, l)))?;
            }
            let files = index.file_set()?;
            index.resolve_all(&files)?;
            report.pages = index.counts()?.1;
        }
        report.duration = started.elapsed();
        self.emit(SessionEvent::Indexed(report.clone()));
        Ok(report)
    }

    /// Reads, hashes and (for pages) parses one file. `None` if it vanished.
    pub(crate) fn load(
        &self,
        entry: &Entry,
        old_hash: Option<&str>,
        warnings: &mut Vec<String>,
    ) -> Option<Loaded> {
        let (bytes, hash) = match self.vault.read(&entry.path) {
            Ok(r) => r,
            Err(e) => {
                warnings.push(format!("{}: {e}", entry.path));
                return None;
            }
        };
        let page = is_page_path(entry.path.as_str());
        let mut row = FileRow {
            path: entry.path.to_string(),
            kind: if page {
                FileKind::Page
            } else {
                FileKind::Attachment
            },
            mtime_ns: clamp_ns(entry.mtime_ns),
            size: entry.size,
            hash: Some(hash.to_hex()),
        };
        if old_hash == Some(hash.to_hex().as_str()) {
            if page && std::str::from_utf8(&bytes).is_err() {
                row.kind = FileKind::Attachment;
            }
            return Some(Loaded::StatOnly(row));
        }
        if !page {
            return Some(Loaded::Attachment(row));
        }
        match String::from_utf8(bytes) {
            Ok(text) => {
                let meta = parse_page(&text, entry.path.stem());
                if let Some(err) = &meta.frontmatter_error {
                    warnings.push(format!("{}: frontmatter: {err}", entry.path));
                }
                Some(Loaded::Page(row, Box::new(meta)))
            }
            Err(_) => {
                warnings.push(format!(
                    "{}: not valid UTF-8, indexed as attachment",
                    entry.path
                ));
                row.kind = FileKind::Attachment;
                Some(Loaded::Attachment(row))
            }
        }
    }

    /// Re-stats `path` after the session wrote it and stores its page data.
    pub(crate) fn reindex_written(&self, path: &VaultPath, text: &str, hash: Hash) -> Result<()> {
        let entry = self
            .vault
            .stat(path)?
            .ok_or_else(|| SessionError::NotIndexed(path.to_string()))?;
        let row = FileRow {
            path: path.to_string(),
            kind: FileKind::Page,
            mtime_ns: clamp_ns(entry.mtime_ns),
            size: entry.size,
            hash: Some(hash.to_hex()),
        };
        let meta = parse_page(text, path.stem());
        self.index().transaction(|tx| {
            tx.upsert_file(&row)?;
            tx.upsert_page(&row.path, &meta)
        })?;
        Ok(())
    }

    // ---- reads ----

    pub fn tree(&self) -> Result<Vec<liber_index::TreeNode>> {
        Ok(self.index().tree()?)
    }

    pub fn page(&self, path: &VaultPath) -> Result<Option<liber_index::PageRow>> {
        Ok(self.index().page(path.as_str())?)
    }

    pub fn backlinks(&self, path: &VaultPath) -> Result<Vec<liber_index::LinkRow>> {
        Ok(self.index().backlinks(path.as_str())?)
    }

    // ---- operations ----

    /// Creates an empty page `name` (`.md` appended if missing) in `dir`.
    pub fn create_page(&self, dir: &VaultPath, name: &str) -> Result<VaultPath> {
        let name = validate_name(name)?;
        let file = if is_page_path(name) {
            name.to_string()
        } else {
            format!("{name}.md")
        };
        let path = dir.join(&file)?;
        let hash = self.vault.write_cas(&path, b"", None)?;
        self.reindex_written(&path, "", hash)?;
        let mut index = self.index();
        let files = index.file_set()?;
        index.resolve_affected(&files, &[link_key(path.as_str())])?;
        Ok(path)
    }

    pub fn create_folder(&self, parent: &VaultPath, name: &str) -> Result<VaultPath> {
        let path = parent.join(validate_name(name)?)?;
        self.vault.create_dir(&path)?;
        let entry = self
            .vault
            .stat(&path)?
            .ok_or_else(|| SessionError::NotIndexed(path.to_string()))?;
        self.index()
            .transaction(|tx| tx.upsert_file(&folder_row(&entry)))?;
        Ok(path)
    }

    /// Moves a file or folder to the OS trash (EXP-03). Links to it become unresolved.
    pub fn trash(&self, path: &VaultPath) -> Result<()> {
        let mut index = self.index();
        let keys: Vec<String> = index
            .file_set()?
            .iter()
            .filter(|p| VaultPath::new(p).is_ok_and(|vp| vp.starts_with(path)))
            .map(|p| link_key(p))
            .collect();
        self.vault.trash(path)?;
        index.transaction(|tx| tx.remove(path.as_str()))?;
        let files = index.file_set()?;
        index.resolve_affected(&files, &keys)?;
        Ok(())
    }
}

pub(crate) fn write_loaded(tx: &liber_index::Tx<'_>, loaded: &Loaded) -> liber_index::Result<()> {
    match loaded {
        Loaded::StatOnly(row) | Loaded::Attachment(row) => tx.upsert_file(row),
        Loaded::Page(row, meta) => {
            tx.upsert_file(row)?;
            tx.upsert_page(&row.path, meta)
        }
    }
}

pub(crate) fn folder_row(entry: &Entry) -> FileRow {
    FileRow {
        path: entry.path.to_string(),
        kind: FileKind::Folder,
        mtime_ns: clamp_ns(entry.mtime_ns),
        size: 0,
        hash: None,
    }
}

pub(crate) fn unchanged(stat: &Stat, entry: &Entry) -> bool {
    stat.kind != FileKind::Folder
        && stat.mtime_ns == clamp_ns(entry.mtime_ns)
        && stat.size == entry.size
}

pub(crate) fn clamp_ns(ns: i128) -> i64 {
    ns.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// A single file or folder name: non-empty, no `/`, not hidden.
pub(crate) fn validate_name(name: &str) -> Result<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || is_hidden_name(trimmed)
    {
        return Err(SessionError::InvalidName(name.to_string()));
    }
    Ok(trimmed)
}
```

`crates/liber-session/src/lib.rs` (create or replace the whole file):

```rust
//! One open vault: indexing, watching and file operations, composed from
//! `liber-vault` (filesystem), `liber-markdown` (parsing) and `liber-index` (cache).

mod error;
mod events;
mod session;

pub use error::{Result, SessionError};
pub use events::{IndexReport, RenameOutcome, SessionEvent};
pub use session::{VaultSession, index_db_path};
```

- [ ] **Step 5: Run the tests, clippy and rustfmt**

Run: `cargo test -p liber-session && cargo clippy -p liber-session --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 8 integration tests (the case-only test returns early on case-insensitive filesystems)

- [ ] **Step 6: Commit**

```bash
git add Cargo.lock crates/liber-session
git commit -m "feat(session): open vault with incremental index, create and trash (VLT-02, PG-01, PG-05, EXP-03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: liber-session: rename/move with link rewriting

**Files:**
- Create: `crates/liber-session/src/rename.rs`
- Modify: `crates/liber-session/src/session.rs` (adds `subtree_files`), `src/lib.rs`
- Test: `crates/liber-session/tests/rename.rs`, `tests/rename_props.rs` (+ conflict-retry unit tests in `rename.rs`)

**Interfaces:**
- Consumes: Task 9 internals; Task 7 `resolve`, `shortest_unique_target`, `link_key`; Task 8 `links_into`, `links_by_key`, `Tx::rename`, `resolve_affected`, `resolve_from`.
- Produces: `VaultSession::rename(&self, from: &VaultPath, to: &VaultPath, rewrite_links: bool) -> Result<RenameOutcome>`; crate-internal `rename_with_hook(…, before_write: &dyn Fn(&VaultPath))`, `RenamePlan { old_files, new_files, moved }` with `edits_for(path_now, text) -> Vec<(Range<usize>, String)>`, `apply_edits(text, edits) -> String`, `session::subtree_files(&HashMap<String, Stat>, &VaultPath) -> Vec<String>`.

- [ ] **Step 1: Write the failing integration and property tests**

`crates/liber-session/tests/rename.rs` (create or replace the whole file):

```rust
use liber_session::{SessionError, SessionEvent, VaultSession};
use liber_testkit::{copy_fixture, snapshot};
use liber_vault::VaultPath;

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn session(fixture: &str) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
    let vault = copy_fixture(fixture);
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    (vault, cache, s)
}

fn read(dir: &tempfile::TempDir, p: &str) -> String {
    std::fs::read_to_string(dir.path().join(p)).unwrap()
}

/// Every resolved link target of every page, as (src, target).
fn all_targets(s: &VaultSession) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for node in s.tree().unwrap() {
        if let Some(page) = s.page(&vp(&node.path)).unwrap() {
            out.extend(
                page.links
                    .into_iter()
                    .map(|l| (node.path.clone(), l.target_path)),
            );
        }
    }
    out
}

#[test]
fn exp_04_rename_page_rewrites_wikilinks_related_and_markdown_links() {
    let (dir, _c, s) = session("obsidian-basic");
    let out = s
        .rename(
            &vp("Character Design/DMC/Sparda.md"),
            &vp("Character Design/DMC/Sparda the Dark Knight.md"),
            true,
        )
        .unwrap();
    assert!(out.failed.is_empty(), "{:?}", out.failed);
    assert_eq!(
        out.updated_files,
        vec![
            "Character Design/My characters.md",
            "Character Design/rex-draft.md"
        ]
    );
    assert_eq!(out.updated_links, 4);
    let mine = read(&dir, "Character Design/My characters.md");
    assert!(
        mine.contains("- [[Sparda the Dark Knight#Coat|the demon knight]]\n"),
        "{mine}"
    );
    assert!(
        mine.contains("- [[Sparda the Dark Knight]]\n"),
        "path form rewritten to shortest: {mine}"
    );
    let rex = read(&dir, "Character Design/rex-draft.md");
    assert!(
        rex.contains("  - \"[[Sparda the Dark Knight]]\"\n"),
        "{rex}"
    );
    assert!(
        rex.contains("[Sparda's page](DMC/Sparda%20the%20Dark%20Knight.md#Palette)"),
        "{rex}"
    );
    assert!(
        all_targets(&s)
            .iter()
            .all(|(_, t)| t.as_deref() != Some("Character Design/DMC/Sparda.md"))
    );
    assert_eq!(
        s.backlinks(&vp("Character Design/DMC/Sparda the Dark Knight.md"))
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn exp_04_rename_attachment_rewrites_cover_and_embeds() {
    let (dir, _c, s) = session("obsidian-basic");
    s.rename(
        &vp("Character Design/assets/rex-cover.png"),
        &vp("Character Design/assets/cover.png"),
        true,
    )
    .unwrap();
    s.rename(
        &vp("Character Design/assets/rex-turnaround.png"),
        &vp("Character Design/assets/turn.png"),
        true,
    )
    .unwrap();
    let rex = read(&dir, "Character Design/rex-draft.md");
    assert!(rex.contains("cover: assets/cover.png\n"), "{rex}");
    assert!(rex.contains("Turnaround: ![[turn.png]]\n"), "{rex}");
}

#[test]
fn exp_02_04_move_folder_rewrites_only_links_that_would_break() {
    let (dir, _c, s) = session("obsidian-basic");
    let before_mine = read(&dir, "Character Design/My characters.md");
    s.create_folder(&VaultPath::root(), "Archive").unwrap();
    let out = s
        .rename(&vp("Character Design/DMC"), &vp("Archive/DMC"), true)
        .unwrap();
    assert_eq!(
        out.moved,
        vec![(
            "Character Design/DMC/Sparda.md".into(),
            "Archive/DMC/Sparda.md".into()
        )]
    );
    assert_eq!(
        read(&dir, "Character Design/My characters.md"),
        before_mine,
        "[[Sparda]] and [[DMC/Sparda]] still resolve"
    );
    let rex = read(&dir, "Character Design/rex-draft.md");
    assert!(
        rex.contains("[Sparda's page](../Archive/DMC/Sparda.md#Palette)"),
        "{rex}"
    );
    assert!(rex.contains("  - \"[[Sparda]]\"\n"), "{rex}");
    assert!(dir.path().join("Archive/DMC/Sparda.md").is_file());
    assert_eq!(
        s.page(&vp("Archive/DMC/Sparda.md")).unwrap().unwrap().links[0]
            .target_path
            .as_deref(),
        Some("Character Design/My characters.md")
    );
}

#[test]
fn exp_04_moving_a_page_fixes_its_own_relative_links() {
    let (dir, _c, s) = session("obsidian-basic");
    s.rename(
        &vp("Character Design/rex-draft.md"),
        &vp("Game Design/rex-draft.md"),
        true,
    )
    .unwrap();
    let rex = read(&dir, "Game Design/rex-draft.md");
    assert!(
        rex.contains("cover: ../Character Design/assets/rex-cover.png\n"),
        "{rex}"
    );
    assert!(
        rex.contains("[Sparda's page](../Character%20Design/DMC/Sparda.md#Palette)"),
        "{rex}"
    );
    assert!(
        rex.contains("[the game](</Game Design/Game 1.md>)"),
        "rooted link untouched: {rex}"
    );
    assert!(
        rex.contains("[encoded](../Game%20Design/Game%201.md)"),
        "still resolves, untouched: {rex}"
    );
    assert!(
        rex.contains("![[rex-turnaround.png]]"),
        "name-based embed untouched"
    );
    let resolved: Vec<_> = s
        .page(&vp("Game Design/rex-draft.md"))
        .unwrap()
        .unwrap()
        .links
        .into_iter()
        .map(|l| l.target_path)
        .collect();
    assert!(resolved.iter().all(Option::is_some), "{resolved:?}");
    assert_eq!(
        s.backlinks(&vp("Game Design/rex-draft.md")).unwrap().len(),
        2,
        "[[rex-draft]] links still resolve"
    );
}

#[test]
fn exp_04_ambiguity_keeps_every_link_on_its_target() {
    let (dir, _c, s) = session("ambiguous-names");
    let out = s
        .rename(&vp("Archive/Old/Ideas.md"), &vp("Elsewhere/Ideas.md"), true)
        .unwrap();
    assert!(out.failed.is_empty());
    assert_eq!(
        read(&dir, "Elsewhere/Note.md"),
        "# Note\n\n[[/Ideas]]\n",
        "shadowed root file → rooted form"
    );
    let links = read(&dir, "Links.md");
    assert!(
        links.contains(
            "- [[Ideas]]\n- [[Projects/Ideas]]\n- [[Deep/Ideas]]\n- [[Elsewhere/Ideas]]\n"
        ),
        "{links}"
    );
    let t: Vec<_> = s
        .page(&vp("Elsewhere/Note.md"))
        .unwrap()
        .unwrap()
        .links
        .into_iter()
        .map(|l| l.target_path)
        .collect();
    assert_eq!(t, vec![Some("Ideas.md".to_string())]);
}

#[test]
fn exp_04_rewrite_disabled_only_moves() {
    let (dir, _c, s) = session("obsidian-basic");
    let before = snapshot(dir.path());
    let out = s
        .rename(
            &vp("Game Design/Game 1.md"),
            &vp("Game Design/Game One.md"),
            false,
        )
        .unwrap();
    assert!(out.updated_files.is_empty());
    let after = snapshot(dir.path());
    let changed: Vec<_> = before
        .keys()
        .filter(|k| after.get(*k) != before.get(*k))
        .collect();
    assert_eq!(
        changed.len(),
        2,
        "only the moved file and its folder mtime: {changed:?}"
    );
    assert_eq!(
        s.backlinks(&vp("Game Design/Game One.md")).unwrap().len(),
        0,
        "links now unresolved"
    );
}

#[test]
fn exp_02_case_only_rename_of_a_page() {
    let (dir, _c, s) = session("ambiguous-names");
    s.rename(&vp("Links.md"), &vp("links.md"), true).unwrap();
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(names.contains(&"links.md".to_string()) && !names.contains(&"Links.md".to_string()));
    assert!(s.page(&vp("links.md")).unwrap().is_some());
}

#[test]
fn rename_rejects_invalid_requests() {
    let (_d, _c, s) = session("obsidian-basic");
    assert!(matches!(
        s.rename(&vp("Character Design"), &vp("Character Design/DMC/x"), true),
        Err(SessionError::InvalidName(_))
    ));
    assert!(matches!(
        s.rename(&vp("nope.md"), &vp("x.md"), true),
        Err(SessionError::NotIndexed(_))
    ));
    assert!(matches!(
        s.rename(&vp("Welcome.md"), &vp("Game Design/Game 1.md"), true),
        Err(SessionError::Vault(_))
    ));
    assert!(matches!(
        s.rename(&vp("Welcome.md"), &vp("Welcome.md"), true),
        Err(SessionError::InvalidName(_))
    ));
}
```

`crates/liber-session/tests/rename_props.rs` (create or replace the whole file):

```rust
//! Property tests for rename-with-rewrite (spec §7.2): links keep their target,
//! and no byte outside a link target changes.

use liber_markdown::{FileSet, LinkKind, parse_page, shortest_unique_target};
use liber_session::{SessionEvent, VaultSession};
use liber_vault::VaultPath;
use proptest::prelude::*;
use std::collections::BTreeMap;

const FOLDERS: [&str; 4] = ["", "x", "x/y", "z"];
const NAMES: [&str; 4] = ["a", "b", "Ideas", "note c"];

fn path(folder: usize, name: usize) -> String {
    let f = FOLDERS[folder];
    if f.is_empty() {
        format!("{}.md", NAMES[name])
    } else {
        format!("{f}/{}.md", NAMES[name])
    }
}

#[derive(Debug, Clone)]
struct Case {
    files: Vec<(usize, usize)>,
    /// Per file: (target file index, markdown-style?).
    links: Vec<Vec<(usize, bool)>>,
    rename: (usize, usize, usize),
}

fn case() -> impl Strategy<Value = Case> {
    proptest::collection::btree_set((0..4usize, 0..4usize), 2..7)
        .prop_flat_map(|set| {
            let files: Vec<_> = set.into_iter().collect();
            let n = files.len();
            (
                Just(files),
                proptest::collection::vec(
                    proptest::collection::vec((0..n, any::<bool>()), 0..4),
                    n,
                ),
                (0..n, 0..4usize, 0..4usize),
            )
        })
        .prop_map(|(files, links, rename)| Case {
            files,
            links,
            rename,
        })
}

fn encode(s: &str) -> String {
    s.replace(' ', "%20")
}

/// Text outside link target ranges, in order.
fn segments(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut last = 0;
    for l in parse_page(text, "x").links {
        out.push(text[last..l.range.start].to_string());
        last = l.range.end;
    }
    out.push(text[last..].to_string());
    out
}

/// Builds the vault for `c`, renames `from` → `to` (file or folder), and checks
/// every page's targets (mapped through `map`) and its bytes outside links.
fn check(
    c: &Case,
    from: &str,
    to: &str,
    map: &dyn Fn(&str) -> String,
) -> Result<(), TestCaseError> {
    let paths: Vec<String> = c.files.iter().map(|&(f, n)| path(f, n)).collect();
    let set = FileSet::new(paths.iter().cloned());
    let vault = tempfile::tempdir().unwrap();
    for f in &FOLDERS[1..] {
        std::fs::create_dir_all(vault.path().join(f)).unwrap();
    }
    let mut texts = BTreeMap::new();
    for (i, src) in paths.iter().enumerate() {
        let mut text = format!("# Page {i}\n\nIntro text.\n");
        for &(t, md) in &c.links[i] {
            if md {
                let dest = shortest_unique_target(&paths[t], src, &set, LinkKind::Markdown, false);
                text.push_str(&format!("- see [link]({}) here\n", encode(&dest)));
            } else {
                let dest = shortest_unique_target(&paths[t], src, &set, LinkKind::Wiki, false);
                text.push_str(&format!("- see [[{dest}|alias]] here\n"));
            }
        }
        std::fs::write(vault.path().join(src), &text).unwrap();
        texts.insert(src.clone(), text);
    }
    let cache = tempfile::tempdir().unwrap();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
    let expected: BTreeMap<String, Vec<Option<String>>> = paths
        .iter()
        .map(|p| {
            (
                p.clone(),
                s.page(&VaultPath::new(p).unwrap())
                    .unwrap()
                    .unwrap()
                    .links
                    .into_iter()
                    .map(|l| l.target_path)
                    .collect(),
            )
        })
        .collect();
    prop_assert!(
        expected.values().flatten().all(Option::is_some),
        "generated links resolve"
    );

    if let Some(parent) = std::path::Path::new(to).parent() {
        std::fs::create_dir_all(vault.path().join(parent)).unwrap();
    }
    let out = s
        .rename(
            &VaultPath::new(from).unwrap(),
            &VaultPath::new(to).unwrap(),
            true,
        )
        .unwrap();
    prop_assert!(out.failed.is_empty(), "{:?}", out.failed);

    for (old, want) in &expected {
        let now = map(old);
        let page = s.page(&VaultPath::new(&now).unwrap()).unwrap().unwrap();
        let got: Vec<_> = page.links.into_iter().map(|l| l.target_path).collect();
        let want: Vec<_> = want.iter().map(|t| t.as_deref().map(map)).collect();
        prop_assert_eq!(&got, &want, "targets of {}", now);
        let after = std::fs::read_to_string(vault.path().join(&now)).unwrap();
        prop_assert_eq!(
            segments(&texts[old]),
            segments(&after),
            "bytes outside links of {}",
            now
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]
    #[test]
    fn exp_04_file_rename_preserves_targets_and_bytes(c in case()) {
        let paths: Vec<String> = c.files.iter().map(|&(f, n)| path(f, n)).collect();
        let (file_idx, new_folder, new_name) = c.rename;
        let to = path(new_folder, new_name);
        prop_assume!(!paths.contains(&to));
        let from = paths[file_idx].clone();
        let map = |p: &str| if p == from { to.clone() } else { p.to_string() };
        check(&c, &from, &to, &map)?;
    }

    #[test]
    fn exp_04_folder_move_preserves_targets_and_bytes(c in case()) {
        let paths: Vec<String> = c.files.iter().map(|&(f, n)| path(f, n)).collect();
        prop_assume!(paths.iter().any(|p| p.starts_with("x/")));
        let map = |p: &str| match p.strip_prefix("x/") {
            Some(rest) => format!("z/moved/{rest}"),
            None => p.to_string(),
        };
        check(&c, "x", "z/moved", &map)?;
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p liber-session --test rename`

Expected: FAIL: compile error `no method named rename found for struct VaultSession`

- [ ] **Step 3: Implement**

In `crates/liber-session/src/session.rs`, replace:

```rust
use std::collections::HashSet;
```

with:

```rust
use std::collections::{HashMap, HashSet};
```

In `crates/liber-session/src/session.rs`, replace:

```rust
    Ok(trimmed)
}
```

with:

```rust
    Ok(trimmed)
}

/// Paths of every file at or below `path` in `stats` (for folder moves).
pub(crate) fn subtree_files(stats: &HashMap<String, Stat>, path: &VaultPath) -> Vec<String> {
    let mut out: Vec<String> = stats
        .iter()
        .filter(|(p, s)| {
            s.kind != FileKind::Folder && VaultPath::new(p).is_ok_and(|vp| vp.starts_with(path))
        })
        .map(|(p, _)| p.clone())
        .collect();
    out.sort();
    out
}
```

`crates/liber-session/src/rename.rs` (create or replace the whole file):

```rust
use crate::error::{Result, SessionError};
use crate::events::RenameOutcome;
use crate::session::{VaultSession, is_page_path, subtree_files};
use liber_markdown::{FileSet, LinkKind, link_key, parse_page, resolve, shortest_unique_target};
use liber_vault::{VaultError, VaultPath};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use std::collections::{BTreeSet, HashMap};
use std::ops::Range;

const MAX_ATTEMPTS: usize = 3;

/// Characters %-encoded when rewriting an encoded Markdown destination.
const PATH_ENCODE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

/// The old and new view of the vault for one rename.
pub(crate) struct RenamePlan {
    pub old_files: FileSet,
    pub new_files: FileSet,
    /// Old path → new path for every moved file.
    pub moved: HashMap<String, String>,
}

impl RenamePlan {
    pub(crate) fn map<'a>(&'a self, path: &'a str) -> &'a str {
        self.moved.get(path).map(String::as_str).unwrap_or(path)
    }

    /// Old path of a file given its path after the move.
    fn unmap<'a>(&'a self, new_path: &'a str) -> &'a str {
        self.moved
            .iter()
            .find(|(_, n)| n.as_str() == new_path)
            .map(|(o, _)| o.as_str())
            .unwrap_or(new_path)
    }

    /// Edits for one file's current text (`path_now` is its path after the move):
    /// every link that resolved before the move but would now resolve elsewhere
    /// is rewritten to the shortest text that points at the moved target again.
    pub(crate) fn edits_for(&self, path_now: &str, text: &str) -> Vec<(Range<usize>, String)> {
        let old_src = self.unmap(path_now);
        let stem = path_now
            .rsplit('/')
            .next()
            .unwrap_or(path_now)
            .trim_end_matches(".md");
        let mut edits = Vec::new();
        for link in parse_page(text, stem).links {
            let Some(before) = resolve(link.kind, &link.target, old_src, &self.old_files) else {
                continue; // unresolved links are left alone
            };
            let want = self.map(&before);
            if resolve(link.kind, &link.target, path_now, &self.new_files).as_deref() == Some(want)
            {
                continue;
            }
            let rooted = !link.kind.is_wiki_style() && link.target.starts_with('/');
            let mut new_text =
                shortest_unique_target(want, path_now, &self.new_files, link.kind, rooted);
            // Markdown destinations keep their style: %-encoded stays encoded;
            // a plain destination that now needs a space is %-encoded too
            // (wrapping in `<…>` would break a `#heading` suffix).
            let path_style = matches!(link.kind, LinkKind::Markdown | LinkKind::MarkdownImage);
            if link.encoded || (path_style && !link.angle && new_text.contains(' ')) {
                new_text = utf8_percent_encode(&new_text, PATH_ENCODE).to_string();
            }
            if text[link.range.clone()] != new_text {
                edits.push((link.range, new_text));
            }
        }
        edits
    }
}

/// Applies non-overlapping edits from the end of the text to the start.
pub(crate) fn apply_edits(text: &str, edits: &[(Range<usize>, String)]) -> String {
    let mut out = text.to_string();
    let mut sorted: Vec<_> = edits.iter().collect();
    sorted.sort_by_key(|e| std::cmp::Reverse(e.0.start));
    for (range, new) in sorted {
        out.replace_range(range.clone(), new);
    }
    out
}

impl VaultSession {
    /// Renames or moves a page, attachment or folder (EXP-02). With
    /// `rewrite_links`, every reference that would otherwise change target is
    /// rewritten (EXP-04, spec §6.4). The move happens first; files that cannot
    /// be rewritten are reported in `failed`.
    pub fn rename(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        rewrite_links: bool,
    ) -> Result<RenameOutcome> {
        self.rename_with_hook(from, to, rewrite_links, &|_| {})
    }

    pub(crate) fn rename_with_hook(
        &self,
        from: &VaultPath,
        to: &VaultPath,
        rewrite_links: bool,
        before_write: &dyn Fn(&VaultPath),
    ) -> Result<RenameOutcome> {
        if from.is_root() || to.is_root() || from == to {
            return Err(SessionError::InvalidName(format!(
                "cannot rename {from:?} to {to:?}"
            )));
        }
        if to.starts_with(from) {
            return Err(SessionError::InvalidName(format!(
                "cannot move {from} into itself"
            )));
        }
        let (plan, sources) = {
            let index = self.index();
            let stats = index.stats()?;
            if !stats.contains_key(from.as_str()) {
                return Err(SessionError::NotIndexed(from.to_string()));
            }
            let old_files = index.file_set()?;
            let moved: HashMap<String, String> = subtree_files(&stats, from)
                .into_iter()
                .map(|old| {
                    let new = VaultPath::new(&old)
                        .ok()
                        .and_then(|p| p.rebase(from, to))
                        .map(|p| p.to_string());
                    (old.clone(), new.unwrap_or(old))
                })
                .collect();
            let mut new_files = old_files.clone();
            for (old, new) in &moved {
                new_files.remove(old);
                new_files.insert(new.clone());
            }
            // Files whose links might change meaning: links into the moved
            // subtree, links whose key matches any moved name (old or new), and
            // the moved pages themselves (their folder changed).
            let mut keys: Vec<String> = moved
                .iter()
                .flat_map(|(o, n)| [link_key(o), link_key(n)])
                .collect();
            keys.sort();
            keys.dedup();
            let mut sources: BTreeSet<String> = BTreeSet::new();
            sources.extend(index.links_into(from.as_str())?.into_iter().map(|l| l.src));
            sources.extend(index.links_by_key(&keys)?.into_iter().map(|l| l.src));
            sources.extend(moved.keys().filter(|p| is_page_path(p)).cloned());
            (
                RenamePlan {
                    old_files,
                    new_files,
                    moved,
                },
                sources,
            )
        };

        self.vault.rename(from, to)?;
        self.index()
            .transaction(|tx| tx.rename(from.as_str(), to.as_str()))?;

        let mut outcome = RenameOutcome {
            moved: {
                let mut m: Vec<_> = plan
                    .moved
                    .iter()
                    .map(|(o, n)| (o.clone(), n.clone()))
                    .collect();
                m.sort();
                m
            },
            ..RenameOutcome::default()
        };
        if rewrite_links {
            for src in &sources {
                let now = VaultPath::new(plan.map(src))?;
                match self.rewrite_file(&plan, &now, before_write) {
                    Ok(0) => {}
                    Ok(n) => {
                        outcome.updated_links += n;
                        outcome.updated_files.push(now.to_string());
                    }
                    Err(e) => outcome.failed.push((now.to_string(), e.to_string())),
                }
            }
        }

        let mut index = self.index();
        let files = index.file_set()?;
        let keys: Vec<String> = plan
            .moved
            .iter()
            .flat_map(|(o, n)| [link_key(o), link_key(n)])
            .collect();
        index.resolve_affected(&files, &keys)?;
        for path in plan.moved.values().chain(outcome.updated_files.iter()) {
            index.resolve_from(&files, path)?;
        }
        Ok(outcome)
    }

    /// Rewrites one file's links with compare-and-swap, re-reading and
    /// re-planning on conflict (max 3 attempts). Returns the number of edits.
    fn rewrite_file(
        &self,
        plan: &RenamePlan,
        path: &VaultPath,
        before_write: &dyn Fn(&VaultPath),
    ) -> Result<usize> {
        let mut last = None;
        for _ in 0..MAX_ATTEMPTS {
            let (text, hash) = self.vault.read_to_string(path)?;
            let edits = plan.edits_for(path.as_str(), &text);
            if edits.is_empty() {
                return Ok(0);
            }
            let new_text = apply_edits(&text, &edits);
            before_write(path);
            match self.vault.write_cas(path, new_text.as_bytes(), Some(hash)) {
                Ok(new_hash) => {
                    self.reindex_written(path, &new_text, new_hash)?;
                    return Ok(edits.len());
                }
                Err(e @ VaultError::Conflict { .. }) => last = Some(e),
                Err(e) => return Err(e.into()),
            }
        }
        Err(last.expect("loop ran").into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::SessionEvent;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn session(fixture: &str) -> (tempfile::TempDir, tempfile::TempDir, VaultSession) {
        let vault = liber_testkit::copy_fixture(fixture);
        let cache = tempfile::tempdir().unwrap();
        let (s, _) = VaultSession::open(vault.path(), cache.path(), |_: SessionEvent| {}).unwrap();
        (vault, cache, s)
    }

    fn vp(s: &str) -> VaultPath {
        VaultPath::new(s).unwrap()
    }

    #[test]
    fn apply_edits_from_the_end() {
        let text = "a [[x]] b [[y]]";
        assert_eq!(
            apply_edits(text, &[(4..5, "XX".into()), (12..13, "Y".into())]),
            "a [[XX]] b [[Y]]"
        );
    }

    #[test]
    fn exp_04_conflict_is_retried_with_fresh_content() {
        let (dir, _c, s) = session("ambiguous-names");
        let calls = AtomicUsize::new(0);
        let hook = |p: &VaultPath| {
            if p.as_str() == "Links.md" && calls.fetch_add(1, Ordering::SeqCst) == 0 {
                let full = dir.path().join("Links.md");
                let text = std::fs::read_to_string(&full).unwrap();
                std::fs::write(&full, format!("{text}- added by someone else [[Ideas]]\n"))
                    .unwrap();
            }
        };
        let out = s
            .rename_with_hook(&vp("Ideas.md"), &vp("Root Ideas.md"), true, &hook)
            .unwrap();
        assert!(out.failed.is_empty(), "{:?}", out.failed);
        let text = std::fs::read_to_string(dir.path().join("Links.md")).unwrap();
        assert!(
            text.contains("added by someone else [[Root Ideas]]"),
            "{text}"
        );
        assert!(text.starts_with("# Links\n\n- [[Root Ideas]]"), "{text}");
    }

    #[test]
    fn exp_04_persistent_conflict_is_reported_not_fatal() {
        let (dir, _c, s) = session("ambiguous-names");
        let hook = |p: &VaultPath| {
            if p.as_str() == "Links.md" {
                let full = dir.path().join("Links.md");
                let text = std::fs::read_to_string(&full).unwrap();
                std::fs::write(&full, format!("{text}x")).unwrap();
            }
        };
        let out = s
            .rename_with_hook(&vp("Ideas.md"), &vp("Root Ideas.md"), true, &hook)
            .unwrap();
        assert_eq!(out.failed.len(), 1);
        assert_eq!(out.failed[0].0, "Links.md");
        assert!(
            dir.path().join("Root Ideas.md").exists(),
            "the move itself succeeded"
        );
    }
}
```

`crates/liber-session/src/lib.rs` (create or replace the whole file):

```rust
//! One open vault: indexing, watching and file operations, composed from
//! `liber-vault` (filesystem), `liber-markdown` (parsing) and `liber-index` (cache).

mod error;
mod events;
mod rename;
mod session;

pub use error::{Result, SessionError};
pub use events::{IndexReport, RenameOutcome, SessionEvent};
pub use session::{VaultSession, index_db_path};
```

- [ ] **Step 4: Run the tests, clippy and rustfmt**

Run: `cargo test -p liber-session && cargo clippy -p liber-session --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 3 unit + 8 open + 8 rename + 2 property tests (48 random vaults each)

- [ ] **Step 5: Commit**

```bash
git add crates/liber-session
git commit -m "feat(session): rename and move with link rewriting (EXP-02, EXP-04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: liber-session: applying watcher events (external changes)

**Files:**
- Create: `crates/liber-session/src/watching.rs`
- Modify: `crates/liber-session/src/session.rs` (watcher field; `reindex_all` also returns the changed paths), `src/lib.rs`
- Test: `crates/liber-session/tests/watching.rs`

**Interfaces:**
- Consumes: Task 4 `Vault::watch`, `WatchEvent`; Task 2 `list_dir`, `scan_from`, `stat`; Task 9 internals.
- Produces: `VaultSession::start_watching(self: &Arc<Self>) -> Result<()>`, `stop_watching(&self)`, `apply(&self, events: Vec<WatchEvent>) -> Result<()>`; `reindex_all()` now returns `(IndexReport, Changes)` with `pub(crate) struct Changes { created, modified, removed: Vec<String> }`.

- [ ] **Step 1: Write the failing integration tests**

`crates/liber-session/tests/watching.rs` (create or replace the whole file):

```rust
use liber_session::{SessionEvent, VaultSession};
use liber_testkit::{copy_fixture, wait_until};
use liber_vault::{VaultPath, WatchEvent};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Events = Arc<Mutex<Vec<SessionEvent>>>;
const WAIT: Duration = Duration::from_secs(5);

fn vp(s: &str) -> VaultPath {
    VaultPath::new(s).unwrap()
}

fn watched(
    fixture: &str,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    Arc<VaultSession>,
    Events,
) {
    let vault = copy_fixture(fixture);
    let cache = tempfile::tempdir().unwrap();
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), move |e| {
        sink.lock().unwrap().push(e)
    })
    .unwrap();
    let s = Arc::new(s);
    s.start_watching().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    events.lock().unwrap().clear();
    (vault, cache, s, events)
}

fn changed(events: &Events) -> Vec<SessionEvent> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, SessionEvent::Changed { .. }))
        .cloned()
        .collect()
}

#[test]
fn vlt_04_external_create_modify_delete_update_the_index() {
    let (dir, _c, s, events) = watched("obsidian-basic");
    std::fs::write(
        dir.path().join("Character Design/Generator Rex.md"),
        "# Generator Rex 2\n",
    )
    .unwrap();
    assert!(wait_until(WAIT, || s
        .page(&vp("Character Design/Generator Rex.md"))
        .unwrap()
        .is_some()));
    assert!(
        wait_until(WAIT, || {
            s.page(&vp("Character Design/My characters.md"))
                .unwrap()
                .unwrap()
                .links[1]
                .target_path
                .as_deref()
                == Some("Character Design/Generator Rex.md")
        }),
        "waiting link resolved"
    );
    std::fs::write(dir.path().join("Welcome.md"), "# Hello again\n").unwrap();
    assert!(wait_until(WAIT, || s
        .page(&vp("Welcome.md"))
        .unwrap()
        .unwrap()
        .title
        == "Hello again"));
    std::fs::remove_file(dir.path().join("Game Design/notes.txt")).unwrap();
    assert!(wait_until(WAIT, || !s
        .tree()
        .unwrap()
        .iter()
        .any(|n| n.path == "Game Design/notes.txt")));
    let all = changed(&events);
    let flat = format!("{all:?}");
    assert!(
        flat.contains("Generator Rex.md")
            && flat.contains("Welcome.md")
            && flat.contains("notes.txt"),
        "{flat}"
    );
}

#[test]
fn vlt_04_external_rename_moves_rows_without_rewriting_links() {
    let (dir, _c, s, events) = watched("obsidian-basic");
    let before = std::fs::read_to_string(dir.path().join("Character Design/rex-draft.md")).unwrap();
    std::fs::rename(
        dir.path().join("Game Design/Game 1.md"),
        dir.path().join("Game Design/Game One.md"),
    )
    .unwrap();
    assert!(wait_until(WAIT, || s
        .page(&vp("Game Design/Game One.md"))
        .unwrap()
        .is_some()));
    assert!(
        wait_until(WAIT, || s
            .page(&vp("Game Design/Game 1.md"))
            .unwrap()
            .is_none()),
        "old name noticed"
    );
    assert!(wait_until(WAIT, || format!("{:?}", changed(&events))
        .contains(
            "(\"Game Design/Game 1.md\", \"Game Design/Game One.md\")"
        )));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("Character Design/rex-draft.md")).unwrap(),
        before
    );
    assert!(
        s.backlinks(&vp("Game Design/Game One.md"))
            .unwrap()
            .is_empty(),
        "links now unresolved, like Obsidian"
    );
}

#[test]
fn vlt_04_own_writes_are_not_reported_as_external_changes() {
    let (_dir, _c, s, events) = watched("obsidian-basic");
    s.create_page(&VaultPath::root(), "Fresh").unwrap();
    s.rename(
        &vp("Character Design/DMC/Sparda.md"),
        &vp("Character Design/DMC/Sparda2.md"),
        true,
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(changed(&events), Vec::new());
}

#[test]
fn vlt_04_overflow_triggers_full_rescan() {
    let vault = copy_fixture("ambiguous-names");
    let cache = tempfile::tempdir().unwrap();
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let (s, _) = VaultSession::open(vault.path(), cache.path(), move |e| {
        sink.lock().unwrap().push(e)
    })
    .unwrap();
    std::fs::write(vault.path().join("Unseen.md"), "# unseen").unwrap();
    s.apply(vec![WatchEvent::Overflow]).unwrap();
    assert!(s.page(&vp("Unseen.md")).unwrap().is_some());
    assert!(format!("{:?}", changed(&events)).contains("Unseen.md"));
}

#[test]
fn review_focus_git_checkout_like_burst_converges() {
    let (dir, _c, s, _events) = watched("ambiguous-names");
    std::fs::create_dir(dir.path().join("Imported")).unwrap();
    for i in 0..300 {
        std::fs::write(
            dir.path().join(format!("Imported/n{i}.md")),
            format!("# N{i}\n\n[[Ideas]]"),
        )
        .unwrap();
    }
    std::fs::remove_dir_all(dir.path().join("Archive")).unwrap();
    std::fs::rename(
        dir.path().join("Links.md"),
        dir.path().join("Imported/Links.md"),
    )
    .unwrap();
    let expected = s.vault().scan().unwrap().entries.len();
    assert!(
        wait_until(Duration::from_secs(15), || s.tree().unwrap().len()
            == expected),
        "index converges to disk"
    );
    assert!(s.page(&vp("Imported/n299.md")).unwrap().is_some());
    assert!(s.page(&vp("Archive/Old/Ideas.md")).unwrap().is_none());
    assert_eq!(s.backlinks(&vp("Ideas.md")).unwrap().len(), 300 + 1 + 1);
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p liber-session --test watching`

Expected: FAIL: compile errors `no method named start_watching / apply`

- [ ] **Step 3: Implement: seven edits in `session.rs`, then the new module**

In `crates/liber-session/src/session.rs`, replace:

```rust
use liber_vault::{Entry, EntryKind, Hash, Vault, VaultPath, is_hidden_name};
```

with:

```rust
use liber_vault::{Entry, EntryKind, Hash, Vault, VaultPath, Watcher, is_hidden_name};
```

In `crates/liber-session/src/session.rs`, replace:

```rust
    pub(crate) sink: Sink,
}
```

with:

```rust
    pub(crate) sink: Sink,
    pub(crate) watcher: Mutex<Option<Watcher>>,
}
```

In `crates/liber-session/src/session.rs`, replace:

```rust
            sink: Arc::new(sink),
        };
        let report = session.reindex_all()?;
```

with:

```rust
            sink: Arc::new(sink),
            watcher: Mutex::new(None),
        };
        let (report, _) = session.reindex_all()?;
```

In `crates/liber-session/src/session.rs`, replace:

```rust
    /// Full incremental pass (spec §6.2).
    pub(crate) fn reindex_all(&self) -> Result<IndexReport> {
```

with:

```rust
    /// Full incremental pass (open and watcher overflow). Returns the report and
    /// the created/modified/removed paths.
    pub(crate) fn reindex_all(&self) -> Result<(IndexReport, Changes)> {
```

In `crates/liber-session/src/session.rs`, replace:

```rust
        report.parsed = loaded
            .iter()
            .filter(|l| !matches!(l, Loaded::StatOnly(_)))
            .count();
```

with:

```rust
        let mut changes = Changes {
            removed: removed.clone(),
            ..Changes::default()
        };
        for l in &loaded {
            let (path, is_new) = match l {
                Loaded::StatOnly(r) => (&r.path, false),
                Loaded::Page(r, _) | Loaded::Attachment(r) => {
                    (&r.path, !stored.contains_key(&r.path))
                }
            };
            if !matches!(l, Loaded::StatOnly(_)) {
                report.parsed += 1;
                if is_new {
                    changes.created.push(path.clone())
                } else {
                    changes.modified.push(path.clone())
                }
            }
        }
```

In `crates/liber-session/src/session.rs`, replace:

```rust
        Ok(report)
```

with:

```rust
        Ok((report, changes))
```

In `crates/liber-session/src/session.rs`, replace:

```rust
pub(crate) fn write_loaded
```

with:

```rust
/// Created/modified/removed paths of one pass.
#[derive(Debug, Default)]
pub(crate) struct Changes {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

pub(crate) fn write_loaded
```

`crates/liber-session/src/watching.rs` (create or replace the whole file):

```rust
use crate::error::Result;
use crate::events::SessionEvent;
use crate::session::{Loaded, VaultSession, folder_row, unchanged, write_loaded};
use liber_index::FileKind;
use liber_markdown::link_key;
use liber_vault::{EntryKind, VaultPath, WatchEvent};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

impl VaultSession {
    /// Starts applying external changes (VLT-04). The watcher holds only a weak
    /// reference, so dropping the last `Arc` stops it.
    pub fn start_watching(self: &Arc<Self>) -> Result<()> {
        let weak = Arc::downgrade(self);
        let watcher = self.vault.watch(move |batch| {
            if let Some(session) = weak.upgrade()
                && let Err(e) = session.apply(batch)
            {
                session.emit_warning(e.to_string());
            }
        })?;
        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
        Ok(())
    }

    pub fn stop_watching(&self) {
        self.watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }

    fn emit_warning(&self, message: String) {
        self.emit(SessionEvent::Indexed(crate::events::IndexReport {
            warnings: vec![message],
            ..Default::default()
        }));
    }

    /// Applies one watcher batch (spec §6.5). Paths are re-checked on disk and
    /// their parent folders reconciled, because some backends drop events
    /// (e.g. the old name of a rename on macOS). A change whose stat matches the
    /// index — including the session's own writes, which update the index
    /// synchronously — is a no-op and is not reported.
    pub fn apply(&self, events: Vec<WatchEvent>) -> Result<()> {
        if events.contains(&WatchEvent::Overflow) {
            let (_, changes) = self.reindex_all()?;
            self.emit_changed(
                changes.created,
                changes.modified,
                changes.removed,
                Vec::new(),
            );
            return Ok(());
        }
        let stats = self.index().stats()?;
        let mut dirty: BTreeSet<VaultPath> = BTreeSet::new();
        for ev in &events {
            if let WatchEvent::Changed(p) | WatchEvent::Removed(p) = ev {
                dirty.insert(p.clone());
            }
        }
        let parents: BTreeSet<VaultPath> = dirty.iter().filter_map(VaultPath::parent).collect();
        for dir in parents {
            let Ok(on_disk) = self.vault.list_dir(&dir) else {
                continue;
            };
            let disk: BTreeSet<String> = on_disk.iter().map(|e| e.path.to_string()).collect();
            dirty.extend(
                on_disk
                    .into_iter()
                    .map(|e| e.path)
                    .filter(|p| !stats.contains_key(p.as_str())),
            );
            for indexed in stats.keys() {
                let child_of_dir = match indexed.rfind('/') {
                    Some(i) => &indexed[..i] == dir.as_str(),
                    None => dir.is_root(),
                };
                if child_of_dir
                    && !disk.contains(indexed)
                    && let Ok(p) = VaultPath::new(indexed)
                {
                    dirty.insert(p);
                }
            }
        }

        let mut removed: Vec<String> = Vec::new();
        let mut folders = Vec::new();
        let mut loaded: Vec<(Loaded, bool)> = Vec::new();
        let mut warnings = Vec::new();
        for path in dirty {
            let old = stats.get(path.as_str());
            match (self.vault.stat(&path)?, old) {
                (None, Some(_)) => removed.push(path.to_string()),
                (None, None) => {}
                (Some(entry), old) if entry.kind == EntryKind::Dir => {
                    if old.is_none_or(|s| s.kind != FileKind::Folder) {
                        folders.push(folder_row(&entry));
                        for child in self.vault.scan_from(&path)?.entries {
                            if child.kind == EntryKind::Dir {
                                folders.push(folder_row(&child));
                            } else if let Some(l) = self.load(&child, None, &mut warnings) {
                                loaded.push((l, true));
                            }
                        }
                    }
                }
                (Some(entry), Some(old)) if unchanged(old, &entry) => {}
                (Some(entry), old) => {
                    if let Some(l) =
                        self.load(&entry, old.and_then(|s| s.hash.as_deref()), &mut warnings)
                    {
                        loaded.push((l, old.is_none()));
                    }
                }
            }
        }

        // A removed file and a new file with the same content hash is a rename
        // made by another program: move the index rows, do not rewrite links.
        let mut renamed: Vec<(String, String)> = Vec::new();
        let mut by_hash: HashMap<&str, &str> = HashMap::new();
        for p in &removed {
            if let Some(h) = stats.get(p).and_then(|s| s.hash.as_deref()) {
                by_hash.entry(h).or_insert(p);
            }
        }
        for (l, is_new) in &loaded {
            if let (true, Loaded::Page(row, _) | Loaded::Attachment(row)) = (is_new, l)
                && let Some(from) = row.hash.as_deref().and_then(|h| by_hash.remove(h))
            {
                renamed.push((from.to_string(), row.path.clone()));
            }
        }
        removed.retain(|p| !renamed.iter().any(|(from, _)| from == p));

        let mut created = Vec::new();
        let mut modified = Vec::new();
        for (l, is_new) in &loaded {
            let (Loaded::Page(row, _) | Loaded::Attachment(row)) = l else {
                continue;
            };
            if renamed.iter().any(|(_, to)| to == &row.path) {
                continue;
            }
            if *is_new {
                created.push(row.path.clone());
            } else {
                modified.push(row.path.clone());
            }
        }

        let mut index = self.index();
        index.transaction(|tx| {
            for (from, to) in &renamed {
                tx.rename(from, to)?;
            }
            for p in &removed {
                tx.remove(p)?;
            }
            for f in &folders {
                tx.upsert_file(f)?;
            }
            for (l, _) in &loaded {
                write_loaded(tx, l)?;
            }
            Ok(())
        })?;
        let files = index.file_set()?;
        let keys: Vec<String> = created
            .iter()
            .chain(&removed)
            .chain(renamed.iter().flat_map(|(a, b)| [a, b]))
            .map(|p| link_key(p))
            .collect();
        index.resolve_affected(&files, &keys)?;
        for p in created
            .iter()
            .chain(&modified)
            .chain(renamed.iter().map(|(_, to)| to))
        {
            index.resolve_from(&files, p)?;
        }
        drop(index);
        for w in warnings {
            self.emit_warning(w);
        }
        self.emit_changed(created, modified, removed, renamed);
        Ok(())
    }

    fn emit_changed(
        &self,
        created: Vec<String>,
        modified: Vec<String>,
        removed: Vec<String>,
        renamed: Vec<(String, String)>,
    ) {
        if created.is_empty() && modified.is_empty() && removed.is_empty() && renamed.is_empty() {
            return;
        }
        self.emit(SessionEvent::Changed {
            created,
            modified,
            removed,
            renamed,
        });
    }
}
```

`crates/liber-session/src/lib.rs` (create or replace the whole file):

```rust
//! One open vault: indexing, watching and file operations, composed from
//! `liber-vault` (filesystem), `liber-markdown` (parsing) and `liber-index` (cache).

mod error;
mod events;
mod rename;
mod session;
mod watching;

pub use error::{Result, SessionError};
pub use events::{IndexReport, RenameOutcome, SessionEvent};
pub use session::{VaultSession, index_db_path};
```

- [ ] **Step 4: Run the watching tests three times, then everything in the crate, clippy and rustfmt**

Run: `for i in 1 2 3; do cargo test -p liber-session --test watching || exit 1; done && cargo test -p liber-session && cargo clippy -p liber-session --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 5 watching tests in each run; whole crate green

- [ ] **Step 5: Commit**

```bash
git add crates/liber-session
git commit -m "feat(session): apply external changes from the watcher (VLT-04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Benchmarks (10k notes), full verification and the M1a hand-off

**Files:**
- Modify: `crates/liber-testkit/src/lib.rs` (vault generator), `crates/liber-session/Cargo.toml` (criterion + bench target)
- Create: `crates/liber-session/benches/vault.rs`, `docs/handoff/2026-10-12-m1a-vault-core-handoff.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `liber_testkit::VaultShape { notes, folders, max_depth, links_per_note, tags_per_note, attachments, hub_backlinks }` with `VaultShape::TEN_K`; `liber_testkit::generate_vault(root: &Path, shape: VaultShape, seed: u64) -> Vec<String>` (note paths; deterministic); criterion bench `vault` in `liber-session`; the M1a hand-off document.

- [ ] **Step 1: Add the deterministic generator (with its own test), criterion and the bench**

In `crates/liber-testkit/src/lib.rs`, replace:

```rust
    check()
}
```

with:

```rust
    check()
}

/// Shape of a generated benchmark vault (spec §7.3).
#[derive(Debug, Clone, Copy)]
pub struct VaultShape {
    pub notes: usize,
    pub folders: usize,
    pub max_depth: usize,
    pub links_per_note: usize,
    pub tags_per_note: usize,
    pub attachments: usize,
    /// Notes that link to `hub.md` (for the rename benchmark).
    pub hub_backlinks: usize,
}

impl VaultShape {
    /// The NFR-01 target: 10,000 notes.
    pub const TEN_K: VaultShape = VaultShape {
        notes: 10_000,
        folders: 400,
        max_depth: 6,
        links_per_note: 8,
        tags_per_note: 3,
        attachments: 1_000,
        hub_backlinks: 100,
    };
}

/// Tiny deterministic PRNG (xorshift64*), so generated vaults are identical
/// on every machine without extra dependencies.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Writes a deterministic vault into `root`: nested folders, notes with
/// frontmatter (half of them), wikilinks/embeds/Markdown links, tags,
/// attachments, and a `hub.md` with `hub_backlinks` backlinks. Returns the
/// vault-relative paths of the generated notes (index = note number).
pub fn generate_vault(root: &Path, shape: VaultShape, seed: u64) -> Vec<String> {
    let mut rng = Rng(seed.max(1));
    let mut folders = vec![String::new()];
    for i in 0..shape.folders {
        let parent = folders[rng.below(folders.len())].clone();
        let depth = if parent.is_empty() {
            0
        } else {
            parent.matches('/').count() + 1
        };
        let parent = if depth >= shape.max_depth {
            String::new()
        } else {
            parent
        };
        let name = if parent.is_empty() {
            format!("Folder {i}")
        } else {
            format!("{parent}/Folder {i}")
        };
        std::fs::create_dir_all(root.join(&name)).expect("create folder");
        folders.push(name);
    }
    let in_folder = |folder: &str, file: &str| {
        if folder.is_empty() {
            file.to_string()
        } else {
            format!("{folder}/{file}")
        }
    };
    let notes: Vec<String> = (0..shape.notes)
        .map(|i| in_folder(&folders[i % folders.len()], &format!("Note {i}.md")))
        .collect();
    let attachments: Vec<String> = (0..shape.attachments)
        .map(|i| in_folder(&folders[(i * 7) % folders.len()], &format!("image-{i}.png")))
        .collect();
    for a in &attachments {
        std::fs::write(root.join(a), b"PNG placeholder").expect("write attachment");
    }
    std::fs::write(
        root.join("hub.md"),
        "# Hub\n\nThe page everyone links to.\n",
    )
    .expect("write hub");
    for (i, path) in notes.iter().enumerate() {
        let mut text = String::new();
        if i % 2 == 0 {
            text.push_str(&format!(
                "---\nsubtitle: Generated note {i}\ntags: [gen, batch{}]\n---\n",
                i % 50
            ));
        }
        text.push_str(&format!(
            "# Note {i}\n\nGenerated paragraph with some words for the excerpt.\n\n"
        ));
        if i < shape.hub_backlinks {
            text.push_str("Back to [[hub]].\n");
        }
        for _ in 0..shape.links_per_note {
            let link = match rng.below(4) {
                0 | 1 => format!("[[Note {}]]", rng.below(shape.notes)),
                2 => format!("![[image-{}.png]]", rng.below(shape.attachments.max(1))),
                _ => format!("[x](</{}>)", notes[rng.below(shape.notes)]),
            };
            text.push_str(&format!("- {link}\n"));
        }
        for t in 0..shape.tags_per_note {
            text.push_str(&format!("#topic{} ", (i + t * 13) % 200));
        }
        text.push('\n');
        std::fs::write(root.join(path), text).expect("write note");
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_is_deterministic_and_shaped() {
        let shape = VaultShape {
            notes: 50,
            folders: 10,
            max_depth: 3,
            links_per_note: 4,
            tags_per_note: 2,
            attachments: 5,
            hub_backlinks: 3,
        };
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let notes = generate_vault(a.path(), shape, 7);
        assert_eq!(notes.len(), 50);
        assert!(a.path().join(&notes[49]).is_file());
        generate_vault(b.path(), shape, 7);
        let strip = |s: BTreeMap<PathBuf, (Vec<u8>, SystemTime)>| {
            s.into_iter().map(|(k, (v, _))| (k, v)).collect::<Vec<_>>()
        };
        assert_eq!(strip(snapshot(a.path())), strip(snapshot(b.path())));
        let files = strip(snapshot(a.path()))
            .into_iter()
            .filter(|(k, _)| k.extension().is_some_and(|e| e == "md"))
            .count();
        assert_eq!(files, 51, "50 notes + hub");
    }
}
```

`crates/liber-session/Cargo.toml` (create or replace the whole file):

```toml
[package]
name = "liber-session"
description = "One open vault: indexing, watching and file operations over liber-vault, liber-markdown and liber-index."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
liber-index = { path = "../liber-index" }
liber-markdown = { path = "../liber-markdown" }
liber-vault = { path = "../liber-vault" }
percent-encoding.workspace = true
rayon.workspace = true
thiserror.workspace = true

[dev-dependencies]
criterion.workspace = true
liber-testkit = { path = "../liber-testkit" }
proptest.workspace = true
tempfile.workspace = true

[[bench]]
name = "vault"
harness = false

[lints]
workspace = true
```

`crates/liber-session/benches/vault.rs` (create or replace the whole file):

```rust
//! NFR-03 benchmarks on a generated 10,000-note vault (spec §7.3).
//! Run: `cargo bench -p liber-session`. Targets: first index < 30 s,
//! single-file re-index < 100 ms. Results go in the M1a hand-off.

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use liber_session::{SessionEvent, VaultSession};
use liber_testkit::{VaultShape, generate_vault};
use liber_vault::{VaultPath, WatchEvent};
use std::time::Duration;

fn quiet(_: SessionEvent) {}

fn benches(c: &mut Criterion) {
    let vault = tempfile::tempdir().unwrap();
    let notes = generate_vault(vault.path(), VaultShape::TEN_K, 42);
    let mut group = c.benchmark_group("10k-notes");
    group
        .sample_size(10)
        .measurement_time(Duration::from_secs(60));

    group.bench_function("first full index", |b| {
        b.iter_batched(
            || tempfile::tempdir().unwrap(),
            |cache| VaultSession::open(vault.path(), cache.path(), quiet).unwrap(),
            BatchSize::PerIteration,
        )
    });

    let cache = tempfile::tempdir().unwrap();
    VaultSession::open(vault.path(), cache.path(), quiet).unwrap();
    group.bench_function("reopen, nothing changed", |b| {
        b.iter(|| VaultSession::open(vault.path(), cache.path(), quiet).unwrap())
    });

    let (session, _) = VaultSession::open(vault.path(), cache.path(), quiet).unwrap();
    let note = VaultPath::new(&notes[5]).unwrap();
    let mut n = 0u64;
    group.bench_function("re-index one modified file", |b| {
        b.iter(|| {
            n += 1;
            std::fs::write(
                vault.path().join(note.as_str()),
                format!("# Note 5 v{n}\n\n[[hub]] [[Note 6]]\n"),
            )
            .unwrap();
            session
                .apply(vec![WatchEvent::Changed(note.clone())])
                .unwrap();
        })
    });

    let hub = VaultPath::new("hub.md").unwrap();
    let renamed = VaultPath::new("hub renamed.md").unwrap();
    let mut flip = false;
    group.bench_function("rename page with 100 backlinks", |b| {
        b.iter(|| {
            let (from, to) = if flip {
                (&renamed, &hub)
            } else {
                (&hub, &renamed)
            };
            flip = !flip;
            let out = session.rename(from, to, true).unwrap();
            assert_eq!(out.updated_files.len(), 100);
        })
    });
    group.finish();
}

criterion_group!(m1a, benches);
criterion_main!(m1a);
```

- [ ] **Step 2: Check the generator test and that the bench compiles**

Run: `cargo test -p liber-testkit && cargo bench -p liber-session --bench vault --no-run && cargo clippy -p liber-testkit -p liber-session --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS: 1 generator test; bench binary builds

- [ ] **Step 3: Run the benchmarks (~5 minutes with default settings; `-- --quick` for a fast look). Copy the four `time:` lines into the hand-off**

Run: `cargo bench -p liber-session --bench vault`

Expected: Four results under `10k-notes/`. Reference run (Apple Silicon, `--quick`): first full index ≈ 1.1 s (budget < 30 s), reopen unchanged ≈ 0.15 s, re-index one file ≈ 11 ms (budget < 100 ms), rename with 100 backlinks ≈ 0.96 s

- [ ] **Step 4: Full repository check (also runs the M0 UI and desktop crate) and dependency policy**

Run: `pnpm check && cargo deny check`

Expected: PASS: everything green; cargo-deny `advisories ok, bans ok, licenses ok, sources ok` (it may warn about unused license allowances)

- [ ] **Step 5: Write the verbose M1a hand-off (user preference: detailed enough to continue by hand). Use the outline below; every section is required**

Create `docs/handoff/2026-10-12-m1a-vault-core-handoff.md` in the style of `docs/handoff/2026-10-12-m0-scaffold-handoff.md` (read it first). Required sections, in this order:

1. **Status at a glance**: what M1a delivers, test counts per crate (from the last `cargo test` output), benchmark table (the four `time:` lines from Step 3 with machine/OS noted, against NFR-03 budgets), what is not done (M1b: Tauri commands, settings store, explorer UI; M5 FTS; undo).
2. **Document map**: product spec, architecture doc, M1a design spec, this plan, M0 hand-off.
3. **Crate map**: one table row per crate (`liber-vault`, `liber-markdown`, `liber-index`, `liber-session`, `liber-testkit`) with its responsibility, public API (copy the signatures from this plan's Interfaces blocks), what it must never do (no Tauri; index never touches vault files; markdown has no I/O).
4. **How a vault is opened** (step by step through `VaultSession::open` → `Vault::open` → `Index::open` → `reindex_all`), where the cache lives (`index_db_path`), what makes reopening incremental, and why opening writes nothing.
5. **Link resolution rules** (spec §4.4 plus plan note 3) with the `ambiguous-names` fixture as the worked example.
6. **Rename/move algorithm** (spec §6.4 plus plan note 4): candidate selection, edit planning, move-then-rewrite order, conflict retry, `RenameOutcome`, why there is no undo.
7. **Watcher pipeline** (plan notes 1–2): `WatchEvent` classification, parent-folder reconciliation, hash-based rename detection, own-write suppression, Overflow.
8. **Recipes for M1b**: exposing a session operation as a Tauri command (thin wrapper, `index_db_path` with the OS cache dir, forwarding `SessionEvent` to the webview, `start_watching` needs `Arc<VaultSession>`), and adding a new extracted field (types → frontmatter/body → index column → schema version bump).
9. **Tests and fixtures inventory**: every test file with what it pins (requirement IDs), fixture vault contents, the test kit helpers, how to run focused tests, and which tests touch the OS trash.
10. **Rulings made on your behalf**: every "Plan note" below plus any ruling the executing controller recorded, each with what it costs if wrong.
11. **Known gaps / deferred**: (a) external *folder* renames are seen as remove + create (pages re-parsed, links re-resolve, no row move); (b) a file rewritten within the same mtime tick with the same size is treated as unchanged until the next real change (stat-based incremental indexing); (c) frontmatter values with YAML escapes are read but not rewritable; (d) `[[/Name]]` rooted form is an Obsidian-compatible extension only used when no suffix is unique; (e) no FTS (M5); (f) no undo for renames.
12. **Troubleshooting**: watcher tests flaky on a busy machine (they poll for 5–15 s), OS trash prompts on macOS, `cargo bench` duration, rebuilding the index (delete the cache folder), `cargo deny` license warnings.

- [ ] **Step 6: Commit**

```bash
git add Cargo.lock crates/liber-testkit crates/liber-session docs/handoff/2026-10-12-m1a-vault-core-handoff.md
git commit -m "feat(session): 10k-note benchmarks and M1a hand-off (NFR-01, NFR-03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Plan notes (rulings and deviations from the spec)

Each note was forced by evidence found while compile-checking the plan; the spec remains binding everywhere else.

1. **Watcher backend and event model (spec §3.3, §6.5).** The spec named notify-debouncer-full. On macOS, FSEvents reports deletes as metadata/content changes and merges "created" and "removed" flags for recently created files, and debouncer-full then cancels them out — a delete was never reported in testing. The plan uses **notify-debouncer-mini 0.7** (paths only, no cancellation) and classifies each path by what exists on disk now: `WatchEvent::{Changed, Removed, Overflow}` instead of `Created/Modified/Removed/Renamed/Overflow`. The session decides created vs. modified from the index, **reconciles the parent folder of every reported path** (because a rename can arrive as only the new name), and pairs removed/new files with the same content hash as external renames. Cost if wrong: one extra `read_dir` per touched folder per batch.
2. **Own-write suppression (spec §6.5).** Instead of a 2-second "recent own writes" table, every session operation updates the index synchronously, and `apply` skips a path whose disk stat (mtime, size) or content hash equals the index. Same effect for own writes, and an external edit made within 2 s of an own write is never missed. Cost if wrong: none observed (`vlt_04_own_writes_are_not_reported_as_external_changes`).
3. **Resolution details (spec §4.4).** (a) Rules (a) exact path and (b) relative path apply only to targets containing `/`; bare names go straight to the name search, otherwise a root `Ideas.md` would always beat a same-folder `Ideas.md` and the spec's own tie-break could never apply (Obsidian behaves this way). (b) `resolve` takes `(kind, target, source, files)` instead of `&LinkRef` so the index can call it from stored rows. (c) `shortest_unique_target` takes `rooted: bool`, and for wiki-style links falls back to a vault-rooted `[[/Name]]` when no path suffix is unique (a same-folder file shadows a root file); `resolve` understands that form. Cost if wrong: the rooted form is only emitted in that rare shadowing case.
4. **Markdown destinations (spec §6.4).** A plain (unencoded, not `<…>`) destination that needs a space is %-encoded rather than wrapped in `<…>`, because wrapping only the path would break a `#heading` suffix outside the range. Encoded destinations stay encoded; angle destinations stay angled.
5. **API additions** needed by later tasks: `Vault::scan` returns `Scan { entries, skipped }` (skipped symlinks/non-UTF-8 names are reported, not silently dropped); `scan_from`, `list_dir`, `stat`, `fs_path`; `VaultError::Watch`; `TMP_MARKER`; `Index::open_in_memory`, `stats`, `links_from`, `resolve_from`, `counts` and the `Tx` transaction type; `index_db_path`; `VaultSession::vault`, `stop_watching`; `start_watching` takes `self: &Arc<Self>` (the watcher holds a weak reference).
6. **Session events.** `create_page`, `create_folder`, `rename` and `trash` return their results and do not emit `Changed`; `Changed` is reserved for external changes from the watcher (M1b refreshes the tree after its own calls).
7. **Test infrastructure.** New test-only crate `liber-testkit`. Trash tests copy fixtures into `$HOME/liber-trash-test-*` because on Linux the system temp dir is often on a different filesystem than `~/.local/share/Trash` (each run leaves one such folder in your OS trash).
8. **Fixtures (spec §7.1).** `.trash/` stands in for the `.git/` stub (git cannot commit a nested `.git`); NFD file names are tested at runtime because git on macOS re-normalizes committed names; `.gitattributes` (`fixtures/** -text`) keeps CRLF and invalid UTF-8 bytes exact; fixtures are excluded from Prettier.
9. **Spec §2.1 dependency table.** `notify` is reached through `notify_debouncer_mini::notify` (guaranteed matching version); `serde`/`serde_json` come from the existing workspace entries.

## Self-review

- **Spec coverage:** §1 criteria 1–7 → Tasks 2/9 (VLT-02), 5–7 + 9 (PG-01/04/05), 4 + 11 (VLT-04), 10 (EXP-02/04), 3 + 9 (EXP-03), 12 (NFR-01/03), all headless. §3 → Tasks 1–4; §4 → Tasks 5–7; §5 → Task 8; §6.1–6.3 → Task 9; §6.4 → Task 10; §6.5 → Task 11; §6.6 → Task 9; §7.1 → Task 2; §7.2 → tests listed per task; §7.3 → Task 12; §8 respected (no task touches Tauri, UI, FTS, layout or `.liber/vault.json` writes).
- **Placeholders:** none; every code step contains the complete file or an exact replace/with pair, and every command has its expected result.
- **Type consistency:** checked mechanically — the replay compiled each task's code against the previous tasks' real code.
- **Review Focus:** five items above, each with a named test in its owning task.
