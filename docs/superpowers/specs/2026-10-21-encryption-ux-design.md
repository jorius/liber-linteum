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

- Decrypting a vault back to plain (E5's "Export decrypted copy…"). Decrypting in place came later: §10.
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
11. **Another device's unfinished conversion can be undone here, but only before `staged`** (amends item 2; final whole-branch review). A journal from another install used to strand the vault for good if that device never came back.
    - **Phase `copying`**: every original is still at the root, or back from `.liber-plain/` by an exact-name move. Opening the folder fails with `convertingElsewhere`, and the error offers "Undo it on this device…". Its confirmation says "Only do this if the other device isn't encrypting this folder right now. The vault goes back to unencrypted." On confirm, `vault_encrypt_undo_elsewhere` runs the ordinary rollback, ignoring the install id but keeping every other check: exact names, a staging folder this run created, and never overwriting. The folder then opens as a plain vault.
    - **From `staged` on**: the refusal stays (`convertingElsewhereFinishing`). The error gives the manual steps: finish it by opening the vault on that device. If that device is gone, quit and move everything in the hidden `.liber-plain/` folder into a new folder: those are the notes, unencrypted.

## 9. Encrypt in place: keep a readable backup (2026-10-21, approved feature A)

### 9.1 Flow

intro → preflight (blocked list) → **backup** → passphrase → begin (staging vault) → **backing up** (only with a copy) → recovery key → encrypting → done.

- **The backup step** comes right after preflight, before the passphrase: "Keep a readable copy?" with two radio cards and no default (the user chooses):
  - **Keep a readable copy**: a folder field with **Choose…** (a Rust-side folder dialog, `vault_encrypt_pick_backup`; tests replace it with `ConvertState::set_backup_picker`). Rust keeps the folder it picked; the page never names it to the backend (as the Notion import does).
  - **Don't keep a copy**: today's behaviour. The originals go to the Trash as "<name> (unencrypted originals)".
  - The warning box says it plainly: the copy is **not encrypted**, so anyone who can open that folder (or its sync service) can read it. "Choose a passphrase…" stays off until a choice is made and, with a copy, until a folder passes the checks.
- **The folder must be** outside the vault (not the vault, not inside it, not around it), not inside another vault (an encrypted or damaged one by `vault_kind`, a folder holding `.liber/`, any recent vault, the Scratchpad), and empty (OS junk aside) or new (its parent must exist). Refused with its own error: `backupInVault`, `backupInOtherVault`, `backupNotEmpty`. The pick checks it; begin and the backup check it again.
- **When it's written.** After begin, before the recovery key: the vault is closed by then (the open pages were saved first), so nothing edits it while it's copied, and a backup that fails never shows a key that is then thrown away. `vault_encrypt_backup` copies every file the conversion will encrypt (the same walk: notes, attachments, `.liber/`, `.trash/`, `.archive/`, `.obsidian/`, empty folders; sync-tool control files and OS junk are left out, as they are from the encrypted vault) and emits `vault:encrypt-progress`. Stop and undo works during it.
- **Verified before any encryption.** Each file is streamed into the folder (`create_new`) while its SHA-256 is computed, synced to disk, read back and hashed again: the two must match, and the original's size, mtime and (unix) inode and ctime must be the same before and after the read. Its mtime is set to the original's.
- **The backup matches what is encrypted.** The backup records each file's stamp. The encrypt copy re-scans and compares with that record first: a file changed or added since (a sync during the key step) aborts with `changedDuringConvert`, and the conversion is undone. The backup stays.
- **Done** adds: "A readable copy is in <folder>. It isn't encrypted: keep it somewhere safe, and delete it when you no longer need it." with **Show in Finder / Show in file manager** (`vault_reveal_backup`, which reveals only the folder this app backed up to).

### 9.2 Failure modes

| When | What happens |
|---|---|
| The pick is refused | an inline alert with the reason; nothing written |
| Begin re-checks the folder and it no longer passes | begin refuses; nothing changed |
| A file can't be read or written, or reads back differently | `backupFailed` (the file and why): exactly the entries this backup created are removed, newest first, each recorded only once its creation succeeded; anything a sync put in the folder meanwhile stays (a folder of ours holding it stays too). The conversion is undone (`rollback`), the plain vault reopens: "The readable copy couldn't be made (…). Nothing was encrypted." |
| Stop and undo during the backup | as above, `cancelled` |
| A crash during the backup | the journal says `copying`: the next open rolls the conversion back as before. The part-written copy stays in the folder (recovery never deletes outside the vault, and the journal doesn't name the folder); it is the user's to delete |
| The conversion fails or is stopped after the backup | the backup is complete and verified: it stays (it's the user's) |

### 9.3 Not changed

The originals still go to the Trash when a backup is kept: the backup is a second copy, not a replacement. The journal format is unchanged (no secrets, no backup path).

## 10. Decrypt "<vault>" (2026-10-21, approved feature B)

### 10.1 Entry points

- **Vault menu** (macOS): `Decrypt “<name>”…`, id `liber-vault-decrypt`, `menu:vault` payload `"decrypt"`, named and enabled only while an encrypted vault is open (`menu_set_decrypt_item`, as `menu_set_encrypt_item`). The in-app menu bar of Linux and Windows (another branch) can wire the same id and payload.
- **The sidebar's vault-name menu** (`VaultMenu.tsx`), for an encrypted vault.
- Refused while another conversion is pending or running, for the Scratchpad, for the folders encrypt in place refuses (home, Desktop, Documents, Downloads, a volume root: consistent with §8.10), and for a vault inside another encrypted vault.

### 10.2 Flow (one dialog, held from begin until done or an error, with the Beta chip)

1. **Intro:** "Decrypting turns every page, folder name and attachment of “<name>” back into ordinary files, where they are. <N> files." The warning box: anyone with access to this disk, its backups or its sync service can read the vault afterwards; the sync service uploads the readable pages and its version history keeps them, even if the vault is encrypted again later; pause syncing while it runs. "The passphrase and recovery key stop working for good: encrypting the vault again later makes new ones." Buttons: Cancel, Continue.
2. **Preflight** (a blocked list; nothing changed): names that couldn't be decrypted (`unreadable`; they would be lost with the ciphertext), a folder that would read as an encrypted vault of its own once readable (`vault`), a top-level name already used by a readable entry beside the vault (`taken`), one of the conversions' own names (`reserved`), a take in `.liber/recording/` not yet saved as a clip (`recording`), and a hidden temp file under `d/` (`unfinished`: an interrupted write or salvage stream the listing skips, which the finish would otherwise delete). Sync archives at the root (`.stversions`, `.sync`) are named in the intro's warning box: they may keep old ciphertext and old headers, and decrypting never touches them.
3. **Secrets:** the passphrase and the recovery key, both required. Each is checked on its own against this vault's header (the passphrase slots with Argon2, the recovery slot): a wrong one says which ("The passphrase doesn't open this vault." / "The recovery key doesn't open this vault.", or both), and the header must be the open vault's (same vault id, and not an older epoch than this device has seen).
4. **Decrypting:** progress, "<done> of <total> files · each one is checked before anything encrypted is removed", and **Stop and undo**, which turns off once the last file is done (the stage and commit can't be stopped). The open pages are saved first, a take in progress is stopped and saved as a clip next to its page (it would otherwise wait for an unlock that never comes), and the encrypted session closes (its decrypted attachment copies are wiped then).
5. **Done:** "<N> files decrypted and checked. “<name>” is no longer encrypted, and its passphrase and recovery key no longer work." If the finish failed, it says instead that cleaning up didn't finish and names the hidden folder still holding the old key file and ciphertext (`VaultInfo.keysLeft`; the next open deletes them). The sync archives' warning is repeated. **Open** closes the dialog: the vault is already open behind it, as a plain vault (Settings → Security and the Recent chip go, since both read the folder).

### 10.3 Backend: crash-safe in place

The mirror of §4.3 and §8, in `liber_vault::decrypt` (`storage/encrypted/decrypt.rs`), reusing convert's journal, stamp, collision and crash-point patterns.

- **Names:** the journal `.liber-decrypt.json` (plain JSON, no secrets: version, phase, started, `installId`, the old `vaultId`, `stagingCreated`, `retiredCreated`, and from `staged` on the `manifest` of the readable tree: its top-level names and a SHA-256 over every path and file length under them); the readable tree while it fills, `.liber-decrypting/`; the encrypted entries between staging and deletion, `.liber-encrypted/`. Encrypt in place refuses a folder with a decrypt journal (`convertPending`); decrypt refuses one with either journal.
- **The vault's own entries** are `d/`, `README.txt`, `liber-vault.json`, and sync-conflict copies of the header: only files (at most the format's header size) that parse as a header with this vault's id. A user's `liber-vault-export.json`, or a folder with such a name, is an extra and stays.
- **Phases:**
  1. **Begin** (secrets checked, the session closed): journal `copying`, then `.liber-decrypting/`.
  2. **Copy and verify** (`copying`): first the stamps of every physical entry under `d/`, of the header and of the root's other entries are recorded, **before** the logical walk (so a file a sync delivers after the recording fails the stage's re-check). Then each logical folder is made (empty ones too) and each file is streamed out of `EncryptedStorage` into `create_new`, synced, read back, and its SHA-256 compared with the decrypted stream's; its mtime is set to the encrypted file's (which encrypt in place set to the original's). A file that fails to decrypt stops it (`damaged`). After the last file the logical walk runs again and must list exactly what was copied (`changedDuringDecrypt` otherwise), and cancel is checked once more. Progress per file; cancel between files.
  3. **Stage the encrypted entries:** re-check the recorded stamps (a changed ciphertext file, a newcomer at the root, a change in `.liber-decrypting/`: `changedDuringDecrypt`, rolled back), then move `d/`, `README.txt` and any header sync-conflict copies into `.liber-encrypted/`, `liber-vault.json` **last**, and re-check them there. Then journal `staged`. From here every readable file is verified and nothing encrypted is at the root: recovery **rolls forward**.
  4. **Commit** (`committing`): move each top-level entry of `.liber-decrypting/` up to the root, skipping those a crash already moved, never overwriting: an entry a sync put in the way (still in staging, so not ours) is first renamed `<name> (conflict)` (`Notes (conflict).md`, then ` (conflict 2)`, …), and the commit goes on. `committed` only once the root holds the whole manifest (every path and length) and reads as a plain vault; a readable copy that went missing (partly or whole) stops it with `damaged` and nothing encrypted is deleted.
  5. **Finish:** delete every file that is this vault's header (the keys go first, fsynced): in `.liber-encrypted/`, and at the root too (a sync-conflict copy that arrived after the stage, the temp file `.liber-vault.json.liber-tmp-…` of a header write a crash cut short). Then `.liber-encrypted/` (the ciphertext); then the vault id is recorded as retired on this device (`vault-retired.json`, ids only) and forgotten in `vault-epochs.json` (a failure there is only a warning); then the empty staging folder, then the journal **last**. The desktop then wipes the decrypted copies again and opens the folder as a plain vault.
- **Recovery on open** (`vault_open`, `vault_unlock` and `folder_kind` check the decrypt journal as they check the encrypt one): this device's journal at `copying` → **roll back** (the encrypted entries back from `.liber-encrypted/`, the header last, never overwriting; the readable staging folder deleted; the journal last): "Decrypting “<name>” was interrupted; the vault is still encrypted." From `staged` on → **finish**: "Finished decrypting “<name>”." Another install's journal is not acted on before its commit: `decryptingElsewhere` while copying (with "Undo it on this device…", the same rollback after a confirm), `decryptingElsewhereFinishing` from `staged` until `committed`. Committed there with the readable tree in place here (the manifest holds), this device finishes it too: the keys and ciphertext go from here as well. Committed but the tree changed since, the folder opens as plain and that device finishes. `vault_unlock` of a folder its recovery just finished opens it as the plain vault it now is.
- **A retired header put back:** on every open, a header at the root whose vault id this device retired (a sync put it back after the finish) is deleted with every copy of it, with a warning, so the folder doesn't read as an encrypted or damaged vault. Never while a conversion's journal is there (that header is a new vault's).
- **Stop and undo:** during the copy, the rollback above.

### 10.4 What is deleted, when, and why it's deleted rather than trashed

| What | When | How |
|---|---|---|
| The readable staging copy | Stop and undo, a failed run, recovery before `staged` | deleted: the encrypted vault is intact, and a second readable copy is what the user didn't ask for |
| `liber-vault.json`, its sync-conflict copies and crashed-write temp copies, in `.liber-encrypted/` and at the root | finish, first | **deleted** |
| `d/` (the ciphertext) and `README.txt` | finish, after the header | **deleted** |
| The vault id in `vault-epochs.json` | finish | removed |
| Decrypted attachment copies | begin (the session closes) and after finish | wiped |

The header and the ciphertext are deleted, not trashed:

- **The header is the only place the vault key is kept**, wrapped by the passphrase and by the recovery key. In the Trash, putting it back beside `d/` would make the old passphrase and recovery key open the old data again; the spec says they stop working forever.
- **Without the header, nobody can read the ciphertext**: the vault key is random and was never stored anywhere else. Trashing it would only fill the Trash with unreadable bytes the size of the vault, which would look like a backup and isn't one.
- **Deleting loses nothing**: every readable file is written, synced, read back and hash-checked before anything encrypted leaves the root, and is at the root before the finish deletes anything. A crash between the commit and the end of the finish re-runs the finish.

So nothing that can unlock or reveal the old data stays in the vault folder once the finish completes, with two exceptions the UI states: the finish failed (the done screen names the hidden folder; the next open finishes), and sync archives at the root (`.stversions`, `.sync`), which are the user's and never touched (named in the intro and on the done screen). What the app can't reach is what §4.2 already warns about: copies elsewhere (backups, Time Machine, a sync service's history of the old header and ciphertext). A header a sync puts back later is deleted at the next open (above).

### 10.5 Failure modes

| When | What happens |
|---|---|
| A wrong passphrase or recovery key | `decryptWrongSecret` (`passphrase`, `recovery` or `both`); nothing changed, the vault stays open |
| Preflight blocks | the list; nothing changed |
| A file fails to decrypt (damaged) or reads back differently | rolled back; `damaged` / `decryptMismatch` names it; the vault is encrypted as it was (the Unlock screen shows behind the dialog) |
| Sync changes something mid-run | `changedDuringDecrypt`, rolled back |
| Stop and undo | `cancelled`, rolled back |
| A crash before `staged` | rolled back on the next open (the readable staging copy stays hidden in the folder until then) |
| A crash from `staged` on | finished on the next open |
| The undo fails | `decryptUndoFailed`: the encrypted entries are safe in `.liber-encrypted/`; opening the folder again retries |
| A failure past `staged` | `decryptFinishFailed`: the dialog opens the folder, whose recovery finishes it |
| The readable copy is missing at the commit | `damaged`; nothing encrypted is deleted (the manifest doesn't hold) |
| A sync puts something where the readable tree goes, after `staged` | kept as `<name> (conflict)`; the commit goes on |
| A take is recording at begin | saved as a clip next to its page first; one that can't be saved blocks (`recording`) |
| A begin fails after its journal | only that journal (this install's, `copying`) is rolled back; a refusal touches nothing |
| Forgetting the epoch fails | a warning; the vault is plain anyway, and a record for an id that no header carries any more is harmless |

### 10.6 Re-encrypting later

Encrypt in place always makes a new vault (`EncryptedStorage::create`: a random vault key and vault id, new slots, a new recovery key), so nothing of the old keys comes back. Tested in `liber-vault` (a new id; the old recovery key doesn't open it) and on the desktop (the old id is gone from `vault-epochs.json`, the new one is recorded).
