# Liber Linteum encrypted vault format, version 1

Status: **frozen with the v1 test vectors** (encryption phase E1, 2026-10-20). Any change to a value in this document is a format change. It needs a new version number and regenerated vectors.

This is the byte-level description of an encrypted Liber Linteum vault. It is written so that someone can build a compatible reader from this document alone, without reading our Rust code. The reference implementation is the `liber-crypto` crate (`crates/liber-crypto/src/`). The frozen vectors are in `crates/liber-crypto/tests/vectors/v1/`. An independent Python reader, `crates/liber-crypto/tests/xcheck/xcheck.py`, decrypts those vectors and cites this document section by section. Where the design spec (`docs/superpowers/specs/2026-10-20-encryption-design.md`) disagrees with this document, this document and the vectors win. The spec's §16 lists those differences.

Contents:

1. [Conventions](#1-conventions)
2. [Cited standards](#2-cited-standards)
3. [Folder layout and file names](#3-folder-layout-and-file-names)
4. [Keys and HKDF labels](#4-keys-and-hkdf-labels)
5. [Canonical JSON and the MAC rule](#5-canonical-json-and-the-mac-rule)
6. [The vault header `liber-vault.json`](#6-the-vault-header-liber-vaultjson)
7. [Key slots](#7-key-slots)
8. [Argon2id parameters](#8-argon2id-parameters)
9. [Recovery codes](#9-recovery-codes)
10. [Epochs, rotation and the retiring key](#10-epochs-rotation-and-the-retiring-key)
11. [Changing the header: removal, tombstones, merging](#11-changing-the-header-removal-tombstones-merging)
12. [The keyring file `keyring.liberk`](#12-the-keyring-file-keyringliberk)
13. [File contents (STREAM)](#13-file-contents-stream)
14. [Names](#14-names)
15. [Memory hygiene and residual library limits](#15-memory-hygiene-and-residual-library-limits)
16. [Test vectors and the Python reader](#16-test-vectors-and-the-python-reader)
17. [Fuzzing](#17-fuzzing)
18. [Worked example: decrypting `file-1.libere`](#18-worked-example-decrypting-file-1libere)

## 1. Conventions

- `‖` is byte concatenation. `"text"` in a byte formula means the ASCII bytes of that text, with no length prefix and no terminator.
- **u32 BE** is a 4-byte unsigned big-endian integer. The epoch is always written that way inside byte strings.
- **Base64url** is RFC 4648 §5 (`A–Z a–z 0–9 - _`) **without padding**. Decoders must be strict, like the reference: reject `=`, reject characters outside the alphabet, and reject encodings whose unused trailing bits are not zero. Every binary value in the JSON files is Base64url, and every one has a fixed or bounded length (§6, §12).
- **Hex** (lowercase) appears only in `vectors.json`, never in vault files.
- "Must" is normative. "The reference" means `liber-crypto` as built in E1.
- Errors are named after the reference's `CryptoError` variants: `BadFormat`, `UnsupportedVersion`, `Authentication`, `Truncated`, `Params`, `RecoveryCode`, `Io`, `Json`. A compatible reader doesn't need the same names, but it should keep the same distinctions. In particular, `Truncated` and `Authentication` mean different things to the user (§13.6).

## 2. Cited standards

| Standard | Used for |
|---|---|
| RFC 5869, HKDF | every derived key (§4), with SHA-512 for the subkeys and SHA-256 elsewhere |
| RFC 2104 / FIPS 198-1, HMAC; FIPS 180-4, SHA-2 | the header and keyring MACs, the keyring commitments, the recovery checksum, the long-name hash |
| NIST SP 800-38D, AES-GCM | key-slot wrapping (§7.1) and file chunks (§13), always AES-256 with a 12-byte nonce and a 16-byte tag |
| age STREAM ([age v1 spec](https://age-encryption.org/v1), C2SP `age.md`; Hoang, Reyhanitabar, Rogaway and Vizár, 2015) | the chunk nonce layout and the last-chunk flag (§13) |
| RFC 5297, AES-SIV | file and folder names (§14), AES-SIV with a 512-bit key ("AES-SIV-256") |
| RFC 9106, Argon2 | the passphrase KEK (§8), Argon2id version 0x13 |
| [draft-connolly-cfrg-xwing-kem-06](https://datatracker.ietf.org/doc/html/draft-connolly-cfrg-xwing-kem-06), X-Wing | the keyring KEM (§12): X25519 + ML-KEM-768. The reference uses the `x-wing` 0.1.1 crate, which implements **draft revision 06** |
| FIPS 203, ML-KEM | the ML-KEM-768 half of X-Wing |
| RFC 4648 | Base64url (§1) and the base32 long-name hash (§14.5) |
| Crockford base32 | the recovery code (§9) |
| Unicode UAX #15, NFC | passphrases (§8) and names (§14) |

## 3. Folder layout and file names

E1 builds only the cryptography; it does no file I/O. The layout below is the one the spec (§4.1) fixes and phase E3 writes:

```
My Vault/                      ← the folder the user picks
  liber-vault.json             ← the vault header (§6): slots and a MAC, no secrets
  README.txt                   ← plaintext note: "Encrypted Liber Linteum vault. Open it with Liber Linteum."
  d/                           ← everything else, names encrypted (§14)
    <enc-folder-name>/         ← a folder (its encrypted name carries its id)
      <enc-file-name>.libere   ← a file (STREAM, §13)
      <hash>.liberl            ← an entry whose encoded name is too long (§14.5)
      <hash>.libern            ← its side file, holding the full encoded name
```

The keyring (§12) is one file, `keyring.liberk`, in the app's data directory, not in any vault.

| Name or suffix | Meaning |
|---|---|
| `liber-vault.json` | vault header, JSON, `"format": "liber-vault"` |
| `keyring.liberk` | keyring, JSON, `"format": "liber-keyring"` |
| `LIBER` | the 5-byte magic at the start of every encrypted file |
| `.libere` | an encrypted file whose name is the Base64url SIV ciphertext |
| `.liberl` | an entry whose encoded name was longer than 200 bytes |
| `.libern` | the side file next to a `.liberl` entry |
| `LIBER-` | the prefix of a displayed recovery code |

Folders have no suffix. `.liber/`, `.trash/`, `.archive/` and the Scratchpad are ordinary encrypted folders under `d/`.

## 4. Keys and HKDF labels

### 4.1 Vault key and subkeys

The **vault key** VK is 32 random bytes from the OS CSPRNG. It is never stored unwrapped. Each vault also has a random, public 16-byte `vault_id`.

All working keys come from VK with **HKDF-SHA-512** (RFC 5869), IKM = VK, salt = `vault_id`:

| Key | info | Length |
|---|---|---|
| K_content | `liber/v1/content` | 32 |
| K_name | `liber/v1/name` | 64 |
| K_header | `liber/v1/header` | 32 |
| K_index | `liber/v1/index` | 32 (reserved for an encrypted index snapshot; unused in v1 files) |

During a rotation (§10) a vault has two vault keys, one per epoch, and so two sets of subkeys.

### 4.2 Every label in the format

All are ASCII, with no terminator. HKDF rows list (hash, IKM, salt, info, output length). "Slot id" is the slot's raw 16 bytes.

| Label | Where | Exact use |
|---|---|---|
| `liber/v1/content` | §4.1 | HKDF-SHA-512(VK, vault_id, info, 32) |
| `liber/v1/name` | §4.1 | HKDF-SHA-512(VK, vault_id, info, 64) |
| `liber/v1/header` | §4.1 | HKDF-SHA-512(VK, vault_id, info, 32) |
| `liber/v1/index` | §4.1 | HKDF-SHA-512(VK, vault_id, info, 32) |
| `liber/v1/file` | §13.2 | HKDF-SHA-256(K_content, file salt, info, 32) |
| `liber/v1/slot` | §7.1 | vault slot AAD prefix |
| `liber/v1/slot/recovery` | §7.3 | HKDF-SHA-256(recovery secret, vault_id, info, 32) |
| `liber/v1/slot/device` | §7.4 | HKDF-SHA-256(device secret, vault_id, info, 32) |
| `liber/v1/slot/keyring` | §7.5 | HKDF-SHA-256(X-Wing shared secret, vault_id, info ‖ slot id, 32): the info is 21 + 16 = 37 bytes |
| `liber/v1/retiring` | §10 | the KEK info, HKDF-SHA-256(new VK, vault_id, info, 32), **and** the AAD prefix |
| `liber/v1/recovery-check` | §9 | SHA-256 domain prefix for the recovery checksum |
| `liber/v1/keyring-slot` | §12.3 | keyring slot AAD prefix |
| `liber/v1/keyring-slot/recovery` | §12.3 | HKDF-SHA-256(recovery secret, keyring_id, info, 32) |
| `liber/v1/keyring-slot/device` | §12.3 | HKDF-SHA-256(device secret, keyring_id, info, 32) |
| `liber/v1/keyring/mac` | §12.4 | HKDF-SHA-256(keyring seed, keyring_id, info, 32) |
| `liber/v1/keyring/commit` | §12.5 | HKDF-SHA-256(keyring seed, keyring_id, info, 32) |

## 5. Canonical JSON and the MAC rule

Both JSON files (`liber-vault.json`, `keyring.liberk`) carry `"mac"`: HMAC-SHA-256 over the **canonical JSON** of the file's object **without the `"mac"` member**.

Canonical JSON is exactly what `serde_json::to_vec` writes for a `serde_json::Value` (without `preserve_order`):

- object members **sorted by key**, by the UTF-8 bytes of the key (the same order as Unicode code points);
- **compact**: no whitespace anywhere, `,` and `:` as separators;
- strings as **raw UTF-8**. Only `"` → `\"`, `\` → `\\` and the control characters U+0000–U+001F are escaped: `\b \t \n \f \r` for those five, and `\u00xx` with lowercase hex for the rest. Nothing else is escaped: not `/`, not U+007F, not non-ASCII;
- integers in plain decimal; `null`, `true` and `false` as written; arrays keep their order.

In Python that is `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()`. The default `ensure_ascii=True` escapes non-ASCII and breaks the MAC (the vectors' device id `José's MacBook` catches this).

**What is MACed.** The reference rebuilds the object from what it parsed, then MACs that:

- the top-level members are exactly the ones §6 (or §12) lists; unknown top-level members, and unknown members inside known slots, are dropped;
- known slots are re-serialised from their parsed values, and unknown slot types are kept verbatim at their original index in `slots` (§7.6);
- `removed` (§6) and `enrolled` (§12) are sorted and de-duplicated first.

A writer always writes the canonical form with `"mac"` added (sorted in among the other keys) and nothing else: no BOM and no trailing newline. For a file a conforming writer produced, "drop `mac`, canonicalise the rest" gives the same bytes. The vectors are canonical, and `xcheck.py` checks that. Unknown slot objects should hold only strings, integers, booleans, `null`, arrays and objects: floating-point numbers have no portable canonical form.

The MAC is compared in constant time. A mismatch is `Authentication`.

## 6. The vault header `liber-vault.json`

A JSON object of at most **1 MiB** (1 048 576 bytes). A larger input is `BadFormat`, and malformed JSON is `Json`. Every member below is **required**:

| Member | JSON type | Value |
|---|---|---|
| `format` | string | exactly `"liber-vault"`, else `BadFormat` |
| `version` | integer | exactly `1`. Another non-negative integer is `UnsupportedVersion`; anything else is `BadFormat` |
| `vault_id` | Base64url | 16 bytes |
| `epoch` | integer | u32, the current key epoch (§10). New vaults start at 1 |
| `slots` | array | at most **64** entries (known and unknown types together); each is a slot object (§7) |
| `removed` | array of Base64url | at most **1024** entries, each 16 bytes: the ids of slots removed in this epoch (tombstones, §11). Sorted by raw bytes and de-duplicated before the MAC; writers write them that way |
| `retiring` | `null` or object | `null`, or `{"epoch": u32, "nonce": 12 bytes, "wrapped": 48 bytes}` during a rotation (§10) |
| `mac` | Base64url | 32 bytes, §5, under K_header of the current epoch |

The header holds no cipher-suite field: the suite is fixed per object (AES-256-GCM for slots, and the per-file suite byte for files, §13.1).

Parse-time checks (all `BadFormat` unless noted):

- at most 64 slots in all;
- **duplicate slot ids** among the known-type slots;
- more than **4 passphrase slots**;
- each slot's own checks (§7), including the Argon2 caps (§8, `Params`);
- every length in the table above.

The MAC is **not** checked at parse. It is checked during unlock (§7.7), because K_header comes from VK.

Slot order matters: the MAC covers the array in order, and unlock tries slots in order. Writers append new slots at the end.

Example (from `tests/vectors/v1/header.json`, reformatted for reading; the file itself is canonical, §5):

```json
{
  "epoch": 1,
  "format": "liber-vault",
  "mac": "m68OUtRhsd809vBDjhNhGQkZFrGC3IThM9J4vFwl_HQ",
  "removed": ["unWEUyWbYnsLB7ZMl3881g"],
  "retiring": null,
  "slots": [
    {"id": "6uxc3mmPk2XzbHd5h1gbrQ", "type": "passphrase", "nonce": "RGiQmJfS0oaNkX1P", "wrapped": "37a_…",
     "kdf": {"alg": "argon2id", "m_kib": 64, "t": 1, "p": 1, "salt": "74dgB7UT…"}},
    {"id": "ACMcLyrp3XH6-HbFdHhKrg", "type": "recovery", "nonce": "KNCEMtn-AYjKT0fG", "wrapped": "2y5_…"},
    {"id": "6BcncT-OWkyd6s6crUiaSA", "type": "device", "device_id": "José's MacBook", "nonce": "…", "wrapped": "…"},
    {"id": "y5GemuYRrePnc9j3xchsTQ", "type": "keyring", "keyring_id": "ADGYTRd-n6yPlf_3n9wF5A", "enc": "…1120 bytes…", "nonce": "…", "wrapped": "…"}
  ],
  "vault_id": "erD0f9tyy8o98MQ6oD4-Ew",
  "version": 1
}
```

## 7. Key slots

Each slot wraps the 32-byte VK under its own 32-byte key-encryption key (KEK).

### 7.1 Common fields, wrapping and AAD

Every slot object has:

| Member | Value |
|---|---|
| `type` | string: `passphrase`, `recovery`, `device`, `keyring`, or a type this version doesn't know (§7.6) |
| `id` | Base64url, 16 random bytes, unique within the header |
| `nonce` | Base64url, 12 random bytes, fresh for every wrap |
| `wrapped` | Base64url, exactly 48 bytes: AES-256-GCM ciphertext of VK (32) ‖ tag (16) |

**Wrap:** `wrapped = AES-256-GCM-Encrypt(key = KEK, nonce = nonce, aad = AAD, plaintext = VK)`.

**AAD** (the slot binds the vault, the epoch, its own id and its type):

```
AAD = "liber/v1/slot" ‖ vault_id (16) ‖ epoch (u32 BE) ‖ slot id (16) ‖ type (ASCII, e.g. "passphrase")
```

`epoch` is the header's top-level `epoch`. For example, for the recovery slot of the vectors: 13 + 16 + 4 + 16 + 8 = 57 bytes.

A failed tag is not an error by itself: unlock moves on to the next slot (§7.7). If the tag verifies but the plaintext isn't 32 bytes, that is `BadFormat` (impossible with a 48-byte `wrapped`).

### 7.2 `passphrase`

Extra member `kdf`:

```json
{"alg": "argon2id", "m_kib": <u32>, "t": <u32>, "p": <u32>, "salt": <Base64url, 32 bytes>}
```

`alg` must be `"argon2id"` (else `BadFormat`), and the parameters must pass the caps of §8 (else `Params`).

**KEK** = Argon2id(password = UTF-8 of NFC(passphrase), salt = `salt`, m = `m_kib` KiB, t = `t`, p = `p`, output = 32 bytes), version 0x13, with no secret and no associated data. The passphrase is NFC-normalised and **never trimmed**: `" pass"` and `"pass"` are different passphrases.

A header holds 1 to 4 passphrase slots. Normally there is one; more appear briefly while a passphrase change or a merge settles. Each one costs a KDF run on a passphrase unlock.

### 7.3 `recovery`

No extra members. **KEK** = HKDF-SHA-256(IKM = the 32-byte recovery secret (§9), salt = `vault_id`, info = `liber/v1/slot/recovery`, L = 32).

A vault is created with exactly one. Parsing doesn't enforce a count. Writers keep exactly one after creation, `new_recovery` and merges (§11).

### 7.4 `device`

Extra member `device_id`: a UTF-8 string of at most **256 bytes** (else `BadFormat`), a label like `"José's MacBook"`.

**KEK** = HKDF-SHA-256(IKM = the 32-byte device secret, salt = `vault_id`, info = `liber/v1/slot/device`, L = 32). The secret is random and lives in the OS keychain behind biometry (phase E7). It is never in the vault.

### 7.5 `keyring`

Extra members:

| Member | Value |
|---|---|
| `keyring_id` | Base64url, 16 bytes: the keyring's id (§12) |
| `enc` | Base64url, exactly **1120** bytes: an X-Wing ciphertext (draft-06) |

To create one, a writer needs only the keyring's public key (§12.6):

1. Pick the slot id (16 random bytes) **first**, because the KEK binds it.
2. `(enc, ss) = X-Wing.Encaps(pk)`, using 64 bytes of fresh randomness. `ss` is 32 bytes.
3. **KEK** = HKDF-SHA-256(IKM = `ss`, salt = `vault_id`, info = `"liber/v1/slot/keyring" ‖ slot id`, L = 32).
4. Wrap VK as in §7.1.

To open one: `ss = X-Wing.Decaps(sk, enc)`, with sk being the keyring seed (§12.2), then the same KEK. X-Wing decapsulation never fails (implicit rejection): a wrong key gives a wrong KEK, and the GCM tag catches it. An `enc` of the wrong length is `BadFormat`. An unlock tries only keyring slots whose `keyring_id` equals the keyring's id. A writer adds at most one keyring slot per `keyring_id`.

### 7.6 Unknown slot types

A slot object whose `type` is a string this version doesn't know (for example the reserved `recipient`) is **kept verbatim**: it is not parsed further, it never unlocks anything, and a writer puts it back at the same index in `slots`. So it stays inside the MAC (§5). It counts toward the 64-slot cap. A slot that isn't an object, or has no string `type`, is `BadFormat`. New data in a vault header must come as a new slot type or a new format version, because unknown members of known objects are dropped (§5).

The keyring file is stricter (§12.3).

### 7.7 Unlocking

Given one credential (passphrase, recovery code, device secret or keyring secret):

1. Parse (§6).
2. For each slot **in array order** whose type matches the credential (and, for `keyring`, whose `keyring_id` matches): derive the KEK and try to unwrap with the AAD of §7.1. If the tag fails, go on to the next slot. If an Argon2 run itself fails (parameters the library refuses, such as m < 8·p), stop with `Params`.
3. On the first successful unwrap: derive the subkeys (§4.1) and verify `mac` under K_header (§5). If the MAC fails, **stop** with `Authentication`. Don't try more slots.
4. If `retiring` is not `null`, unwrap the retiring key (§10). If that fails, stop with `Authentication`.
5. No slot unwrapped: `Authentication`.

## 8. Argon2id parameters

| | m (`m_kib`, KiB) | t | p |
|---|---|---|---|
| Default | 262 144 (256 MiB) | 3 | 4 |
| **Floor**, at creation only | 65 536 (64 MiB) | 3 | — (not checked) |
| **Cap**, always | 1 048 576 (1 GiB) | 32 | 16 |
| Minimum, always | Argon2's own: m ≥ 8·p | 1 | 1 |

- **Caps** apply to every parsed slot, in the vault header and in the keyring, and before every KDF run. Above a cap is `Params`, and so are `t = 0` or `p = 0`. The caps bound how much work a hostile header can demand.
- **The floor applies only when a slot is created** (vault or keyring creation, adding a passphrase slot, rotation). A reader accepts any parameters within the caps, so a file made with lower parameters, like the vectors' m = 64 KiB, t = 1, p = 1, still opens.
- **Calibration at creation** (informative): start from the default; while one run takes over 2 s and m is above the floor, halve m (not below the floor); then, while one run takes under 0.5 s and t < 32, add 1 to t.

## 9. Recovery codes

The recovery secret is 32 random bytes. It is shown **once**, as text.

**Alphabet:** Crockford base32, `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O or U). Bits are taken most significant first. A final partial group is padded with zero bits.

**Checksum:** the first 20 bits of SHA-256(`"liber/v1/recovery-check"` ‖ secret), as 4 Crockford characters. (The reference encodes the first 3 hash bytes, 24 bits → 5 characters, and keeps the first 4.)

**Display:** `body` = Crockford(secret) (52 characters: 256 bits plus 4 zero pad bits) ‖ checksum (4) = 56 characters. Shown as `LIBER` followed by `-` and each group of 4 characters: 14 groups, 75 characters in all. For example, the vectors' code:

```
LIBER-ZDS9-CHT4-WPMV-X60F-CR58-JN2Z-6Z09-23Z9-RK8B-MCCQ-PHTE-HG9K-7J30-26DD
```

**Parsing** (forgiving, then strict):

1. Remove all whitespace and `-`. The rest must be ASCII, else `RecoveryCode`.
2. If it is 61 characters long and starts with `LIBER` in any case, drop those 5.
3. It must now be exactly 56 characters.
4. Map lower case to upper case, `O` → `0`, and `I` or `L` → `1`. Any other character outside the alphabet is an error (including `U`).
5. Decode the first 52 characters to 32 bytes. The 4 trailing pad bits must be zero.
6. Normalise the last 4 the same way and compare them with the checksum.

Every failure is `RecoveryCode`.

## 10. Epochs, rotation and the retiring key

Every VK has an **epoch**: a u32 that starts at 1 and goes up by one per rotation. It appears in the header (`epoch`), in every slot AAD (§7.1), in every file header (§13.1) and in every name's associated data (§14.2).

**Rotation** creates a new VK at epoch e + 1 (refused if e + 1 overflows, or if a rotation is already in progress). The rotated header has:

- `epoch` = e + 1;
- `slots` = exactly one new passphrase slot and one new recovery slot (a new recovery code is always issued), wrapping the new VK. Device slots are dropped, and so are unknown slot types. **There is no keyring slot**: the caller re-adds it from the keyring's public key (§7.5) and re-enrols the vault in the keyring (§12.5), because K_header has changed;
- `removed` = `[]`: tombstones reset at every epoch change;
- `retiring` = the old VK wrapped under the new one:
  - **KEK** = HKDF-SHA-256(IKM = new VK, salt = `vault_id`, info = `liber/v1/retiring`, L = 32);
  - **AAD** = `"liber/v1/retiring" ‖ vault_id ‖ retiring.epoch (u32 BE)`. It is 17 + 16 + 4 = 37 bytes, and it has no slot id or type;
  - `wrapped` = AES-256-GCM(KEK, `nonce`, AAD, old VK), 48 bytes;
  - `retiring.epoch` = e;
- `mac` under the **new** K_header.

**Reading during a rotation:** a reader keeps both key sets. A file whose header epoch equals the header's `epoch` uses the current K_content. One whose epoch equals `retiring.epoch` uses the retiring K_content. Any other epoch has no key: `Authentication`. A name carries no epoch marker, so during a rotation a reader that can't decrypt a name under the current epoch's K_name and AD tries the retiring epoch's (the lookup itself is phase E3's).

**Finishing** sets `retiring` to `null` and re-MACs. It happens once every file and name is at the new epoch.

The vector `header-rotated.json` is the vectors' vault after `begin_rotation`, at epoch 2.

## 11. Changing the header: removal, tombstones, merging

These are writer rules. A reader needs only §6 and §7, but a second writer must follow them, or a merge could bring back a revoked slot.

- **Every write re-MACs** under K_header of the header's own epoch. The reference refuses to MAC with keys from another vault or epoch, because a header MACed under the wrong key locks everyone out.
- **Removing a slot** appends its id to `removed`, kept sorted and unique. The recovery slot and the last passphrase slot can't be removed.
- **A new recovery code** tombstones the old recovery slot's id and appends a new recovery slot.
- **Adding** a slot appends it, subject to: at most 64 slots in all, at most 4 passphrase slots, the floor for new passphrase slots, `device_id` ≤ 256 bytes, and one keyring slot per keyring.
- **Tombstone cap:** 1024. A writer that would exceed it refuses, and the user rotates instead (which resets `removed`).

**Merging a sync-conflict copy** of `liber-vault.json` (spec §4.3), after unlocking the local copy:

1. The other copy must have the **same `vault_id` and the same `epoch`**, and its MAC must **verify under the local K_header**. Otherwise the whole merge is refused (`Authentication`). A slot can't be checked without its secret, so the MAC is what proves the copy came from someone holding the key.
2. **Union the tombstones** of both copies.
3. Keep the local slots that aren't tombstoned. Then append, in the other copy's order, each of its slots that isn't tombstoned and whose id isn't already present. (The other copy's unknown slot types are not merged.)
4. If more than one recovery slot remains, keep the one with the **smallest id** (by raw bytes) and tombstone the others, so every device converges on the same one. The other code stops working, and the app must ask the user to note the surviving code again.
5. Refuse the merge if the result would exceed 64 slots, 4 passphrase slots or 1024 tombstones, or if it would leave **zero passphrase slots or zero recovery slots**. That happens, for example, when each copy removed a different passphrase.
6. Re-MAC.

## 12. The keyring file `keyring.liberk`

The keyring is an app-level identity holding one X-Wing keypair. Its public key can be given a slot in any vault (§7.5). Its secret opens all of those slots.

### 12.1 Schema

A JSON object of at most **1 MiB**. Every member is required:

| Member | Value |
|---|---|
| `format` | exactly `"liber-keyring"` |
| `version` | exactly `1` (`UnsupportedVersion` for other integers) |
| `keyring_id` | Base64url, 16 random bytes |
| `public` | Base64url, exactly **1216** bytes: the X-Wing encapsulation key (draft-06: ML-KEM-768 public key, 1184 bytes ‖ X25519 public key, 32 bytes). Its ML-KEM-768 half must pass ML-KEM's encapsulation-key check (FIPS 203 §7.2), else `BadFormat` |
| `slots` | array, at most 64; at most 4 passphrase slots; no duplicate ids |
| `enrolled` | array of `{"vault_id": 16 bytes, "commit": 32 bytes}`, at most **4096**; sorted by `vault_id` (raw bytes) before the MAC; a duplicate `vault_id` is `BadFormat` |
| `mac` | Base64url, 32 bytes, §5, under the keyring MAC key (§12.4) |

### 12.2 The secret

The keyring secret is a **32-byte X-Wing seed**: the draft-06 decapsulation key, which X-Wing expands with SHAKE-256 into the ML-KEM-768 and X25519 private keys. `public` is the encapsulation key derived from that seed. The seed is what the keyring's slots wrap. The reference uses x-wing's plain `DecapsulationKey`, which accepts a non-contributory X25519 share rather than rejecting it.

### 12.3 Keyring slots

Slot objects use the same JSON shape as §7.1–§7.4, with these differences:

- **Allowed types:** `passphrase`, `recovery` and `device` only. A `keyring` slot inside a keyring, or **any unknown type, is `BadFormat`**. The keyring is app-local and has a single writer, so v1 is a closed format: a new slot type needs a new version.
- **Plaintext:** the 32-byte seed (instead of VK).
- **AAD:** `"liber/v1/keyring-slot" ‖ keyring_id (16) ‖ slot id (16) ‖ type`. There is **no epoch**, because the keyring has none.
- **KEKs:**
  - `passphrase`: Argon2id exactly as §7.2;
  - `recovery`: HKDF-SHA-256(IKM = recovery secret, salt = `keyring_id`, info = `liber/v1/keyring-slot/recovery`, L = 32). The keyring has its own recovery code, in the §9 format;
  - `device`: HKDF-SHA-256(IKM = device secret, salt = `keyring_id`, info = `liber/v1/keyring-slot/device`, L = 32).

Unlock works as in §7.7: try matching slots in order, and the first unwrap gives the seed. Then derive the MAC key and verify `mac`. A failed MAC is `Authentication`.

### 12.4 MAC key

mac_key = HKDF-SHA-256(IKM = seed, salt = `keyring_id`, info = `liber/v1/keyring/mac`, L = 32). `mac` = HMAC-SHA-256(mac_key, canonical JSON without `mac`), as in §5.

### 12.5 Enrolled-vault commitments

Public-key wrapping is unauthenticated: anyone with the public key could build a look-alike vault whose keyring slot opens. So the app opens a vault **silently** through the keyring only when it is enrolled:

- commit_key = HKDF-SHA-256(IKM = seed, salt = `keyring_id`, info = `liber/v1/keyring/commit`, L = 32);
- `commit` = HMAC-SHA-256(commit_key, `vault_id` (16) ‖ K_header (32)), where K_header is the vault's current-epoch header key (§4.1).

After the keyring slot opens a vault, the app recomputes the commitment and compares it in constant time with the `enrolled` entry for that `vault_id`. If there is no entry, or it doesn't match, the app asks the user first. Enrolling again after a rotation replaces the entry.

### 12.6 Security note: an unlocked keyring's public key only

`public` is covered by `mac`, and `mac` can only be checked with the seed. **The public key of a keyring file that hasn't been unlocked is unauthenticated**: someone who can write the file could substitute their own key and receive every vault key wrapped to it afterwards. In the reference, `KeyringFile::public()` returns the key without any check. Implementations must therefore **only wrap a vault key to a public key from a keyring file they have unlocked** (or whose MAC they have verified with the secret). The reference's `to_bytes` and `enroll` refuse a secret whose MAC key doesn't verify the file, so they never re-MAC a substituted public key.

## 13. File contents (STREAM)

### 13.1 The 48-byte file header

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 5 | magic | `LIBER` (`4C 49 42 45 52`) |
| 5 | 1 | format version | `01` |
| 6 | 1 | cipher suite | `01` = AES-256-GCM (`02` is reserved for XChaCha20-Poly1305) |
| 7 | 1 | log2 of the chunk size | `10` (16 → 65 536-byte chunks) |
| 8 | 32 | file salt | random, new on **every** write of the file |
| 40 | 4 | key epoch | u32 BE (§10) |
| 44 | 4 | reserved | `00 00 00 00` |

The whole 48 bytes are the AAD of every chunk.

Header checks, in this order:

| Condition | Error |
|---|---|
| fewer than 48 bytes | `Truncated` |
| bytes 0–4 ≠ `LIBER` | `BadFormat` |
| byte 5 ≠ 1 | `UnsupportedVersion(byte 5)` |
| byte 6 ≠ 1 | `BadFormat` |
| byte 7 ≠ 16 | `BadFormat` |
| bytes 44–47 not all zero | `BadFormat` |
| no key for the epoch (§10) | `Authentication` |

### 13.2 File key

K_f = HKDF-SHA-256(IKM = K_content of the file's epoch, salt = the 32-byte file salt, info = `liber/v1/file`, L = 32).

A fresh salt per write means a fresh K_f per write, so counter nonces never repeat under one key.

### 13.3 Chunks

The plaintext is cut into chunks of 65 536 bytes. Chunk *i* (from 0) is:

```
nonce_i = 00 00 00 ‖ i (u64 BE) ‖ last      (12 bytes: an 11-byte big-endian counter, then a flag byte)
last    = 01 for the final chunk, 00 for every other
chunk_i = AES-256-GCM-Encrypt(K_f, nonce_i, aad = the 48-byte header, plaintext_i) = ciphertext_i ‖ tag_i (16)
```

The file is `header ‖ chunk_0 ‖ chunk_1 ‖ … ‖ chunk_{n-1}`, with no length field and no padding.

- Every chunk except the last holds exactly 65 536 plaintext bytes, so it is 65 552 bytes on disk.
- The last chunk holds 1 to 65 536 bytes. **An exact multiple of 64 KiB ends with a full last chunk**, with no extra empty chunk after it.
- **Only an empty file has an empty last chunk**: 48 + 16 = 64 bytes in all.
- Chunk *i* starts at byte `48 + i·65 552`, so any range can be read by decrypting only the chunks it covers.

Number of chunks: n = max(1, ⌈len / 65 536⌉). File size: 48 + len + 16·n.

### 13.4 Length rules (reader)

Let body = file size − 48, full = ⌊body / 65 552⌋ and rem = body mod 65 552:

| Case | Chunks | Plaintext length |
|---|---|---|
| rem = 0 and full > 0 | full (the last one full) | full · 65 536 |
| rem = 16 and full = 0 | 1 (empty) | 0 |
| rem > 16 | full + 1 | full · 65 536 + rem − 16 |
| anything else: no chunk at all, rem in 1–15, or rem = 16 with full > 0 (a non-empty file never ends with an empty chunk) | — | `Truncated` |

### 13.5 Reading

- A reader **authenticates the last chunk when it opens the file**, so the plaintext length is trustworthy before anything is read. Other chunks are authenticated when they are read. No plaintext of a chunk is released before its tag verifies.
- Decrypt chunk *i* with `last = 1` if it is the final chunk by §13.4, else `last = 0`.
- If the final chunk fails as `last = 1` but **authenticates as `last = 0`**, the file was cut exactly at a chunk boundary: `Truncated`.
- Any other tag failure is `Authentication`.

### 13.6 Errors, and what they mean to a user

| Situation | Error |
|---|---|
| cut before or inside the header, or the §13.4 length rules fail | `Truncated` |
| cut exactly at a chunk boundary | `Truncated` (§13.5) |
| **torn mid-chunk** (a crash or an interrupted sync left a partial last chunk) | `Authentication`: the partial chunk is taken as the last one and its tag fails |
| any flipped, swapped, duplicated, reordered or spliced byte or chunk; a wrong key; a wrong epoch | `Authentication` |

A file torn mid-chunk can't be told apart from tampering by the bytes alone. So **tools and the UI must not call an `Authentication` failure on a file "tampering" outright**. "Damaged or modified" is accurate. Salvage (§13.7) recovers what is left either way.

### 13.7 Salvage

For a file that may be cut off (for example a recording after a crash), salvage reads sequentially:

1. Parse the header (§13.1; header errors are still errors).
2. For i = 0, 1, …: read up to 65 552 bytes. If there are none, stop. Try to decrypt it as chunk *i* with `last = 0`. If that works, keep the plaintext and continue. Otherwise try `last = 1`. If that works, keep the plaintext and mark the result **complete only if no byte follows**. Then stop. If both fail, stop.
3. Return the plaintext recovered so far and the `complete` flag.

Salvage never returns plaintext from an unauthenticated chunk. Everything after the first bad chunk is dropped.

### 13.8 Writing

The writer is **append-only, and each chunk is encrypted exactly once** (spec §4.2):

- it writes the header first, with a fresh random salt;
- it never seeks, and never re-encrypts a chunk: that would be AES-GCM nonce reuse under the same K_f;
- a full chunk is emitted (as non-last) only once a further byte proves it isn't the last. `finish` emits the buffered remainder, possibly empty and possibly full, as the last chunk;
- after a failed write to the underlying output, the writer refuses further use, because the failed chunk was already encrypted;
- any in-place fix-up (like a WAV header) is a **new file with a fresh salt**.

## 14. Names

### 14.1 Cipher

Every name component is encrypted with **AES-SIV** (RFC 5297) under the 64-byte K_name (§4.1): the first 32 bytes are the S2V/CMAC key and the last 32 the CTR key, as in RFC 5297 and the usual libraries (`aes-siv`'s `Aes256Siv`; Python `cryptography`'s `AESSIV`). The output is the 16-byte synthetic IV followed by the ciphertext, which is as long as the plaintext.

### 14.2 Associated data

**Four** separate associated-data components (RFC 5297's vector of headers, each fed to S2V on its own; **not** one concatenated string), in this order:

| # | Component | Bytes |
|---|---|---|
| 1 | `vault_id` | 16 |
| 2 | epoch, u32 BE | 4 |
| 3 | the parent folder's id | 16 (the vault root's id is 16 zero bytes) |
| 4 | the entry kind | 1: `f` (0x66) for a file, `d` (0x64) for a folder |

The kind stops a file's encrypted name from passing for a folder's, and the other way round.

### 14.3 Plaintexts and encodings

The name is NFC-normalised first.

| Entry | SIV plaintext | On-disk name |
|---|---|---|
| file | UTF-8 of NFC(name) | Base64url(SIV output) ‖ `.libere` |
| folder | folder id (16 random bytes) ‖ UTF-8 of NFC(name) | Base64url(SIV output), no suffix |

A folder's id lives only inside its own encrypted name. Its children use it as their parent id. Moving or renaming a folder re-encrypts only that folder's own name.

**Lengths.** Plaintext names should be at most **255 bytes** of UTF-8 (phase E3 enforces this when it writes). A decoder refuses an encoded name (the part before `.libere`, for files) longer than **1024 bytes**, before decoding it.

### 14.4 Decoding

1. For a file: the name must end in `.libere`, else `BadFormat`. Strip it.
2. Longer than 1024 bytes: `BadFormat`.
3. Base64url-decode strictly (§1), else `BadFormat`. Fewer than 16 bytes: `BadFormat`.
4. AES-SIV-decrypt with the AD of §14.2. Failure is `Authentication`.
5. For a folder: fewer than 16 plaintext bytes is `BadFormat`. The first 16 bytes are the folder id, and the rest is the name.
6. The name must be valid UTF-8, non-empty, not `.` or `..`, and must contain no `/`, `\` or NUL; otherwise `BadFormat`. That guards against path traversal.

### 14.5 Long names

If an on-disk name (the full encoded form, including `.libere` for a file) is **longer than 200 bytes**:

- h = the first 32 characters of the RFC 4648 base32 encoding (A–Z, 2–7, no padding) of SHA-256(the encoded name's bytes), lower-cased;
- the entry is stored as `h.liberl` (a file, or a folder for a folder), 39 bytes;
- a side file `h.libern` next to it holds the full encoded name. It is not encrypted again: it is already ciphertext.

To read `h.liberl`, read the side file and decode its contents as in §14.4. A reader should also check that hashing the contents gives `h`. Phase E3 bounds the side file's size before reading it.

### 14.6 Conflict suffixes (informative)

Sync providers rename conflicting copies. The reference recognises these, before or after the extension, so a conflict copy is shown rather than lost. Base64url and base32 never contain a space or `.`, so a real encoded name never matches.

The rules: the core is the longest leading run of `A–Z a–z 0–9 - _`, and it must not be empty. In the rest, look for `.libere`, `.liberl` or `.libern` as a suffix, then as a prefix (an empty extension if none is found). What remains must be one of:

| Provider | Remainder | Label |
|---|---|---|
| Dropbox | ` (…conflicted copy…)` | the text inside the parentheses |
| Google Drive | ` (N)`, with N all digits | `N` |
| iCloud | ` N`, with N all digits | `N` |
| Syncthing | `.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX` (8 digits, 6 digits, 7 alphanumerics) | `sync-conflict-…` |

The original name is the core followed by the extension.

## 15. Memory hygiene and residual library limits

These are not format rules. They are the limits an auditor should know about.

- Keys live on the heap in zeroize-on-drop wrappers, `mlock`ed best-effort. Wrapped keys are decrypted in place, so no plaintext copy is left behind.
- **AES key schedules are moved by value.** `aes-gcm`'s `Aes256Gcm` (slots, STREAM) and `aes-siv`'s `Aes256Siv` (names) are built from a borrowed key, but the libraries return the expanded cipher state by value. A move can leave a stack copy of the key schedule that is never zeroized. Their `zeroize` features wipe only the final location.
- **X-Wing seed copies.** `x-wing` 0.1.1 keeps the 32-byte seed inline in its `DecapsulationKey` and re-expands the private keys from it on the stack for each decapsulation. Its `zeroize` feature wipes them on drop, but moves may leave stack copies until that memory is reused.
- Argon2's working memory is wiped by the `argon2` crate's `zeroize` feature. The NFC-normalised passphrase is built in a pre-sized, zeroized buffer.

## 16. Test vectors and the Python reader

`crates/liber-crypto/tests/vectors/v1/` (byte-exact; `-text` in `.gitattributes`):

| File | Content |
|---|---|
| `vectors.json` | the secrets and expected values: VK, `vault_id`, epoch, the four subkeys, the passphrase `correct horse ⚡ batterie`, parameters m = 64 KiB, t = 1, p = 1 (below the floor on purpose), the recovery codes, the device secret, the names table, the file table, the rotated VK and the keyring's recovery code |
| `header.json` | epoch 1: passphrase, recovery, device (`José's MacBook`), and keyring slots, plus one tombstone |
| `header-rotated.json` | the same vault after `begin_rotation`: epoch 2, a passphrase and a recovery slot, `retiring` set, `removed` empty |
| `keyring.liberk` | a keyring with passphrase and recovery slots, enrolling the vectors' vault |
| `file-{0,1,65535,65536,200000}.libere` | STREAM files whose plaintext byte *i* is `i mod 251`, with the salts listed in `vectors.json` |

Names in the table: `Notes.md` (root), the folder `Projects`, `Plan.md`, `Café notes.md` (given as NFD, encrypted as NFC), the folder `Résumé`, and a 153-byte file name whose encoded form is long (§14.5).

`cargo test -p liber-crypto` regenerates every vector from the real code under a seeded RNG and compares them byte for byte. `REGEN=1` rewrites them, which is only for a deliberate format change (and a new version). The same test runs `xcheck.py` when `python3` with `cryptography` (AES-SIV, and Argon2id from version 44) is installed. Otherwise it prints `SKIP` with the reason.

**Not covered by the Python reader**, so checked only by the Rust tests:

- **X-Wing**: the vault's keyring slot (decapsulation, and the KEK from `ss`) and the keyring's public key, because `cryptography` has no X-Wing. The Rust vector test unlocks the vault through the keyring slot.
- **The keyring device slot**'s KEK info `liber/v1/keyring-slot/device`: the vectors' keyring has no device slot. The label is pinned only by this document until phase E5.
- Writer-side rules: merging (§11), unknown-slot preservation (§7.6), salvage (§13.7), conflict suffixes (§14.6) and error paths. These are covered by Rust unit and property tests.

## 17. Fuzzing

`crates/liber-crypto/fuzz/` holds four `cargo-fuzz` targets: `header`, `keyring`, `stream` and `names`. Each feeds arbitrary bytes into the real parser or reader under fixed public test keys. A panic is the only failure. The fuzz crate has its own workspace, outside the root one and outside `cargo deny`, because `libfuzzer-sys` is NCSA-licensed.

cargo-fuzz needs a **nightly** toolchain:

```sh
rustup toolchain install nightly
cargo install cargo-fuzz
cd crates/liber-crypto
# Optional: seed the corpus with the vectors (corpus/ is git-ignored).
mkdir -p fuzz/corpus/header && cp tests/vectors/v1/header*.json fuzz/corpus/header/
cargo +nightly fuzz run header -- -max_total_time=600
cargo +nightly fuzz run keyring
cargo +nightly fuzz run stream
cargo +nightly fuzz run names
```

Run them before each release (spec §10). **As of E1 the targets have not been built in this repo**, because no nightly toolchain is installed, so the first run may need a small compile fix. The stable stand-in that runs in the normal test suite is `tests/fuzz_smoke.rs`: proptest feeds the same entry points (`liber_crypto::fuzzing::*`) with random bytes and mutated vectors.

## 18. Worked example: decrypting `file-1.libere`

This follows only §4, §9, §7.3, §13 and the vectors. `xcheck.py` does the same for every vector, and this run was reproduced by a throwaway script written from this document alone.

1. **VK from the recovery slot** (§7.3, §9). Parse `LIBER-ZDS9-…-26DD` to the 32-byte secret. KEK = HKDF-SHA-256(secret, salt = `vault_id` = `7ab0f47fdb72cbca3df0c43aa03e3e13`, info = `liber/v1/slot/recovery`). AAD = `"liber/v1/slot"` ‖ vault_id ‖ `00000001` ‖ the recovery slot id ‖ `"recovery"`. Unwrapping gives VK = `63fb1a9b…1db22b41`.
2. **K_header and the MAC** (§4.1, §5): HKDF-SHA-512(VK, vault_id, `liber/v1/header`, 32), then the MAC over `header.json` without `mac` verifies.
3. **K_content** = HKDF-SHA-512(VK, vault_id, `liber/v1/content`, 32) = `9e100fa7…da4a12f1`.
4. **The file** is 65 bytes: header (48) ‖ 1 ciphertext byte ‖ tag (16). By §13.4: body = 17, full = 0, rem = 17 > 16, so there is one chunk and the length is 1.
5. **The header**: `4c49424552 01 01 10`, the salt `8513243e…b4651a8f`, epoch `00000001` (current, so K_content applies), reserved `00000000`.
6. **K_f** = HKDF-SHA-256(K_content, salt, `liber/v1/file`) = `b6d456b55a65a63fc1c5157bce03dd676601aeb208793d03d362d38bce807506`.
7. **Chunk 0**, the last one: nonce = `000000 0000000000000000 01`, AAD = the 48 header bytes. AES-256-GCM decryption gives the single byte `00` (= 0 mod 251).
