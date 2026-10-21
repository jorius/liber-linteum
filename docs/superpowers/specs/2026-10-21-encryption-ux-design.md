# Encryption UX round: design

Status: **approved by Jose** (2026-10-21, "Everything looks fine, continue"). Mocks: brainstorm companion, `.superpowers/brainstorm/4810-1792595455/content/encryption-ux.html` (not committed).

Builds on the encryption spec (`2026-10-20-encryption-design.md`), E3 (encrypted storage) and E4 (encrypted-vault UI), all merged to `main`.

## 0. Why

Jose tested E4 and found the encryption UX didn't make sense:

1. When creating a vault, the user should choose plain or encrypted as part of creating it.
2. Welcome's "Encrypt this vault" checkbox sits apart from any action and can't apply to the recent vaults list, so it reads as meaningless.
3. Vault → "New Encrypted Vault…" with Smartjob open, picking the Smartjob folder, did nothing visible: E4's create refuses a non-empty folder with a small inline line ("Pick an empty or new folder."), and encrypting an existing vault didn't exist yet.
4. The recent vaults list doesn't show which vaults are encrypted (E4 only swapped the icon for a lock glyph).
5. The vault menu should offer "Encrypt "<vault name>"…".
6. The Beta chip's margins and padding are off everywhere.

## 1. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | **Encrypting an existing vault happens in place.** The folder keeps its path and its place in Recent. This reverses the encryption spec's call 6 ("converting always makes a copy"). | Jose |
| D2 | The plain-or-encrypted choice lives **inside one "New vault" dialog**, reached from Welcome's "New vault" and Vault → "New Vault…". The Welcome checkbox and "New Encrypted Vault…" go away. | Jose |
| D3 | Recent list: an **"🔒 Encrypted" chip after the vault name**; the vault keeps its own icon (mock option A). | My call: Jose approved the mocks without picking; A was first and simplest |
| D4 | After in-place encryption, the **readable originals go to the OS Trash** (recoverable; the user empties it), never deleted outright (mock option 3b A). | My call, same reason; it is also the safer default |
| D5 | Encryption is per vault. Folders inside an encrypted vault are encrypted with it; there is no per-folder choice. | Encryption spec |

## 2. New vault (D2)

- **One dialog, "New vault"**, opened by Welcome's "New vault" button (and its ⌘N), and by a new Vault menu item **"New Vault…"**.
  - **Where:** the chosen folder path with a "Choose…" button (the native folder picker). The dialog opens the picker straight away the first time; Cancel in the picker leaves the dialog open with no folder.
  - **Protection:** two cards, **Plain** ("Ordinary Markdown files any app can open.") and **Encrypted** with a Beta chip ("Names and contents encrypted. Needs a passphrase to open."). Plain is selected by default.
  - **Continue:**
    - Plain → today's `vault_create(path)` flow (create or open the folder as a vault).
    - Encrypted on an empty (or new) folder → E4's passphrase → creating → recovery-key steps, in the same dialog (CreateEncryptedDialog's steps; the "New vault" title stays, with the step indicator "1 Passphrase · 2 Recovery key").
    - Encrypted on a folder that already has notes → not an error: the dialog says "This folder already has notes. Encrypt it in place?" with **Encrypt in place…** (goes to §4's flow for that folder) and Back.
    - Encrypted on a folder that is already an encrypted vault → "This folder is already an encrypted vault." with **Open it** and Back.
- **Removed:** the Welcome "Encrypt this vault" switch; Vault → "New Encrypted Vault…" and its `newEncrypted` handler. The E4 sticky-dialog rules carry over unchanged (the dialog is held from "Create" until the recovery key is confirmed).

## 3. Recent vaults (D3)

- An encrypted vault's row shows its own icon (emoji or folder), then the name followed by an **"🔒 Encrypted" chip** (accent text on the accent-soft background, the same chip family as Beta, §5). The chip is real text, so screen readers read "Smartjob, Encrypted"; the E4 sr-only suffix goes.
- `RecentVaultDto.encrypted` already exists (E3). Its icon stays as E3 left it: an encrypted vault's emoji lives inside the encrypted vault, so the recent row shows the plain folder icon.

## 4. Encrypt an existing vault, in place (D1, D4)

### 4.1 Entry points

- **Vault menu:** "Encrypt "<name>"…", enabled only while a **plain** vault is open (name truncated like the window title).
- **Sidebar vault-name menu** (`VaultMenu.tsx`): the same item.
- **New vault dialog:** a non-empty folder chosen with Encrypted (§2).

### 4.2 Flow (one dialog, held while it matters)

1. **Intro:** "Every page, folder name and attachment in this folder will be encrypted where it is. <N> files." plus the warning box: "Encrypting can't reach copies that already exist elsewhere — backups, Time Machine, and your sync service's version history (Dropbox, iCloud) may still hold the old readable files." Buttons: Cancel, "Choose a passphrase…".
2. **Preflight** (runs before the passphrase step; a blocking list, not a toast): names the encrypted format refuses (`:` or `\`), two names that differ only in case or Unicode form in one folder (E3 folds them), symlinks, the reserved names in §4.4, unreadable files. Each with its path, and "Rename or remove these, then try again." Nothing is changed.
3. **Passphrase:** E4's `PassphraseFields` (12-character minimum, strength hint).
4. **Encrypting:** a progress bar, "<done> of <total> files · each one is checked before the original is moved", and **Stop and undo**. The app saves all open pages first (as lock does, never asking) and closes the plain session; nothing else can edit the vault meanwhile.
5. **Done:** "1,204 files encrypted and checked. The unencrypted originals are in the Trash: empty it when you're happy." Then E4's recovery-key step (shown once, two groups typed back, sticky), then the vault opens unlocked.

### 4.3 Backend: crash-safe in place

A new conversion in `liber-vault` (`storage/encrypted/convert.rs`), driven by a desktop command.

- **Journal:** `<root>/.liber-convert.json`, plain JSON with no secrets: `{ "version": 1, "phase": "copying" | "staged" | "committed", "started": <unix secs> }`.
- **Phases:**
  1. **Preflight** (§4.2 step 2). Refuse if the root is already encrypted or damaged (`vault_kind`), or if the reserved names exist without a journal.
  2. **Copy and verify** (`phase: copying`): create a fresh encrypted vault in the hidden staging folder `<root>/.liber-converting/` (`EncryptedStorage::create`, real Argon2 calibration), unlock it, and for every file in the plain vault (walked through `PlainStorage`, dot-folders included: `.liber`, `.trash`, `.archive`, `.obsidian`; the reserved names skipped) stream it in with `create_new` → `finish`, then read it back and compare a SHA-256 of the plaintext. Empty folders are created too. Progress events every file; a cancel flag checked between files.
  3. **Stage the originals** (`phase: staged`): move every top-level plaintext entry except the reserved names into `<root>/.liber-plain/` (same-volume renames).
  4. **Commit** (`phase: committed`): move the staging folder's `d/` and `README.txt` up to the root, then `liber-vault.json` **last**. The header's rename is the commit point: from then on `vault_kind` says encrypted.
  5. **Finish:** send `.liber-plain/` to the OS trash (best effort; on failure it stays, hidden, and the user is told where), remove the staging folder and the journal, record the epoch, delete the vault's old plaintext index from the app cache (it holds page text), and update the recent entry (`encrypted: true`).
- **Recovery on open** (`vault_open` and `vault_unlock` check for the journal first):
  - `copying` or `staged`, no root header → **roll back**: move everything in `.liber-plain/` back to the root, delete the staging folder and the journal, open the plain vault, and say "Encrypting "<name>" was interrupted; the vault is back as it was."
  - root header present (`committed`) → **finish** the remaining finish steps, then the vault is encrypted (Unlock screen), and say "Finished encrypting "<name>"."
- **Stop and undo** during copy: the same rollback.
- **Reserved names:** `.liber-convert.json`, `.liber-converting`, `.liber-plain`. A plain vault holding one without a journal is refused in preflight.
- **Never deleted:** no plaintext file is removed before every file is copied and verified; the originals only move within the vault folder until the final trash.
- **Windows:** a rename that fails (a file open in another app, antivirus) aborts the stage step and rolls back, naming the file.

## 5. The Beta chip (one style)

- One class used by every Beta label (create/convert dialogs, Unlock, Settings → Security title and nav, the New vault Encrypted card): inline-flex, height 18 px, padding 0 7 px, 8 px left margin from the preceding word, vertically centred on the text, never `margin-left: auto`. The "🔒 Encrypted" recent chip shares its shape.
- Every place it appears is checked visually (e2e screenshot-free: assert computed height and that it shares a line box with its label) in light and dark.

## 6. Out of scope

- Decrypting a vault back to plain (E5's "Export decrypted copy…").
- The keyring / master key, rotation, Touch ID (E5, E7).
- Converting while the vault is open in another app (sync tools keep running; their history is the warned residual).

## 7. Testing

- **Rust (conversion):** a round trip of a realistic vault (nested folders, long names, dot-folders, attachments, an empty folder) reads back identical through `EncryptedStorage`; the xcheck reader decrypts the converted vault; a crash injected after each phase (copying mid-way, staged mid-way, after commit) recovers by rollback or finish with no file lost and no plaintext left in the root; preflight refuses each blocked case and changes nothing; Stop and undo restores the vault byte for byte; the old index cache is deleted.
- **Desktop:** the command emits progress, honours cancel, updates the recent entry, and recovery runs on open.
- **UI (vitest + e2e, Chromium and WebKit):** New vault plain and encrypted; non-empty folder → offer → convert; already-encrypted folder → open; the menu items' enabled state; the recent chip; the convert flow end to end (intro, preflight blocked list, passphrase, progress, done, recovery key, unlocked); Stop and undo; the Beta chip checks; axe on every new screen.

## 8. Builder-check answers (2026-10-21, my calls; they override §4 where they differ)

A fresh-context builder check raised ten questions, six about crash safety. All answered here, each toward the safer side.

1. **The recovery key comes before any file is touched.** Order: intro → preflight → passphrase → the staging vault is created → the recovery key is shown and confirmed (E4's step, two groups) → only then copying starts. A crash before the commit rolls back and the shown key is simply unused. The "Done" screen no longer shows a key.
2. **The journal is per device.** `.liber-convert.json` carries an `installId` (a random id stored once in the app's config dir) and the new `vaultId`. Recovery acts only on its own journal. A journal from another install makes open refuse with "This vault is being encrypted on another device. Finish there, or wait for sync to finish." Nothing is touched.
3. **Changes made by sync during conversion abort it.** Each copied file's size and modified time are recorded. Before staging, every original is checked against that record and the root is re-listed: a changed file or a new top-level entry (other than kept names, item 5) rolls the whole conversion back with "Files changed while encrypting — probably a sync service. Pause syncing and try again." The intro's warning box adds "Pause Dropbox, iCloud or other sync for this folder while it runs."
4. **Recovery follows the journal, not the presence of a header.** Phases: `copying` → `staged` (every original moved into `.liber-plain/`) → `committing` → `committed`. Before `staged` is written: roll back (remove `.liber-converting/`; move anything in `.liber-plain/` back). From `staged` on, every original is safe in `.liber-plain/` and every encrypted file is verified, so recovery **rolls forward**: move `d/` and `README.txt` up (skipping any already there), then `liber-vault.json` last. "Committed" means the root header parses **and** its `vault_id` equals the journal's. A root entry that collides during a move stops recovery with a clear message, never overwriting. A user's own unparseable `liber-vault.json` is just an original: it is staged like any other file.
5. **Some top-level entries stay plaintext at the root**, neither copied nor staged: sync-tool control files (`.stfolder`, `.stignore`, `.stversions`, `.sync`, `.dropbox`, `.dropbox.attr`, `Icon\r`, `desktop.ini`) and OS junk (`.DS_Store`, `Thumbs.db`), which is skipped. A **`.git` folder makes preflight refuse** ("This folder is a git repository; encrypting it would break the repository"). `.obsidian`, `.liber`, `.trash`, `.archive` are encrypted. E3's `EncryptedStorage` must tolerate those kept entries beside `d/` (checked by a test).
6. **Cloud placeholders are refused in preflight**: `*.icloud` stubs, macOS dataless files (`st_flags & SF_DATALESS`), and on Windows files with the recall-on-access or offline attributes. "These files are only in the cloud. Download them first (make them available offline), then try again." Nothing is read from them.
7. **Modified times survive**: after each file is finished, the ciphertext file's modified time is set to the original's (`File::set_modified`, std). Creation times can't be set portably and become the conversion time (documented).
8. **The originals go to the Trash under a visible name**: just before trashing, `.liber-plain/` is renamed to `<name> (unencrypted originals)` inside the root, then sent to the OS Trash. If trashing fails, it stays hidden as `.liber-plain/`, the journal keeps `phase: trashPending`, and every unlock of the vault shows a banner: "The unencrypted originals of this vault are still in its folder." with "Move to Trash" and "Show in Finder".
9. **Finish order**: delete the old plaintext index cache → trash the originals (or mark `trashPending`) → remove `.liber-converting/` → remove the journal **last**. A leftover journal in an encrypted root is acceptable (plain JSON, no secrets). The recent list needs no update: `RecentVaultDto.encrypted` is computed from the folder.
10. **What can be encrypted in place**: any folder except the global Scratchpad, the home folder, Desktop, Documents, Downloads, and a volume root (refused with "Encrypt a vault folder, not <folder>"). Preflight also refuses a name over 255 bytes once encoded and a name that isn't valid UTF-8.
