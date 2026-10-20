# Encryption E1: `liber-crypto` core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a pure-Rust crate, `liber-crypto`, that implements the v1 encrypted-vault format. It covers keys and slots, the vault header, the keyring, STREAM file contents and the name codec. The crate has no file system access and no Tauri, and is pinned by frozen vectors that a second implementation (Python) also checks.

**Architecture:**
- One crate, `crates/liber-crypto`, with one module per concern: `keys`, `recovery`, `slots`, `header`, `keyring`, `stream`, `names`, `fuzzing`.
- Every input arrives as bytes or through `Read`/`Write`/`Seek`. E2 and E3 will do the I/O.
- Every construction is a standard one used through an audited or widely used RustCrypto crate: HKDF, HMAC, Argon2id, AES-256-GCM STREAM (age's construction), AES-SIV (RFC 5297), and X-Wing.

**Tech Stack:** Rust 2024 (toolchain 1.99), RustCrypto crates, serde_json, data-encoding, proptest, and cargo-fuzz (out of workspace).

**Spec:** `docs/superpowers/specs/2026-10-20-encryption-design.md`: §3, §4 and §4.4 as amended by §15. E1 is the first row of §13. The facts behind the crate choices are in `docs/research/2026-10-20-encryption-facts.md`.

## Global Constraints

- **Exact dependency versions.** Each was checked on crates.io on 2026-10-20, and every licence is in `deny.toml`'s allow list. Add them to `[workspace.dependencies]` with these versions:

  | crate | version | licence |
  |---|---|---|
  | aes-gcm | 0.11.1 | Apache-2.0 OR MIT |
  | aes-siv | 0.8.0 | Apache-2.0 OR MIT |
  | hkdf | 0.13.0 | MIT OR Apache-2.0 |
  | hmac | 0.13.0 | MIT OR Apache-2.0 |
  | sha2 | 0.11.1 | MIT OR Apache-2.0 (already in the workspace) |
  | argon2 | 0.6.0, `default-features = false, features = ["alloc", "parallel", "zeroize"]` | MIT OR Apache-2.0 |
  | x-wing | 0.1.1, `features = ["zeroize"]` | Apache-2.0 OR MIT |
  | getrandom | 0.4.3, `features = ["sys_rng"]` | MIT OR Apache-2.0 |
  | rand_core | 0.10.1 | MIT OR Apache-2.0 |
  | zeroize | 1.9.1 | Apache-2.0 OR MIT |
  | subtle | 2.6.1 | BSD-3-Clause |
  | region | 4.0.1 | MIT |
  | data-encoding | 2.11.1 | MIT |

  The fuzz crate alone uses `libfuzzer-sys` 0.4.13, whose licence is `(MIT OR Apache-2.0) AND NCSA` and is not in the allow list. That is why the fuzz crate is excluded from the workspace and from `cargo deny`.
- **Unsafe code stays forbidden** (`[workspace.lints.rust] unsafe_code = "forbid"`). `region::lock` is a safe function; no `unsafe` block is allowed anywhere in the crate.
- **No dependency on** `std::fs`, Tauri, `liber-vault` or `liber-index`. The crate's only I/O is through the `Read`, `Write` and `Seek` traits.
- **Exact format values from spec §3–§4:**
  - VK is 256 bits; `vault_id` is 16 bytes.
  - Subkeys use HKDF-SHA-512 with salt = `vault_id`, info = `liber/v1/content`, `liber/v1/name` (64 bytes), `liber/v1/header` or `liber/v1/index`.
  - Slot wrap is AES-256-GCM with a random 12-byte nonce.
  - Argon2id default is m = 256 MiB, t = 3, p = 4, calibrated to 0.5–2 s, and never below m = 64 MiB, t = 3.
  - The recovery key is `LIBER-` followed by 52 Crockford base32 characters in groups of 4, plus a checksum group.
  - The file header is 48 bytes: `LIBER`, version 1, suite 1, log2 chunk size 16, a 32-byte salt, a u32 BE epoch, then 4 zero bytes. Chunks are 64 KiB.
  - The file key is HKDF-SHA-256(K_content, salt = file salt, info = `liber/v1/file`).
  - The chunk nonce is an 11-byte BE counter followed by a last-flag byte; the AAD is the 48-byte header.
  - Names use AES-SIV-256 with AD = four headers `vault_id`, `epoch` (u32 BE), `parent folder id`, kind (`b"f"` file, `b"d"` folder); the encoding is Base64url without padding. Files get the `.libere` suffix. A folder's plaintext is `folder_id ‖ name`. Names longer than 200 bytes become `<hash>.liberl` plus a `<hash>.libern` side file.
- **The writer only appends** (spec §4.2). `StreamWriter` is generic over `W: Write` only, never `Seek`, and each chunk is encrypted exactly once.
- **Signed commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never bypass signing.
- **The gate:** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` and `cargo deny check` all pass. In practice, run `$SP/check.sh all <worktree>`.

## Review Focus

1. **A plaintext that is an exact multiple of 64 KiB** (65 536 and 131 072 bytes). The last chunk is full and flagged last. No empty extra chunk is written. `len()` is exact. Test: Task 5, `exact_chunk_multiples`.
2. **Seeking, then reading across chunk boundaries.** Seek to 65 535 and read 3 bytes; seek to `len()` and read 0; seek backwards after reading the end; seek past the end. Each matches the plaintext slice, and seeking past the end reads 0 bytes. Test: Task 5, `seek_and_read_matches_slice`.
3. **The same text in different Unicode forms** (NFC vs NFD, which is what macOS returns for file names), for both passphrases and names. Each unlocks or decodes identically. Surrounding spaces in a passphrase are kept, not trimmed. Tests: Task 2 `passphrase_is_nfc_normalised_not_trimmed`, and Task 6 `nfd_and_nfc_names_encrypt_alike`.
4. **A recovery key typed loosely:** lower case, spaces instead of dashes, `O`/`I`/`L` typed for `0`/`1`, or the `LIBER-` prefix left out. All of these unlock. One wrong character fails with `RecoveryCode` (a typo), not `Authentication`. Test: Task 2, `recovery_parse_is_forgiving_and_checksummed`.
5. **A hostile header.** For each of these, the result is an error and never a panic, and Argon2 never runs on out-of-range parameters:
   - m = 64 GiB (`Params`);
   - an unknown slot type, which is kept and MAC'd, not dropped;
   - a missing field, or a non-base64 value (`BadFormat`);
   - a flipped MAC byte, after a successful unwrap (`Authentication`).

   Test: Task 3, `hostile_headers_fail_cleanly`.

---

### Task 1: Crate, secrets, randomness and subkeys

**Files:**
- Create: `crates/liber-crypto/Cargo.toml`, `crates/liber-crypto/src/lib.rs`, `src/error.rs`, `src/keys.rs`
- Modify: root `Cargo.toml` (add the workspace dependencies above, and `exclude = ["crates/liber-crypto/fuzz"]` under `[workspace]`)
- Test: unit tests in `src/keys.rs`

**Interfaces:**
- Produces:
  - `pub enum CryptoError { BadFormat(&'static str), UnsupportedVersion(u32), Authentication, Truncated, Params(&'static str), RecoveryCode, Io(std::io::Error), Json(serde_json::Error) }`. It uses `thiserror`, with `From<io::Error>` and `From<serde_json::Error>`.
  - `pub type Result<T> = std::result::Result<T, CryptoError>`.
  - `pub struct Secret<const N: usize>`: heap-allocated, zeroized on drop, with a best-effort `region::lock` guard. `Debug` prints `Secret<N>(…)`. It implements neither `Clone` nor `PartialEq`. Its methods:
    - `random() -> Self`
    - `from_bytes([u8; N]) -> Self`, which zeroizes the argument's copy where it can
    - `expose(&self) -> &[u8; N]`
  - `pub type VaultKey = Secret<32>`
  - `pub struct VaultId(pub [u8; 16])`, with `random()`. It derives `Clone, Copy, PartialEq, Eq, Debug`.
  - `pub struct Subkeys { pub content: Secret<32>, pub name: Secret<64>, pub header: Secret<32>, pub index: Secret<32> }`, with `Subkeys::derive(vk: &VaultKey, id: &VaultId) -> Subkeys`.
  - `pub(crate) fn random_bytes<const N: usize>() -> [u8; N]` and `pub(crate) fn rng() -> impl rand_core::CryptoRng`. The second wraps `getrandom::SysRng` in `rand_core::UnwrapErr`; verify that path on docs.rs.
  - `pub(crate) fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8]) -> Secret<32>` and `pub(crate) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32]`.

- [ ] **Step 1: Write the failing tests** in `src/keys.rs`:
  - `hkdf_sha256_matches_rfc5869_case_1`: IKM is 22 bytes of `0x0b`, salt `000102…0c`, info `f0…f9`, and the first 32 bytes of OKM equal `3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf`.
  - `subkeys_are_distinct_and_deterministic`: the same VK and id give the same four keys; the four keys differ from each other; a different `vault_id` gives different keys.
  - `secret_debug_hides_bytes`: `format!("{:?}", Secret::<32>::from_bytes([7; 32]))` does not contain `"7"`.
- [ ] **Step 2: Run** `cargo test -p liber-crypto`. Expected: compile errors or FAIL, because nothing exists yet.
- [ ] **Step 3: Implement** the Interfaces block above. `Subkeys::derive` uses `Hkdf::<Sha512>::new(Some(&id.0), vk.expose())` and expands each info label. The crate's `Cargo.toml` uses `[lints] workspace = true`, like `liber-vault`.
- [ ] **Step 4: Run** `cargo test -p liber-crypto && cargo deny check`. Expected: the tests PASS and deny prints `advisories ok, bans ok, licenses ok, sources ok`.
- [ ] **Step 5: Commit** with the message `feat(crypto): liber-crypto crate — secrets, vault key, HKDF subkeys (encryption E1)`.

### Task 2: Recovery codes and passphrase KDF

**Files:**
- Create: `src/recovery.rs`, `src/kdf.rs`
- Test: unit tests in those files

**Interfaces:**
- Consumes: `Secret`, `CryptoError` and `hkdf_sha256` (Task 1).
- Produces:
  - `pub struct RecoveryCode(Secret<32>)`, with these methods:
    - `generate() -> Self`
    - `to_display(&self) -> String`, which returns `LIBER-` followed by 14 groups of 4 separated by `-`: 13 data groups, then 1 checksum group. Display is 75 characters; `parse` accepts 56 characters bare or 61 with the prefix (hyphens and spaces ignored).
    - `parse(s: &str) -> Result<Self>`
    - `secret(&self) -> &Secret<32>`
  - `pub struct Argon2Params { pub m_kib: u32, pub t: u32, pub p: u32 }`, with these constants:
    - `DEFAULT = { 262144, 3, 4 }`
    - `FLOOR = { 65536, 3, 4 }`
    - the caps `MAX_M_KIB = 4_194_304`, `MAX_T = 32`, `MAX_P = 16`
  - `impl Argon2Params`:
    - `fn check(&self) -> Result<()>` returns `Params` when a value is above a cap, or `t == 0` or `p == 0`. Parsing calls it.
    - `fn check_floor(&self) -> Result<()>` is the creation-time check.
    - `fn calibrate_with(measure: impl FnMut(&Argon2Params) -> Duration) -> Argon2Params`
    - `fn calibrate() -> Argon2Params` measures for real.
  - `pub fn passphrase_kek(passphrase: &str, salt: &[u8; 32], p: &Argon2Params) -> Result<Secret<32>>`. It NFC-normalises (`unicode-normalization`, already in the workspace) and never trims.

- [ ] **Step 1: Write the failing tests:**
  - `recovery_round_trips`: `parse(to_display())` gives the same secret bytes.
  - `recovery_parse_is_forgiving_and_checksummed` (Review Focus 4):
    - lower case, spaces instead of dashes, `o`/`i`/`l` in place of `0`/`1`, and a missing `LIBER-` prefix all parse back to the same secret;
    - changing one data character gives `Err(CryptoError::RecoveryCode)`.
  - `recovery_display_shape`: it matches `^LIBER(-[0-9A-HJKMNP-TV-Z]{4}){14}$`.
  - `calibration_rules`:
    - with `measure` always 0.1 s, `t` rises until the measured time is ≥ 0.5 s, or reaches the cap;
    - with `measure` always 5 s, `m_kib` halves down to `FLOOR.m_kib` and no lower;
    - the result always passes `check_floor()`.
  - `params_caps`: `{ m_kib: 64 * 1024 * 1024, … }.check()` is `Err(Params)`.
  - `passphrase_is_nfc_normalised_not_trimmed` (Review Focus 3): run with tiny params `{ 8, 1, 1 }` (the KDF itself accepts them; only `check_floor` rejects them).
    - `"caf\u{e9}"` and `"cafe\u{301}"` give equal KEKs;
    - `" pass"` and `"pass"` give different KEKs.
- [ ] **Step 2: Run** `cargo test -p liber-crypto recovery kdf`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Crockford encoding:** a `data_encoding::Specification` with these symbols: `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. It translates lower-case letters to upper case, and `O→0`, `I→1`, `L→1`. 32 bytes encode to 52 characters.
  - **Checksum group:** the first 4 Crockford characters of `SHA-256("liber/v1/recovery-check" ‖ secret)`.
  - **Calibration:** start at `DEFAULT`. While a measurement exceeds 2 s and `m_kib > FLOOR.m_kib`, halve `m_kib`. Then, while a measurement is under 0.5 s and `t < MAX_T`, increase `t` by 1.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(crypto): recovery codes (Crockford + checksum) and Argon2id passphrase KEK with calibration`.

### Task 3: Slots and the vault header

**Files:**
- Create: `src/slots.rs`, `src/header.rs`
- Test: unit tests in `src/header.rs`

**Interfaces:**
- Consumes: Tasks 1 and 2. Task 3 defines `Unlock` and `NewSlot` **without** keyring variants, and `SlotKind::Keyring` as data only. Task 4 adds `Unlock::Keyring(&KeyringSecret)` and `NewSlot::Keyring(&KeyringPublic)`, plus their wrap and unwrap, so each task compiles on its own.
- Produces:
  - `pub enum SlotKind { Passphrase { params: Argon2Params, salt: [u8; 32] }, Recovery, Keyring { keyring_id: [u8; 16], enc: Vec<u8> }, Device { device_id: String } }`
  - `pub struct Slot { pub id: [u8; 16], pub kind: SlotKind, pub(crate) nonce: [u8; 12], pub(crate) wrapped: Vec<u8> }`
  - `pub enum Unlock<'a> { Passphrase(&'a str), Recovery(&'a RecoveryCode), Device(&'a Secret<32>) }`. Task 4 adds `Keyring(&'a KeyringSecret)`.
  - `pub enum NewSlot<'a> { Passphrase(&'a str, Argon2Params), Device { device_id: String, secret: &'a Secret<32> } }`. Task 4 adds `Keyring(&'a KeyringPublic)`. A recovery slot is only ever made by `create` or `new_recovery`.
  - `pub struct Unlocked { pub vk: VaultKey, pub subkeys: Subkeys, pub epoch: u32, pub retiring: Option<(u32, Subkeys)> }`, with `fn content_key(&self, epoch: u32) -> Option<&Secret<32>>`.
  - `pub struct VaultHeader { pub vault_id: VaultId, pub epoch: u32, pub slots: Vec<Slot>, retiring: Option<Retiring>, unknown_slots: Vec<serde_json::Value>, mac: [u8; 32] }`, with these methods:
    - `create(passphrase: &str, params: Argon2Params) -> Result<(VaultHeader, Unlocked, RecoveryCode)>`. It enforces `check_floor`; tests may use `pub(crate) fn create_unchecked`.
    - `parse(bytes: &[u8]) -> Result<VaultHeader>`. It checks the format, the version and the parameter caps, but not the MAC.
    - `unlock(&self, with: Unlock) -> Result<Unlocked>`. It unwraps the first slot of the matching type that opens, then verifies the MAC.
    - `to_bytes(&self, u: &Unlocked) -> Vec<u8>`. It recomputes the MAC.
    - `add_slot(&mut self, u: &Unlocked, s: NewSlot) -> Result<[u8; 16]>`
    - `remove_slot(&mut self, id: &[u8; 16]) -> Result<()>`. It refuses to remove the last passphrase or the recovery slot.
    - `new_recovery(&mut self, u: &Unlocked) -> Result<RecoveryCode>`
    - `merge_from(&mut self, other: &VaultHeader, u: &Unlocked) -> Result<usize>`. This is for a sync-conflict copy of `liber-vault.json` (spec §4.3). It adds every slot from `other` that is not already present (by id) and unwraps to the same VK at the same epoch, and returns how many it added. The caller then writes `to_bytes`.
  - **On-disk JSON** (`liber-vault.json`): `{"format":"liber-vault","version":1,"vault_id":b64,"epoch":n,"slots":[…],"retiring":null|{"epoch":n,"nonce":b64,"wrapped":b64},"mac":b64}`. Each slot is `{"id":b64,"type":"passphrase"|"recovery"|"keyring"|"device"|…,"nonce":b64,"wrapped":b64, …kind fields}`. The passphrase kind fields are `"kdf":{"alg":"argon2id","m_kib","t","p","salt"}`. All binary values are Base64url without padding.
  - **The MAC** is `HMAC-SHA-256(K_header, canonical)`. `canonical` is the header as a `serde_json::Value` without `"mac"`, serialised compactly. serde_json's default `Map` sorts keys; the workspace doesn't enable `preserve_order`, and a test pins that. In Python this is `json.dumps(v, sort_keys=True, separators=(",",":"))`.
  - **Slot AAD** is `"liber/v1/slot" ‖ vault_id ‖ epoch (u32 BE) ‖ slot id ‖ type as ASCII`.
  - **KEKs:**
    - passphrase: `passphrase_kek`;
    - recovery: `hkdf_sha256(secret, vault_id, "liber/v1/slot/recovery")`;
    - device: `hkdf_sha256(secret, vault_id, "liber/v1/slot/device")`;
    - keyring: Task 4.
  - **Retiring:** the old VK, wrapped with AES-256-GCM under KEK = `hkdf_sha256(new VK, vault_id, "liber/v1/retiring")`, with AAD `"liber/v1/retiring" ‖ vault_id ‖ old epoch`. This task adds `pub fn begin_rotation(&mut self, u: &Unlocked, passphrase: &str, params: Argon2Params) -> Result<(Unlocked, RecoveryCode)>` and `pub fn finish_rotation(&mut self, u: &Unlocked) -> Result<()>`. Running a rotation over the files is E5. The slot rules (§3.2) are:
    - the passphrase is re-entered;
    - the recovery key is new;
    - device slots are dropped;
    - keyring slots are kept only if the caller re-adds them.

- [ ] **Step 1: Write the failing tests:**
  - `create_unlock_with_passphrase_and_recovery`: tiny params; both unlock paths give the same `vk`. A wrong passphrase gives `Authentication`.
  - `add_and_remove_device_slot`: removing it works; removing the only passphrase slot is refused.
  - `header_json_round_trips_and_is_canonical`: `parse(to_bytes)` then `to_bytes` gives byte-identical output. Re-parsing a re-indented copy (with `serde_json::to_vec_pretty`) still unlocks.
  - `hostile_headers_fail_cleanly` (Review Focus 5): table-driven, with these cases:
    - `m_kib` = 64 GiB → `Params`, before any KDF runs. Use a counter on `passphrase_kek` through a `#[cfg(test)]` hook, or assert that it completes in under 50 ms.
    - an unknown slot type parses and survives `to_bytes`.
    - a missing `vault_id`, or `"!!"` as base64 → `BadFormat`.
    - a flipped MAC byte → `Authentication`.
    - `"version":2` → `UnsupportedVersion(2)`.
  - `merge_keeps_valid_slots_only`:
    - copy A gains a device slot and copy B gains another;
    - `A.merge_from(&B, u)` returns 1, and both device secrets then unlock;
    - a slot in B that wraps a different VK is not added.
  - `rotation_keeps_old_epoch_readable`: after `begin_rotation`, `unlock` gives `epoch = 2` and `retiring = Some((1, …))`, and `content_key(1)` equals the old `Subkeys.content`. After `finish_rotation`, `content_key(1)` is `None`.
- [ ] **Step 2: Run** `cargo test -p liber-crypto header`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `aes_gcm::Aes256Gcm` with `aead::Aead` and `KeyInit`, the 0.11 API; check the import paths on docs.rs. Compare MACs with `subtle::ConstantTimeEq`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(crypto): key slots and the vault header (canonical JSON + HMAC, epochs, rotation fields)`.

### Task 4: The keyring

**Files:**
- Create: `src/keyring.rs`
- Modify: `src/slots.rs`, filling in the `Keyring` wrap and unwrap
- Test: unit tests in `src/keyring.rs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - **Hybrid KEM: `x_wing::XWingKem`.** *Ruling:* this replaces the spec's hand-built combiner. X-Wing is the standard X25519 + ML-KEM-768 hybrid (draft-connolly-cfrg-xwing-kem, the same KEM as age 1.3's `mlkem768x25519`). It binds both ciphertexts and both public keys, so we write no combiner of our own (anti-goal 1). It is unaudited, as `ml-kem` is.
  - `pub struct KeyringPublic { pub keyring_id: [u8; 16], pub ek: x_wing::EncapsulationKey }`
  - `pub struct KeyringSecret { keyring_id: [u8; 16], seed: Secret<32>, mac_key: Secret<32>, commit_key: Secret<32> }`. The decapsulation key is `DecapsulationKey::from(*seed.expose())`. `mac_key = hkdf_sha256(seed, keyring_id, "liber/v1/keyring/mac")` and `commit_key = hkdf_sha256(seed, keyring_id, "liber/v1/keyring/commit")`.
  - `pub struct KeyringFile`. Its JSON is `{"format":"liber-keyring","version":1,"keyring_id","public","slots":[passphrase, recovery, device…],"enrolled":[{"vault_id","commit"}],"mac"}`. It uses the same canonical-JSON MAC as the vault header, under `mac_key`. Slots wrap `seed` with AAD `"liber/v1/keyring-slot" ‖ keyring_id ‖ slot id ‖ type`. Its methods:
    - `create(passphrase, params) -> Result<(KeyringFile, KeyringSecret, RecoveryCode)>`
    - `parse(&[u8]) -> Result<KeyringFile>`
    - `unlock(&self, Unlock) -> Result<KeyringSecret>`
    - `public(&self) -> KeyringPublic`
    - `to_bytes(&self, &KeyringSecret) -> Vec<u8>`
    - `enroll(&mut self, s: &KeyringSecret, vault_id: &VaultId, k_header: &Secret<32>)`
    - `is_enrolled(&self, s: &KeyringSecret, vault_id: &VaultId, k_header: &Secret<32>) -> bool`. The commit is `HMAC-SHA-256(commit_key, vault_id ‖ k_header)`, compared in constant time.
  - **Vault keyring slot:** `enc` is the X-Wing ciphertext, and the KEK is `hkdf_sha256(shared_secret, vault_id, "liber/v1/slot/keyring" ‖ slot id)`.

- [ ] **Step 1: Write the failing tests:**
  - `keyring_slot_opens_vault`: add a keyring slot from `public()` alone, without unlocking the keyring. Unlocking the vault with `Unlock::Keyring` then gives the same VK.
  - `enrolled_only` (§15 flaw 5):
    - a second vault made by "an attacker" with its own VK and a keyring slot to the same public key unlocks with `Unlock::Keyring`;
    - `is_enrolled` is false for it;
    - after `enroll` of the real vault, `is_enrolled` is true for the real vault and still false for the attacker's.
  - `keyring_file_round_trips_and_mac_checked`: flipping an `enrolled` byte gives `Authentication` on `unlock`.
- [ ] **Step 2: Run** `cargo test -p liber-crypto keyring`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `kem::{Encapsulate, Decapsulate}` with the RNG from `rng()`, since the `getrandom` feature isn't enabled. Check the RNG-taking method name for kem 0.3 on docs.rs. Add `Unlock::Keyring` and `NewSlot::Keyring` here (see Task 3).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(crypto): keyring (X-Wing hybrid KEM) with enrolled-vault commitments`.

### Task 5: STREAM file contents

**Files:**
- Create: `src/stream.rs`
- Test: unit tests in `src/stream.rs`, and `crates/liber-crypto/tests/stream_props.rs` (proptest)

**Interfaces:**
- Consumes: `Secret<32>`, `hkdf_sha256`, `random_bytes`.
- Produces:
  - `pub const HEADER_LEN: usize = 48; pub const CHUNK_LEN: usize = 65_536; pub const TAG_LEN: usize = 16;`
  - `pub struct StreamWriter<W: Write>`, which implements `Write`:
    - `new(inner: W, content: &Secret<32>, epoch: u32) -> io::Result<Self>` writes the header immediately.
    - `pub(crate) fn with_salt(…, salt: [u8; 32])` is for vectors.
    - `finish(self) -> io::Result<W>` writes the last chunk.
    - It keeps up to one full chunk buffered (`Zeroizing<Vec<u8>>`). A full chunk is emitted only when a further byte arrives, because only `finish` knows which chunk is last. Dropping without `finish` leaves the file truncated, by design.
  - `pub struct StreamReader<R: Read + Seek>`, which implements `Read + Seek` over the plaintext:
    - `open(inner: R, key_for_epoch: impl Fn(u32) -> Option<&Secret<32>>) -> Result<Self>`
    - `len(&self) -> u64` and `epoch(&self) -> u32`
    - The length comes from the ciphertext length. An empty file is 48 + 16 bytes. A remainder of 1–16 bytes after the full chunks is `Truncated`.
  - `pub fn header_epoch(head: &[u8]) -> Result<u32>` reads the epoch for rotation and conflict code.
  - `pub fn salvage<R: Read>(inner: R, key_for_epoch: impl Fn(u32) -> Option<&Secret<32>>) -> Result<Salvaged>`, with `pub struct Salvaged { pub plaintext: Zeroizing<Vec<u8>>, pub complete: bool }`. It decrypts consecutive chunks until one fails or the input ends. `complete` is true only if a valid last-flagged chunk ended the stream (§4.2, recordings).
  - **Errors:**
    - a bad magic or `log2 != 16` → `BadFormat`;
    - `version != 1` → `UnsupportedVersion`;
    - an unknown epoch, or any tag failure → `Authentication`;
    - a stream whose last chunk is missing or unflagged → `Truncated`.

- [ ] **Step 1: Write the failing tests:**
  - `round_trip_sizes`: sizes 0, 1, 65 535, 65 536, 65 537, 131 072 and 200 000 round-trip, and `len()` equals the size.
  - `exact_chunk_multiples` (Review Focus 1): for 65 536 and 131 072, the ciphertext length is `48 + n·65 552`, so no extra empty chunk.
  - `seek_and_read_matches_slice` (Review Focus 2): the cases listed in the Review Focus.
  - `tamper_truncate_reorder_fail`, on 200 000 bytes:
    - flipping any byte at positions `[0, 7, 47, 48, 100, 65 600, end-1]` gives `BadFormat` or `Authentication` on a full read;
    - cutting the file at `48 + 65 552` gives `Truncated`;
    - swapping chunks 0 and 1 gives `Authentication`;
    - the key for a different epoch gives `Authentication`.
  - `fresh_salt_per_write`: encrypting the same plaintext twice gives different ciphertexts.
  - `salvage_recovers_complete_chunks`: a writer that is dropped after 3.5 chunks salvages 3 × 65 536 bytes with `complete = false`. A finished stream salvages everything with `complete = true`.
  - In `tests/stream_props.rs`, the proptest `prop_round_trip_and_ranges` (256 cases, sizes 0..300 000, a random seek and length) round-trips, and range reads equal the plaintext slice.
- [ ] **Step 2: Run** `cargo test -p liber-crypto stream`. Expected: FAIL.
- [ ] **Step 3: Implement.** The nonce for chunk `i` is `[0, 0, 0] ‖ i.to_be_bytes()` (an 11-byte big-endian counter from a u64) followed by `[last as u8]`. Encrypt with `Aes256Gcm` under `K_f`, with the 48-byte header as AAD.
- [ ] **Step 4: Run** `cargo test -p liber-crypto stream --release`. Use release mode because the proptest is heavy. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(crypto): STREAM file format — append-only writer, seekable reader, salvage (spec §4.2)`.

### Task 6: The name codec

**Files:**
- Create: `src/names.rs`
- Test: unit tests in `src/names.rs`

**Interfaces:**
- Consumes: `Secret<64>` (`Subkeys.name`), `VaultId`.
- Produces:
  - `pub struct FolderId(pub [u8; 16])`. It has `pub const ROOT: FolderId = FolderId([0; 16])` and `random()`, and derives `Clone, Copy, Eq, PartialEq, Hash, Debug`.
  - `pub struct NameCodec<'a> { key: &'a Secret<64>, vault_id: &'a VaultId, epoch: u32 }`, with these methods:
    - `new(key: &'a Secret<64>, vault_id: &'a VaultId, epoch: u32) -> Self`
    - `encrypt_file(&self, parent: &FolderId, name: &str) -> String`. The result ends in `.libere`.
    - `decrypt_file(&self, parent: &FolderId, on_disk: &str) -> Result<String>`
    - `encrypt_folder(&self, parent: &FolderId, id: &FolderId, name: &str) -> String`
    - `decrypt_folder(&self, parent: &FolderId, on_disk: &str) -> Result<(FolderId, String)>`
  - `pub const LONG_NAME_LIMIT: usize = 200;`
  - `pub fn shorten(encoded: &str) -> Option<ShortName>`, with `pub struct ShortName { pub on_disk: String, pub side_file: String, pub side_contents: String }`.
    - `on_disk` is `<h>.liberl`, where `<h>` is the lower-case base32 (no padding) of SHA-256(encoded), cut to 32 characters.
    - `side_file` is `<h>.libern`.
    - `side_contents` is the full encoded name. It is already ciphertext, so it needs no second layer. *Ruling:* the spec says "encrypted side file"; this is that, without double encryption.
  - `pub fn strip_conflict(on_disk: &str) -> Option<ConflictName>`, with `pub struct ConflictName { pub original: String, pub label: String }`. It recognises these suffixes:
    - Dropbox ` (… conflicted copy …)`;
    - iCloud ` 2`, ` 3`, …;
    - Google Drive ` (1)`;
    - Syncthing `.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX`.

    Each may come before or after `.libere`. None of these suffix characters (space, `(`, `.`) are in the Base64url alphabet, so detection can't misfire on a real name.
  - **Decrypted names are validated:** an empty name, `.`, `..`, or a name containing `/`, `\` or NUL gives `BadFormat`. This guards against path traversal once vaults can be shared.
  - Names are NFC-normalised before encryption.

- [ ] **Step 1: Write the failing tests:**
  - `file_and_folder_round_trip`.
  - `same_name_different_parent_differs`.
  - `folder_rename_keeps_id`: re-encrypting a folder with a new name and the same id gives a different on-disk name, and decrypting it returns the same id.
  - `wrong_parent_or_epoch_fails`: each gives `Authentication`.
  - `nfd_and_nfc_names_encrypt_alike` (Review Focus 3): `"Canci\u{f3}n.md"` and `"Cancio\u{301}n.md"` give the same on-disk name.
  - `long_names_shorten`: a 180-character name produces an encoded name over 200, and `shorten` returns `Some`, with `on_disk.len() == 32 + 7`. A short name returns `None`.
  - `conflict_suffixes`: a table covering each provider pattern, plus a plain encoded name that returns `None`.
  - `rejects_traversal_names`: encrypting `".."` through a test helper that skips validation, then decrypting, gives `BadFormat`.
- [ ] **Step 2: Run** `cargo test -p liber-crypto names`. Expected: FAIL.
- [ ] **Step 3: Implement** with `aes_siv::siv::Aes256Siv` and its `encrypt(headers, plaintext)` / `decrypt(headers, ciphertext)` methods, where headers = `[vault_id, epoch BE, parent id]`, and `data_encoding::BASE64URL_NOPAD`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(crypto): name codec — AES-SIV names bound to parent and epoch, folder ids inside folder names, long names, conflict suffixes`.

### Task 7: Frozen vectors and the Python cross-check

**Files:**
- Create:
  - `crates/liber-crypto/tests/vectors/v1/vectors.json`
  - `tests/vectors/v1/header.json`
  - `tests/vectors/v1/file-{0,1,65535,65536,200000}.libere`
  - `crates/liber-crypto/tests/xcheck/xcheck.py`
  - `src/vectors.rs` (a `#[cfg(test)]` module)
- Test: `src/vectors.rs`

**Interfaces:**
- Consumes: the crate-private deterministic constructors (`with_salt`, `create_unchecked`, fixed slot nonces) from Tasks 3–6.
- Produces:
  - `vectors.json`:
    - `vk`, `vault_id`, `epoch`;
    - the four subkeys in hex;
    - `passphrase` = `"correct horse ⚡ batterie"`, with params `{ m_kib: 64, t: 1, p: 1 }`, kept tiny so Python runs quickly;
    - the recovery code;
    - `names`: a list of `{parent, name, kind, on_disk, folder_id?}`, including an NFD input and a long name;
    - `files`: a list of `{name, plaintext_rule: "i % 251", len, salt}`.

- [ ] **Step 1: Write the failing tests:**
  - `vectors_are_stable`: regenerate every value from the fixed inputs and compare it byte for byte with the committed files.
    - `REGEN=1 cargo test -p liber-crypto vectors_are_stable` rewrites the files. It only does so with `REGEN=1`.
    - The first run writes the files. Re-running without `REGEN` must pass.
    - Then hand-edit one byte, check that the test FAILs, and revert the edit.
  - `python_cross_check`:
    - It runs `python3 -I tests/xcheck/xcheck.py tests/vectors/v1`.
    - If `python3` is missing, or the script exits 77 because `cryptography` won't import, the test prints `SKIP: python3 + cryptography not available` and passes.
    - Any other non-zero exit fails.
- [ ] **Step 2: Write `xcheck.py`** (about 150 lines, standard library plus `cryptography`). It checks:
  - the subkeys (HKDF from `cryptography.hazmat.primitives.kdf.hkdf`);
  - every name (`AESSIV(key).decrypt(ct, [vault_id, epoch, parent])`);
  - every file (it parses the 48-byte header, derives `K_f`, decrypts each chunk with `AESGCM`, and compares with `i % 251`);
  - the header MAC (`json.dumps(sort_keys=True, separators=(",",":"))` plus HMAC);
  - the recovery slot unwrap;
  - the passphrase slot unwrap, only if `cryptography.hazmat.primitives.kdf.argon2` exists (cryptography ≥ 44).

  It does not cover X-Wing; its output says so explicitly.
- [ ] **Step 3: Run it for real once.**
  1. `python3 -m venv $SP/xcheck-venv && $SP/xcheck-venv/bin/pip install cryptography`. This is the one-time network use, on a dev machine only.
  2. `$SP/xcheck-venv/bin/python -I crates/liber-crypto/tests/xcheck/xcheck.py crates/liber-crypto/tests/vectors/v1`.

  Expected: `xcheck: subkeys ok, names ok (n), files ok (5), header mac ok, recovery ok, passphrase ok; keyring not covered`.
- [ ] **Step 4: Run** `cargo test -p liber-crypto vectors`. Expected: PASS. Without the venv, `python_cross_check` prints SKIP.
- [ ] **Step 5: Commit** with the message `test(crypto): frozen v1 vectors and an independent Python reader (spec §4.4)`.

### Task 8: Fuzz targets

**Files:**
- Create:
  - `src/fuzzing.rs` (`#[doc(hidden)] pub mod fuzzing`)
  - `crates/liber-crypto/tests/fuzz_smoke.rs`
  - `crates/liber-crypto/fuzz/Cargo.toml`, with its own `[workspace]` table and `libfuzzer-sys = "0.4.13"`
  - `fuzz/fuzz_targets/{header,keyring,stream,names}.rs`

**Interfaces:**
- Produces `pub fn fuzz_header(data: &[u8])`, `fuzz_keyring`, `fuzz_stream` and `fuzz_names`. Each feeds `data` to the parser or reader with fixed keys and ignores the `Result`; a panic is the only failure. Each cargo-fuzz target calls the matching function.

- [ ] **Step 1: Write the failing test.** `tests/fuzz_smoke.rs` is a proptest with 2 000 cases of arbitrary `Vec<u8>` (up to 4 KiB, plus valid-prefix mutations of the Task 7 vectors) into each `fuzz_*` function.
- [ ] **Step 2: Run** `cargo test -p liber-crypto --release fuzz_smoke`. Expected: FAIL to compile, since `fuzzing` doesn't exist yet. After Step 3 it must PASS. Any panic it finds becomes a regression test in the owning module.
- [ ] **Step 3: Implement** `fuzzing.rs` and the four cargo-fuzz targets. Check that the targets build with `cd crates/liber-crypto/fuzz && cargo +nightly fuzz build`. If no nightly toolchain is installed, record that in the ledger as a ruling. Running them is manual and documented in Task 9.
- [ ] **Step 4: Run** `cargo test --workspace && cargo deny check`. Expected: PASS. The fuzz crate is excluded, so `libfuzzer-sys`'s NCSA licence never reaches deny.
- [ ] **Step 5: Commit** with the message `test(crypto): fuzz targets (cargo-fuzz, out of workspace) and a stable proptest smoke over the same entry points`.

### Task 9: `docs/security/vault-format-v1.md`

**Files:**
- Create: `docs/security/vault-format-v1.md`
- Modify: `docs/README.md` (link it); spec §16 (an "As built (E1)" note listing any rulings)

- [ ] **Step 1: Write the format document.** A third party must be able to implement a reader from it alone. It covers:
  - the folder layout;
  - the vault header JSON schema and canonical-MAC rule;
  - every slot type with its KEK derivation and AAD bytes;
  - the keyring file and the X-Wing reference (draft revision 06);
  - the 48-byte file header table, the chunk nonce and AAD, the length rules and the errors;
  - the name codec (file and folder plaintexts, AD order, encodings, long names, conflict suffixes);
  - epochs and the retiring key;
  - the exact HKDF info strings;
  - the Argon2id parameters, floors and caps;
  - the recovery-code alphabet and checksum;
  - the cited standards: RFC 5869, RFC 5297, RFC 9106, NIST SP 800-38D, the age STREAM spec, the X-Wing draft and FIPS 203;
  - how to run the fuzzers;
  - a "not covered by the Python reader" list.

  Every value in it must match the code and the vectors.
- [ ] **Step 2: Check the document against the code.** Follow the document by hand to decrypt `file-1.libere` from the vectors. The Python reader is the executable form of this check, so `xcheck.py` must cite the doc's section numbers in its comments.
- [ ] **Step 3: Run** `$SP/check.sh all <worktree>`. Expected: `ALL-OK`.
- [ ] **Step 4: Commit** with the message `docs(security): vault format v1 — byte-level spec for implementers (encryption E1)`.
