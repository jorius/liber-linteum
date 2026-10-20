# Encrypted vaults — design

Status: **draft for Jose's review** (2026-10-20). Nothing here is built yet.
Facts (versions, licences, audits, prior art) with sources: `docs/research/2026-10-20-encryption-facts.md`. Every claim in this spec about a library or a product traces to that sheet.

## 0. Intent

Jose wants "heavy cryptography", very well documented, so that a vault can hold notes he would not want anyone else to read: security research, personal matters, client work. Today a vault is a folder of plain Markdown. Anyone with the disk, a backup, a sync account or a minute at the unlocked Mac can read all of it.

Jose's decisions (2026-10-20):

- **Protect against all four threats.** A lost or stolen laptop; cloud sync and backups (file names included); someone at the unlocked Mac; and, later, sharing with specific people.
- **No PGP for now.** The format must leave room for a future "share" feature that encrypts to other people's public keys (OpenPGP or similar).
- **His question:** should a "master key" open and encrypt new and existing vaults? **The answer is yes, as a keyring** (§3.3). The keyring is one more way to unlock each vault, never the only one. Every vault keeps its own key and its own recovery key, so losing the keyring loses no vault.

## 1. Goals, non-goals, anti-goals

**Goals**

- **G1. At rest, an encrypted vault reveals nothing but its shape.** File contents, file and folder names, the vault's own settings (`.liber/`), Trash, Archive and the search index are all unreadable without a key. The only things left visible are the number of files and folders, their nesting, their approximate sizes and their times (§9).
- **G2. Sync-friendly.** One ciphertext file per note or attachment, so iCloud, Dropbox, Syncthing and Git sync and version it like any folder, and two machines can use it.
- **G3. Several ways in, one key.** A passphrase, a recovery key, the keyring, and "this device" (Touch ID / Windows Hello) each unlock the same vault key. Changing the passphrase never re-encrypts the vault.
- **G4. Locks itself.** On idle, sleep, screen lock and quit. Locking never loses an edit.
- **G5. Bring existing vaults in, and take them out.** "Encrypt this vault" makes an encrypted copy and verifies it. "Export decrypted copy" goes the other way.
- **G6. Documented to the byte and versioned.** Another programmer could write a compatible reader from `docs/security/vault-format-v1.md` alone. Committed test vectors pin it.
- **G7. Room for sharing.** The key-slot design accepts public-key recipients later without a format break.

**Non-goals (this milestone)**

- PGP of any kind; sharing; per-page encryption inside a plain vault.
- Multiple users with different permissions on one vault.
- Protecting an *unlocked* vault from malware running as the user.
- Hiding file counts and sizes completely (no padding scheme, no flat Cryptomator-style tree; see §4.3).
- Destroying old plaintext after converting. SSDs and APFS make that impossible to promise; see facts §7.
- Opening encrypted vaults in Obsidian or any other app.

**Anti-goals: things that would make this a failure even if it "works"**

- Rolling our own primitives or modes. We only compose standard, published constructions from audited or widely reviewed crates.
- Losing a note: to a crash mid-write, to a lock with unsaved changes, or to a forgotten passphrase when a recovery key was offered.
- One key that, lost, locks every vault. Or one key that, stolen, opens every vault with no way to revoke it.
- A Touch ID prompt that only gates the UI while the key sits readable on disk (facts §5).
- Plaintext copies left outside the vault: the index, caches, temp files, WebView storage, logs.
- Marketing claims we can't back, such as "military grade" or "unbreakable". The feature ships labelled **beta** until an external review (§12).
- Any network access. P1 still holds: zero network requests.

## 2. Threat model

| Adversary | Has | Must not get | Notes |
|---|---|---|---|
| Laptop thief / finder | the disk, powered off or locked | any content, names or settings | FileVault/BitLocker on top is still recommended; we don't rely on it |
| Sync or backup provider, or whoever breaches it | every ciphertext file and old versions | content and names | they can see the shape and change history (§9) |
| Person at the unlocked Mac | the running app after auto-lock fired | anything without the passphrase or biometry | before auto-lock fires the vault is open: the window is the idle timeout |
| Person with write access to the synced folder | can change or delete ciphertext | undetected changes to a file's content | tampering is detected per file. Swapping whole files or rolling a file back to an older version is **not** detected (§9). Deletion is always possible |
| Future quantum attacker storing ciphertext today | ciphertext + public keys | vault keys | AES-256 is fine. The keyring's public-key slot is hybrid X25519 + ML-KEM-768 (§3.3) |

Out of scope: malware or a debugger running as the user while the vault is unlocked; a hardware keylogger; forced disclosure of the passphrase.

## 3. Keys

### 3.1 Vault key and subkeys

Each encrypted vault has one random 256-bit **vault key** (VK), made from the OS CSPRNG (`getrandom`). VK is never written anywhere unwrapped. All working keys come from it with HKDF-SHA-512 (RFC 5869), where salt = `vault_id` (16 random bytes, public) and the `info` labels are fixed strings:

| Key | info | Use |
|---|---|---|
| K_content | `liber/v1/content` | root for per-file content keys (§4.2) |
| K_name (64 bytes) | `liber/v1/name` | AES-SIV-256 for names (§4.3) |
| K_header | `liber/v1/header` | HMAC-SHA-256 over the vault header (§3.2) |
| K_index | `liber/v1/index` | optional encrypted index snapshot (§5.1) |

Keys live in Rust only, in `secrecy`/`zeroize` wrappers, and are `mlock`ed via `region` where the OS allows. Locking drops and zeroizes them (§6).

### 3.2 Key slots (the vault header)

`liber-vault.json` at the vault root is plaintext and contains nothing secret:

- the format version, the cipher suite and `vault_id`;
- a list of **slots**, where each slot is VK wrapped with AES-256-GCM under a slot key (KEK), with a random 12-byte nonce and AAD = `"liber/v1/slot" ‖ vault_id ‖ slot_id ‖ slot_type`;
- `mac`, which is HMAC-SHA-256(K_header, canonical JSON of everything else). It is checked after every unlock, so a tampered header (swapped slots, downgraded parameters) is refused. The design follows LUKS2 keyslots and the Cryptomator masterkey file (facts §3).

Slot types in v1:

| Type | KEK from | Required | Notes |
|---|---|---|---|
| `passphrase` | Argon2id(passphrase NFC-normalised, 32-byte salt, params) | yes, exactly one | params are stored per slot. Default m = 256 MiB, t = 3, p = 4, calibrated at creation to 0.5–2 s and never below m = 64 MiB, t = 3. That is far above the OWASP floor (46 MiB / t = 1) and the Bitwarden/KeePassXC defaults (facts §3) |
| `recovery` | HKDF-SHA-256(recovery secret, salt = vault_id) | yes, exactly one | 256-bit random secret shown **once** at creation as `LIBER-` + 52 Crockford base32 characters in groups of 4, with a checksum group for typos. The user must type two groups back before the vault is created |
| `keyring` | hybrid KEM to the keyring's public key (§3.3) | optional, at most one per keyring | can be added without unlocking the keyring, since only the public key is needed |
| `device` | 256-bit random secret in the OS keychain, biometry-bound (§6.3) | optional, one per device | "Unlock with Touch ID on this Mac" |
| reserved: `recipient` | public-key wrap to another person | later (share) | type id reserved now (G7); readers in v1 skip unknown slot types |

**Operations:**

- **Change passphrase:** rewrap one slot.
- **New recovery key:** replace that slot and show the new key once.
- **Remove a slot:** delete it.
- **Rotate vault key:** create a new VK, re-encrypt every file, rewrite every slot. This is the only defence after a slot is believed compromised, because whoever had VK keeps it. It is a long operation with a progress bar, done file by file with atomic writes and resumable through a journal. Rotation rules:
  - **Epochs.** Every VK has an **epoch** (u32, starting at 1), recorded in the vault header, in every file header (§4.2) and in folder names (§4.3).
  - **During a rotation**, the header holds the new VK in its slots and the *retiring* VK wrapped under the new one. A reader picks the key by the file's epoch, so an interrupted rotation resumes from the journal and a half-rotated vault stays readable. The retiring key is removed when the journal completes.
  - **Slots after a rotation:**
    - the user re-enters their passphrase, or chooses a new one;
    - a **new recovery key is always issued**;
    - device slots are dropped (Touch ID is re-enrolled per device);
    - the keyring slot is re-added from the public key, with no keyring unlock needed.
  - **Another machine with the vault open** sees the header's epoch change. It locks that vault, flushing its saves under the old epoch, which the rotation then picks up, and asks to unlock again.
  - **K_name changes**, so every entry is renamed. Sync clients see a full delete plus create. The progress dialog says so (*my call*, after the builder check).

### 3.3 The keyring (Jose's "master key")

The keyring is an app-level identity that holds one **hybrid keypair**: X25519 plus ML-KEM-768 (FIPS 203).

- **Wrapping a vault key to the keyring** works like this:
  1. Encapsulate with both keypairs.
  2. Derive the KEK as HKDF-SHA-256 over both shared secrets ‖ both ciphertexts ‖ both public keys.
  3. Wrap VK with AES-256-GCM.

  An attacker has to break *both* X25519 and ML-KEM. That matters because the `ml-kem` crate is unaudited (facts §1), so X25519 stays the floor.
- **Storage.** The keyring file `keyring.liberk` lives in the app data dir. Public keys are in the clear. The private keys are wrapped by their own slots: a keyring passphrase (Argon2id as above), a keyring recovery key, and an optional `device` slot.
- **One unlock opens every vault in the keyring.** The keyring **locks on the same triggers as vaults** (idle, sleep, screen lock, quit; §6.2). After any lock, the person at the Mac needs the keyring passphrase or biometry again, which keeps §2 true. One keyring unlock then reopens every enrolled vault.
- **Enrolled vaults only.** The keyring stores a list of enrolled vaults: `vault_id` → HMAC-SHA-256(keyring MAC key, `vault_id` ‖ K_header). It opens a vault silently only when the vault's unwrapped keys match that commitment. Public-key wrapping is unauthenticated, so without this list anyone with the public key could plant a look-alike vault, with a key they know, in a synced folder, and the app would open it silently (builder check, flaw 5). An unknown vault with a keyring slot asks first: "Add this vault to your keyring?" with the passphrase.
- **New encrypted vaults** get a keyring slot automatically when a keyring exists. **Existing encrypted vaults** can be added from Settings → Security.
- **Moving to another machine:** "Export keyring…" writes the same encrypted file, and "Import keyring…" reads it. A vault opened on a machine without the keyring still opens with its passphrase or recovery key.
- **Why not one key for everything:** each vault's VK is independent. Losing the keyring loses no vault, because each has a passphrase and a recovery key. A stolen keyring passphrase is limited to the vaults in that keyring and is revoked per vault by removing the slot and rotating.

## 4. On-disk format v1

### 4.1 Layout

```
My Vault/                         ← the folder the user picks
  liber-vault.json                 ← header + slots (plaintext, no secrets)
  README.txt                      ← plaintext: "Encrypted Liber Linteum vault. Open it with Liber Linteum."
  d/                              ← everything else; names encrypted
    <enc-name>/                   ← a folder (its encrypted name also carries its random id, §4.3)
      <enc-name>.libere            ← a file (note, attachment, .liber/*.json, Trash, Archive…)
```

The folder tree mirrors the logical tree, so syncing and moving behave like a normal folder (G2). `.liber/`, `.trash/`, `.archive/` and the vault Scratchpad are ordinary encrypted folders under `d/`.

### 4.2 File contents: chunked AES-256-GCM (STREAM)

Header (48 bytes), which is also the AAD of every chunk:

| Offset | Size | Field |
|---|---|---|
| 0 | 5 | magic `LIBER` |
| 5 | 1 | format version = 1 |
| 6 | 1 | suite = 1 (AES-256-GCM); 2 reserved for XChaCha20-Poly1305 |
| 7 | 1 | log2 of the chunk size = 16 (64 KiB) |
| 8 | 32 | file salt, random on **every** write |
| 40 | 4 | key epoch (u32 BE, §3.2) |
| 44 | 4 | reserved, zero |

- **File key** K_f = HKDF-SHA-256(K_content, salt = file salt, info = `liber/v1/file`). Each write gets a fresh key, so counter nonces never repeat.
- **Chunk *i*** = AES-256-GCM(K_f, nonce = 11-byte big-endian *i* ‖ last-flag byte, AAD = header) → ciphertext ‖ 16-byte tag. This is age's STREAM construction (facts §2).
  - A truncated file fails, because its last chunk has no last-flag.
  - Reordered chunks fail, because the counter is in the nonce.
  - Chunks spliced in from another file fail, because that file has a different key.
  - An empty file is one empty last chunk.
- **Random access.** Chunk *i* starts at `48 + i·(65536+16)`. The asset protocol serves an HTTP range by decrypting only the chunks it covers, so audio seeking works.
- **Why AES-256-GCM.** Jose asked for AES. The crate is the audited RustCrypto `aes-gcm` (NCC Group 2020), and it is hardware-accelerated on Apple Silicon and x86. A unique key per write removes GCM's nonce-reuse risk.
- **Writes** go through the existing atomic path: write a temp file, then rename.
- **Writers only append; a chunk is written once.** The encrypted writer never seeks. It emits a chunk only when the chunk is complete, plus the final short chunk with the last-flag at close. Re-encrypting a chunk under the same K_f and nonce would be GCM nonce reuse, which leaks the XOR of the plaintexts and the authentication key. Any in-place fix-up is therefore a **new file with a fresh salt**.
- **Recordings.** Today's recorder rewrites the WAV header every 2 s through `hound`'s seek. That would be exactly the nonce reuse above (builder check, flaw 1). For an encrypted vault:
  - the take is written append-only into the vault itself (`.liber/recording/`, encrypted under K_content), never to the plaintext cache dir;
  - the WAV header carries placeholder sizes;
  - at Stop, the file is rewritten once with correct sizes and a fresh salt, then moved into place.
  - **Crash:** only complete chunks survive, losing at most the last 64 KiB (≈ 0.4 s of 44.1 kHz stereo). Recovery runs at that vault's next unlock: it decrypts the complete chunks, writes a corrected copy with a fresh salt, and saves it as `clip-…-recovered.wav`. That is the same promise as today's M6 recovery.

### 4.3 Names

- **Encryption.** Each name component (NFC-normalised UTF-8) is encrypted with AES-SIV-256 (RFC 5297) under K_name, with AD = `vault_id ‖ epoch ‖ parent folder id`. Encoding is Base64url without padding.
  - **Files:** the SIV plaintext is the name, and `.libere` is appended.
  - **Folders:** the SIV plaintext is `folder id (16 random bytes) ‖ name`, so a folder's encrypted name carries its own id. The root's id is 16 zero bytes.
- **Why bind to the parent's id.** Two "Notes.md" files in different folders don't look alike. Renaming or moving a folder re-encrypts only that folder's own name, keeping its id, so its subtree is untouched. Cryptomator does the same (facts §3).
- **Why there is no id file.** Cryptomator keeps the id in a separate file. Here it lives in the name, so there is no hidden file whose loss would make a whole folder's names unrecoverable (builder check, flaw 6).
- **Lookups.** Files are found by computing the ciphertext name. Folders are found by listing the parent, because their ciphertext depends on the random id. Decrypted listings are cached in memory while the vault is unlocked.
- **Long names.** An encoded name longer than 200 bytes becomes `<base32(SHA-256(encoded))[..32]>.liberl`. Its full encrypted name is stored in a small encrypted side file `<same>.libern` next to it. This keeps us under the 255-byte name limits and well under Windows path limits.
- **Case-insensitive file systems** (APFS default, NTFS). Two different SIV outputs that collide when case is ignored are astronomically unlikely (128-bit tags). The writer still checks for a collision and refuses the write if it ever happens.
- **Sync conflicts and stray files never hide a note** (builder check, gap 4). Dropbox, iCloud and Syncthing rename conflicts, e.g. `<enc> (conflicted copy …).libere` or `<enc>.sync-conflict-….libere`.
  - **Known conflict patterns.** The decoder strips the provider's suffix and decrypts the name. The content always decrypts, because content keys don't depend on names. The file then appears as `Name (conflict <date>)` next to the original.
  - **Names that can't be decoded at all** appear in a "Couldn't read" list in the vault's Settings, with Export and Show in Finder. They are never deleted.
  - **Conflicted copies of `liber-vault.json`** are merged after unlock: every slot that unwraps to the same VK and epoch is kept, and the MAC is rewritten.
- **Crate.** `aes-siv` is unaudited (facts §1). The construction is standard RFC 5297. The crate is named explicitly in the external review scope (§12).

### 4.4 Format spec and vectors

`docs/security/vault-format-v1.md` gives the byte-level description of §3–§4. `crates/liber-crypto/tests/vectors/` holds frozen vectors: a header, slots of each type, files at 0, 1, 65 535, 65 536 and 200 000 bytes, names, and a long name. An independent ~150-line Python reader, using the `cryptography` package, decrypts the vectors in a test. That makes it a second implementation that keeps us honest.

## 5. Everything that isn't a vault file

The rule is that **nothing derived from an encrypted vault's content is written outside the vault unencrypted.**

1. **Search index.**
   - For encrypted vaults the SQLite index is opened in memory (`:memory:`), filled at unlock, and dropped at lock.
   - SQLCipher is rejected. Its Windows cross-build from macOS is the biggest build risk found (facts §4).
   - If unlock-to-searchable on 10 000 notes exceeds 3 s on Jose's Mac, phase E3b adds an **encrypted snapshot**: serialize the DB, encrypt it with K_index, store it in the cache dir, and reindex by mtime and size after loading.
2. **App data.** The recent vaults list shows an encrypted vault by folder name with a lock icon. Its emoji and name live inside the vault. Session state, Global View positions, cover positions, favourites and icons all live in the vault's own (encrypted) `.liber/`. Anything app-side keyed by vault path is audited and moved, or keyed by `vault_id` and holds no content.
3. **WebView.**
   - The asset protocol keeps `Cache-Control: no-store`.
   - The UI must not persist note content in `localStorage` or IndexedDB. Today they hold per-viewer conveniences only; audit and test this.
   - A phase E6 spike verifies with a canary that neither WKWebView nor WebView2 writes custom-scheme responses to disk (unverified per facts §6). If one does, those windows switch to the `incognito` data store.
4. **Temp files.** Never plaintext. Recording, paste, drag-in, cover upload and Notion import into an encrypted vault all encrypt on the way in.
5. **Opening an attachment in another app** (Preview, a PDF reader) needs a plaintext file. It asks first ("A decrypted copy will be written to a temporary folder until the vault locks"), writes into a per-session temp dir, and deletes it on lock or quit. This is listed as a residual risk.
6. **Logs and crash reports** never contain content or names. A test greps the logs for the canary.
7. **Clipboard.** Copy and paste go through the WebView. Native clipboard marking (concealed/transient on macOS, history exclusion on Windows) is a later hardening item and documented as residual.
8. **Spotlight and QuickLook** see only `.libere` blobs, so nothing is indexed or thumbnailed. This is better than today.

## 6. Unlock, lock, auto-lock

1. **Opening an encrypted vault** (from Welcome, recent vaults, or the Vault menu) shows an **Unlock** screen in the Welcome style. It has a passphrase field, then "Use Touch ID" (if this device has a slot), then "Use recovery key". If the keyring is unlocked and the vault is enrolled in it (§3.3), it opens without asking.
   - **A wrong passphrase** gives a plain error. There is no lockout counter; it would be pointless offline, since Argon2id is the rate limit.
2. **Lock** happens on:
   - Vault → Lock (with a shortcut);
   - idle for N minutes (Settings → Security, default 15, choices 1–60 or never);
   - system sleep;
   - screen lock;
   - app quit.

   Lock does the following, in order:
   1. Flush every pending save, encrypted. Auto save off doesn't matter here: an edit is never dropped (anti-goal).
   2. Stop any recording, keeping the take.
   3. Close the in-memory index.
   4. Clear editor states and undo history, Global View and search results from the UI.
   5. Zeroize keys.
   6. Show the Unlock screen.
3. **Device slot (Touch ID / Windows Hello).** The slot secret is stored as a Keychain item with `kSecAccessControlBiometryCurrentSet` + `WhenUnlockedThisDeviceOnly`, which is KeePassXC's approach (facts §5).
   - That needs the Data Protection keychain, which needs a provisioning-profile–signed app. So the device slot ships with **M8 packaging/signing**, not before.
   - Windows uses `KeyCredentialManager` sign-a-challenge → SHA-256 → KEK.
   - Re-enrolling a fingerprint invalidates the slot. The passphrase still works.

## 7. Creating, converting, exporting

- **New encrypted vault.**
  - **Entry points:** Welcome's "New vault" gains an "Encrypt this vault" switch, and the Vault menu gets "New encrypted vault…".
  - **Flow:** choose a folder → choose a passphrase (minimum 12 characters, strength hint, no composition rules, per NIST 800-63B) → see and confirm the recovery key → done.
- **Encrypt an existing vault.** Never in place. The steps are:
  1. Write an encrypted copy to a new folder (default `<name> (encrypted)`).
  2. Decrypt every file back and compare hashes.
  3. Open the copy.
  4. Offer to move the plaintext vault to the OS Trash, with the honest warning: copies may remain in free space, APFS/Time Machine snapshots, backups and sync history. Turn on FileVault/BitLocker, and rotate any secrets the notes contained (facts §7).
- **Export decrypted copy…** goes to a folder the user picks, with a warning.
- **Notion import into an encrypted vault.** A later phase. Until then, the importer offers only plain vaults.

## 8. Code architecture

- **New crate `liber-crypto`**, with no I/O and no Tauri. It holds:
  - keys and slots (create, unwrap, rewrap);
  - the keyring;
  - the file STREAM reader/writer (`Read + Seek` and `Write` adapters);
  - the name codec;
  - the header MAC;
  - vectors, property tests and fuzz targets.

  Dependencies, all MIT/Apache or BSD, all inside deny.toml's allow list: `aes-gcm`, `aes-siv`, `hkdf`, `sha2`, `hmac`, `argon2`, `x25519-dalek`, `ml-kem`, `zeroize`, `secrecy`, `region`, `getrandom`.
- **`liber-vault` gets a storage seam.**
  - A `Storage` trait with `PlainStorage` (today's behaviour, byte for byte) and `EncryptedStorage` (logical path ↔ ciphertext path, encrypt on write, decrypt on read).
  - Every direct `std::fs` use in the crates and in `src-tauri` is routed through `Vault`. The 25 files found by grep are listed in the plan.
  - Index, session, import, audio, asset protocol and commands all speak logical paths only.
  - The watcher translates ciphertext events to logical events.
- **The seam lands first, as its own phase with no behaviour change** (E2), proven by the full existing suite staying green.
- **Frontend:**
  - the Unlock and Lock screens;
  - a new Settings → Security category (auto-lock, slots: change passphrase, new recovery key, Touch ID on this device, keyring);
  - lock badges in recent vaults;
  - the "Encrypt this vault" switch and conversion flow.

## 9. What stays visible (documented, by design)

- The number of files and folders, and how they nest.
- Approximate file sizes (to 16 bytes per 64 KiB, plus the 48-byte header).
- Modification times, and which files change together. Sync history shows edit activity.
- That the folder is a Liber Linteum encrypted vault, and its Argon2id parameters.
- Swapping two ciphertext files, or restoring an older version of one, is not detected. Content isn't bound to its path, so that renames stay cheap (§4.3). An attacker who can write the folder can also simply delete files.

## 10. Testing

- **Primitives wiring:** RFC/NIST known-answer tests for AES-GCM, AES-SIV, HKDF, Argon2id and X25519, plus FIPS 203 vectors for ML-KEM.
- **Format:**
  - the frozen vectors (§4.4), checked by both readers;
  - property tests: round-trip at every size and chunk boundary; a range read equals the plaintext slice; flipping any byte fails; truncating at any point fails; swapping or duplicating chunks fails; a wrong key fails.
- **Fuzzing:** `cargo-fuzz` targets for the header, slots, file reader and name decoder. Run locally before each release; there is no CI yet.
- **Storage seam:** the entire existing Rust and e2e suite runs against `EncryptedStorage` as well, via a test-only switch.
- **Crash safety:** kill the process mid-write → the old or the new file is intact, never a broken one.
- **Canary leak test.** Create an encrypted vault containing a unique canary string in a note body, a file name, a folder name, an attachment and a recording. Then:
  1. Use it: index, search, Global View, covers, favourites.
  2. Lock and quit.
  3. Scan the vault dir, app data, the cache, temp and the WebView data dirs byte by byte for the canary.

  It must be absent outside decrypted views, both on macOS and in the Windows build.
- **Performance budgets** (Jose's Mac, 10 000 notes):
  - unlock to searchable ≤ 3 s, excluding the deliberate Argon2id time;
  - page open overhead ≤ 5 ms;
  - range reads ≥ 200 MB/s;
  - search p95 still ≤ 50 ms (NFR-03).

## 11. Documentation (deliverables, not afterthoughts)

1. `docs/security/vault-format-v1.md`: the byte-level format, for implementers.
2. `docs/security/threat-model.md`: §2 and §9 expanded, plus residual risks (§5.5, §5.7, Spotlight before conversion, snapshots, Windows pagefile without BitLocker, hibernation).
3. `docs/security/encryption-user-guide.md`, in plain words (en and es): what's protected, what isn't, why the recovery key matters, what to do if a passphrase leaks (rotate), and how to move between machines.
4. A section in `docs/architecture/index-and-database.md` on the in-memory index.
5. A hand-off doc per phase, as usual.

## 12. Assurance

- The feature is labelled **beta** in the UI until an external review of `liber-crypto` and the format spec is done. The review scope names the unaudited crates (`aes-siv`, `ml-kem`, `argon2`) and our composition.
- No custom primitives. Every construction is cited in the format spec: RFC 5869, RFC 5297, RFC 9106, FIPS 203, NIST SP 800-38D, and age STREAM.
- Each phase gets a fresh-context security review (Opus) in addition to the usual code review. Findings are fixed test-first.

## 13. Phases

| Phase | Delivers | Depends on |
|---|---|---|
| E1 | `liber-crypto`: keys, slots, STREAM, names, vectors, the Python cross-check, `vault-format-v1.md` | — |
| E2 | the storage seam in `liber-vault`, all fs access routed through it, no behaviour change | — (parallel with E1) |
| E3 | `EncryptedStorage`, the watcher, the in-memory index, asset range decryption, encrypted recording | E1, E2 |
| E4 | UI: create, unlock, lock, auto-lock, Settings → Security (passphrase and recovery), lock badges | E3 |
| E5 | converting and exporting, the keyring, key rotation | E4 |
| E6 | leak hardening: canary test, WebView cache spike, temp-dir handling, docs, review prep | E3–E5 |
| E7 | device slot: Touch ID and Windows Hello | M8 signing |
| later | share (`recipient` slots; OpenPGP export via rPGP, pure Rust and MIT/Apache per facts §2), per-page encryption, Notion import into encrypted vaults, the encrypted index snapshot if needed | — |

## 14. Calls I made (Jose to check)

1. AES-256-GCM chunked STREAM for content; AES-SIV for names; Argon2id for passphrases; HKDF everywhere else. No PGP inside the vault format. OpenPGP is a message format with no random access (facts §2).
2. Keep the folder tree visible (names hidden) rather than Cryptomator's flattened tree. It is simpler, and it syncs and recovers by hand better. The cost is that the shape leaks (§9).
3. A recovery key is mandatory for every vault and for the keyring.
4. The keyring is hybrid post-quantum (X25519 + ML-KEM-768).
5. The index is in memory for encrypted vaults; SQLCipher is rejected.
6. Converting always makes a copy; it never encrypts in place.
7. Touch ID / Windows Hello waits for M8 signing. A prompt-only shortcut is not shipped.
8. Default auto-lock is 15 minutes idle, plus sleep, screen lock and quit.

## 15. Builder check (fresh-context Opus reviewer, 2026-10-20)

It found two flaws and four gaps. All six are resolved in the text above as my calls:

1. **Nonce reuse in recordings (critical).** Fixed: writers only append, each chunk is written once, and fix-ups go to a new file with a fresh salt. Encrypted takes live in the vault and recover at that vault's next unlock (§4.2).
2. **The keyring vs "someone at the unlocked Mac".** Fixed: the keyring locks on the same triggers as vaults (§3.3).
3. **Rotation had no key id and no slot rules.** Fixed: epochs everywhere, a retiring key during rotation, a new recovery key on every rotation, Touch ID re-enrolled, the keyring slot re-added (§3.2, §4.2, §4.3).
4. **Sync conflict copies could hide notes.** Fixed: conflicts are detected and surfaced, unreadable names are listed and never deleted, and header conflicts are merged (§4.3).
5. **Keyring vault substitution.** Fixed: the keyring keeps a list of enrolled vaults and opens only those silently (§3.3).
6. **Losing `.liberdir` lost a folder's names.** Fixed: there is no id file; a folder's id is inside its own encrypted name (§4.1, §4.3).

The reviewer checked and found sound: per-write file keys with counter nonces, the STREAM last-flag, the HKDF subkey split, SIV bound to the parent, the slot AAD and the hybrid KEM combiner.

Left to the builder: Argon2 upper bounds, JSON canonicalisation, the recovery checksum, using the `x-wing` crate instead of the hand-built combiner, and deleting the old plaintext index after conversion.
