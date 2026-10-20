# Vault encryption: fact sheet (verified 2026-10-20)

Versions and licences come from the crates.io API (`https://crates.io/api/v1/crates/<name>`), pulled on 2026-10-20. Repo context: `deny.toml` allows MIT, MIT-0, Apache-2.0 (+LLVM-exception), BSD-2/3, ISC, Zlib, Unicode-3.0, MPL-2.0, CC0-1.0, BSL-1.0, Unlicense and GPL-3.0-or-later. It does **not** allow any LGPL. The workspace pins `rusqlite = 0.40.2` with `bundled`. The asset protocol (`apps/desktop/src-tauri/src/asset.rs:41`) already sends `Cache-Control: no-store`.

"Unverified" marks a claim I could not confirm from a primary source.

---

## 1. RustCrypto and related crates

| Crate | Latest stable (date) | Licence | MSRV | Third-party audit |
|---|---|---|---|---|
| aes-gcm | 0.11.1 (2026-08-21) | Apache-2.0 OR MIT | 1.85 | **NCC Group, Feb 2020**, funded by MobileCoin. Scope: aes-gcm + chacha20poly1305 (plus aes, polyval). "No significant findings." [README](https://github.com/RustCrypto/AEADs/blob/master/aes-gcm/README.md), [report PDF (archive)](https://web.archive.org/web/20240108154854/https://research.nccgroup.com/wp-content/uploads/2020/02/NCC_Group_MobileCoin_RustCrypto_AESGCM_ChaCha20Poly1305_Implementation_Review_2020-02-12_v1.0.pdf) |
| chacha20poly1305 | 0.11.0 (2026-06-28) | Apache-2.0 OR MIT | 1.85 | Same NCC Group 2020 audit. [README](https://github.com/RustCrypto/AEADs/blob/master/chacha20poly1305/README.md) |
| aes-gcm-siv | 0.12.1 (2026-08-21) | MIT OR Apache-2.0 | 1.85 | **None.** README: "No security audits of this crate have ever been performed… USE AT YOUR OWN RISK!" (its AES/polyval dependencies were covered by the NCC audit). [README](https://github.com/RustCrypto/AEADs/blob/master/aes-gcm-siv/README.md) |
| aes-siv | 0.8.0 (2026-08-11) | Apache-2.0 OR MIT | 1.85 | **None**, and "not been thoroughly assessed to ensure… constant-time". [README](https://github.com/RustCrypto/AEADs/blob/master/aes-siv/README.md) |
| argon2 | 0.6.0 (2026-08-27) | MIT OR Apache-2.0 | 1.85 | No audit mentioned. [repo](https://github.com/RustCrypto/password-hashes) |
| hkdf | 0.13.0 (2026-03-30) | MIT OR Apache-2.0 | 1.85 | No audit mentioned. [repo](https://github.com/RustCrypto/KDFs) |
| sha2 | 0.11.1 (2026-10-12) | MIT OR Apache-2.0 | 1.88 | No audit mentioned. [repo](https://github.com/RustCrypto/hashes) |
| hmac | 0.13.0 (2026-03-29) | MIT OR Apache-2.0 | 1.85 | No audit mentioned. [repo](https://github.com/RustCrypto/MACs) |
| x25519-dalek | 3.0.0 (2026-07-06) | BSD-3-Clause | 1.85 | **Quarkslab, 2019**, mandated by Tari Labs. Scope: curve25519-dalek, subtle, bulletproofs. 30 person-days, "only found some minor issues". [Quarkslab](https://blog.quarkslab.com/security-audit-of-dalek-libraries.html). A later timing issue, CVE-2024-58262, was found outside the audit: [GitLab advisory](https://advisories.gitlab.com/pkg/cargo/curve25519-dalek/CVE-2024-58262/) |
| ml-kem (FIPS 203) | 0.3.3 (2026-10-17) | Apache-2.0 OR MIT | 1.85 | **None.** "has never been independently audited! USE AT YOUR OWN RISK!" [README](https://github.com/RustCrypto/KEMs/blob/master/ml-kem/README.md). FIPS 203 is final: [NIST](https://csrc.nist.gov/pubs/fips/203/final). The same repo also ships `x-wing` (hybrid PQ KEM). |
| scrypt | 0.12.0 (2026-04-22) | MIT OR Apache-2.0 | 1.85 | No audit mentioned. |

- Maintenance: every RustCrypto crate above shipped a release in 2026, and all moved to MSRV 1.85 or later. Our toolchain is 1.99, so this is fine. The repo also has an `aead-stream` crate (STREAM construction). [AEADs repo](https://github.com/RustCrypto/AEADs)
- AES-GCM-SIV (RFC 8452) and AES-SIV (RFC 5297) are both nonce-misuse resistant. [RFC 8452](https://www.rfc-editor.org/rfc/rfc8452), [RFC 5297](https://www.rfc-editor.org/rfc/rfc5297), [Argon2 RFC 9106](https://www.rfc-editor.org/rfc/rfc9106)

**Memory hygiene**

- **zeroize 1.9.1** (2026-10-06, Apache-2.0 OR MIT). It is pure Rust and uses `write_volatile` plus fences. Its docs warn that moves, stack spills and `Vec` reallocation can leave copies it cannot clear. [README](https://github.com/RustCrypto/utils/blob/master/zeroize/README.md), [lib.rs docs](https://github.com/RustCrypto/utils/blob/master/zeroize/src/lib.rs)
- **secrecy 0.10.3** (2024-10-09, Apache-2.0 OR MIT). It is a wrapper that blocks Debug/Clone and zeroizes on drop. No release since 2024. [crates.io](https://crates.io/crates/secrecy)
- **memsec 0.7.0** (2024-06-06, MIT). It is a pure-Rust port of libsodium's utilities (mlock/VirtualLock, guarded malloc). No release since 2024. [repo](https://github.com/quininer/memsec)
- **region 4.0.1** (2026-09-23, MIT). Provides `lock()` (mlock/VirtualLock) and page protection. [crates.io](https://crates.io/crates/region)
- **secrets 1.3.0** (2026-04-13, MIT OR Apache-2.0). Gives mlock, mprotect and guard pages, but it **depends on `libsodium-sys`**, a C build. [README](https://github.com/stouset/secrets)
- **memsafe 1.0.2** (2026-07-05, MIT). Small crate with little adoption (about 21k downloads). [repo](https://github.com/po0uyan/memsafe)

**Implication for us:** use the audited aes-gcm or chacha20poly1305 for content. If we want misuse resistance or SIV filenames, we accept unaudited aes-gcm-siv or aes-siv. Use zeroize + secrecy for key handling, and region or memsec if we want mlock. Avoid `secrets`, since its C dependency cuts against cargo-xwin. ml-kem is unaudited, so treat post-quantum as optional or hybrid only.

---

## 2. OpenPGP and age in Rust

**rPGP (`pgp`)**

- **Version and licence:** 0.21.0 (2026-10-03), MIT OR Apache-2.0, MSRV 1.88. Pure Rust.
- **Formats:** supports RFC 9580 including v6 keys and AEAD (SEIPDv2). [README](https://github.com/rpgp/rpgp)
- **Post-quantum:** the `pqc` feature implements **RFC 9980** (PQC in OpenPGP, published June 2026) with ML-KEM-768+X25519 and ML-KEM-1024+X448. [IMPL_STATUS](https://github.com/rpgp/rpgp/blob/main/docs/IMPL_STATUS.md), [RFC 9980](https://www.rfc-editor.org/rfc/rfc9980.html)
- **Audits** ([SECURITY_STATUS](https://github.com/rpgp/rpgp/blob/main/docs/SECURITY_STATUS.md)):
  - Include Security, 2019, for the Open Tech Fund. Covered rPGP and RustCrypto RSA.
  - ETH researchers' analysis via Delta Chat, March 2024.
  - **Radically Open Security, Dec 2024**, funded by NLnet. Led to CVE-2024-53856 and CVE-2024-53857 (panics and DoS), fixed in 0.14.1.
  - A further ROS finding: GHSA-7587-4wv6-m68m / CVE-2026-21895 (RSA panic). [OSV](https://osv.dev/vulnerability/GHSA-7587-4wv6-m68m)
- **Known issue:** the `rsa` crate is vulnerable to the Marvin timing attack. [SECURITY_STATUS](https://github.com/rpgp/rpgp/blob/main/docs/SECURITY_STATUS.md)
- **Dependencies:** pins older RustCrypto majors (aes-gcm ^0.10, argon2 ^0.5, x25519-dalek ^2). Its default `bzip2` 0.6 uses pure-Rust `libbz2-rs-sys`, so there is **no C dependency**. [crates.io deps](https://crates.io/crates/pgp/0.21.0/dependencies)
- **Smartcards:** `openpgp-card` 0.7.0 and `openpgp-card-rpgp` 0.8.1 (both 2026-07-23, MIT OR Apache-2.0). The PC/SC backend (`card-backend-pcsc` → `pcsc-sys`) links the OS library (winscard / PCSC.framework / libpcsclite) and compiles no C. [pcsc-sys build.rs](https://github.com/bluetech/pcsc-rust/blob/master/pcsc-sys/build.rs)

**Sequoia (`sequoia-openpgp`)**

- **Version and licence:** 2.4.2 (2026-10-14), **LGPL-2.0-or-later** (confirmed on crates.io and [README](https://gitlab.com/sequoia-pgp/sequoia/-/blob/main/README.md)). This is **not in our deny.toml allow list.** Adding it would be licence-compatible with GPL-3.0-or-later, because "or later" permits LGPL-2.1, which the FSF lists as GPL-compatible ([GNU licence list](https://www.gnu.org/licenses/license-list.html#LGPLv2.1)), but it is a policy change.
- **Formats:** supports RFC 9580 since 2.0.0. RFC 9980 post-quantum arrived in 2.4.0, but **only with the OpenSSL and RustCrypto backends**. [NEWS](https://gitlab.com/sequoia-pgp/sequoia/-/blob/main/openpgp/NEWS)
- **Default crypto backend is Nettle (C)**, which would break or complicate cargo-xwin. Alternatives ([openpgp README](https://gitlab.com/sequoia-pgp/sequoia/-/blob/main/openpgp/README.md)):
  - OpenSSL or Botan (C/C++).
  - `crypto-cng` (Windows only).
  - `crypto-rust`, which upstream says is "not recommended for general use" and which requires `allow-experimental-crypto` (plus `allow-variable-time-crypto` in some configurations).
- **Audit:** I found no published third-party audit (unverified absence).
- **Recent advisory:** CVE-2026-42784, CVSS 7.4, a subkey-binding signature-forgery flaw. [Rapid7](https://www.rapid7.com/db/vulnerabilities/cve-2026-42784/)
- **Smartcards:** `openpgp-card-sequoia` 0.2.2 has not been released since 2024-06.

**age (`age` crate / rage)**

- **Version and licence:** 0.12.1 (2026-07-14), MIT OR Apache-2.0. The crate docs still say "all crate versions prior to 1.0 are beta releases for testing purposes only". [lib.rs](https://github.com/str4d/rage/blob/main/age/src/lib.rs)
- **Format:** [C2SP age spec](https://c2sp.org/age).
  - 128-bit file key, with an HMAC-SHA-256 header MAC.
  - Payload: 16-byte nonce, then HKDF-SHA-256(info="payload"), then **64 KiB ChaCha20-Poly1305 chunks**. Each chunk nonce is an 11-byte big-endian counter plus a last-chunk flag byte (this is the STREAM construction).
  - The scrypt recipient uses r=8, p=1 and a log2 work factor stored in the stanza.
- **Post-quantum:** Go age v1.3.0 (2025-12-27) added native **`mlkem768x25519` (X-Wing) hybrid recipients** (`age1pq1…`). [release notes](https://github.com/FiloSottile/age/releases/tag/v1.3.0). The Rust crate 0.12 only exposes `tagpq::Recipient` (encryption-only, for hardware-tag plugins). **Native PQ identities are not yet in the Rust crate.** [CHANGELOG](https://github.com/str4d/rage/blob/main/age/CHANGELOG.md), [lib.rs](https://github.com/str4d/rage/blob/main/age/src/lib.rs)
- **Plugins:** separate `age-plugin-*` binaries looked up on PATH (the `plugin` feature). `age-plugin-yubikey` 0.5.1 (2026-04-08) uses the PIV P-256 slots with PIN and touch policies and needs pcscd on Linux. [README](https://github.com/str4d/age-plugin-yubikey)
- **Plugin-name vulnerability:** a plugin-name path issue allowed arbitrary binary execution: GHSA-4fg7-vxc8-qx5w (Rust) / GHSA-32gq-x56h-299c (Go), fixed in age 0.10.1 / 0.11.1 and Go 1.2.1. [GHSA](https://github.com/advisories/GHSA-4fg7-vxc8-qx5w)
- **Audit:** I found no published third-party audit of age or rage (unverified absence).

**Implication for us:**

- Neither OpenPGP library suits encrypting thousands of small files with random-access reads. OpenPGP is a message format, so range requests would mean decrypting the whole file.
- If the lead insists on PGP, use rPGP: it is permissive, pure Rust, audited and supports RFC 9580/9980. Use it for key wrapping or export only, not as the vault format.
- Sequoia brings an LGPL policy change plus a C crypto backend.
- age's STREAM design is the right model for content, but the crate is pre-1.0 and its Rust PQ support lags Go.

---

## 3. Prior-art formats

**Cryptomator vault format 8** ([architecture](https://docs.cryptomator.org/en/latest/security/architecture/), [vault spec](https://docs.cryptomator.org/en/latest/security/vault/))

- **Vault config:** `vault.cryptomator` is a JWT (HS256) with `format: 8`, `cipherCombo: SIV_GCM` and `shorteningThreshold: 220`. It is signed with the 512-bit raw master key.
- **Masterkey file:** `masterkey.cryptomator` holds the scrypt parameters (example: N=32768, r=8) and a salt. The derived 32-byte KEK wraps a 256-bit encryption key and a 256-bit MAC key using **AES Key Wrap (RFC 3394)**.
- **Directory IDs:** the root's ID is `""`. Other directories get a UUID, stored in `dir.c9r`. The ciphertext path is `d/XX/YYYY…`, from Base32(SHA-1(AES-SIV(dirId))). This makes the folder tree flat and hides its structure.
- **Filenames:** NFC-normalised, then AES-SIV with the parent dir ID as associated data, then Base64url plus `.c9r`. Names longer than 220 characters become `<sha1>.c9s/` folders containing `name.c9s`.
- **File header:** 68 bytes: a 12-byte nonce, then an AES-GCM-encrypted (8 reserved bytes + 32-byte content key), then a 16-byte tag.
- **Content:** **32 KiB chunks**. Each chunk is a 12-byte nonce + AES-GCM ciphertext + 16-byte tag, with AAD = chunk number (64-bit BE) ‖ header nonce.

**gocryptfs** ([forward mode crypto](https://nuetzlich.net/gocryptfs/forward_mode_crypto/))

- The master key is wrapped with AES-256-GCM under a scrypt-derived KEK. Since v1.3, HKDF derives subkeys from it.
- Content uses **4 KiB blocks** of AES-GCM, each with a random 128-bit IV. AAD = a 128-bit file ID plus the block number.
- Filenames use AES-256-EME with a per-directory 128-bit `gocryptfs.diriv`. Names over 255 characters become `gocryptfs.longname.<hash>`.

**age STREAM:** see §2 (64 KiB ChaCha20-Poly1305 chunks, counter nonce with a last-chunk flag). [spec](https://c2sp.org/age)

**LUKS2** ([LUKS2-format.txt](https://kernel.googlesource.com/pub/scm/utils/cryptsetup/cryptsetup/+/dcce2edc4f242f7bcb8c47ef90c68f9eb36a147e/docs/LUKS2-format.txt), [man cryptsetup-luksFormat](https://man7.org/linux/man-pages/man8/cryptsetup-luksFormat.8.html))

- One random volume key, wrapped independently in **up to 32 keyslots** (IDs 0–31). Each keyslot has its own PBKDF (pbkdf2, argon2i or argon2id) and an anti-forensic splitter.
- A separate "digest" verifies the unwrapped volume key.
- "For security reasons, there is no redundancy in keyslots binary data."
- Argon2 memory is benchmarked between 64 MiB and 1 GiB, with a 4 GiB maximum.

**1Password two-secret key derivation (2SKD)** ([deepKeys §8.2](https://agilebits.github.io/security-design/deepKeys.html), [Secret Key](https://agilebits.github.io/security-design/apsk.html))

- **Inputs:** the account password goes through PBKDF2-HMAC-SHA256 with **650,000 iterations** (salt stretched by HKDF with the email address). This result is **XORed** with HKDF(Secret Key, salt = account ID). The output is the Account Unlock Key.
- **Secret Key:** `A3-<account ID>-<26 random characters>`, "a tad over 128 bits" of entropy. It is stored on the user's devices and never needs to be memorised.
- **Effect:** stolen server data cannot even test password guesses without the Secret Key.
- **What the AUK protects:** it decrypts the private key, which unwraps the vault keys.

**KDF defaults**

- **OWASP Argon2id minimums:** m=47104 (46 MiB), t=1, p=1; or m=19456 (19 MiB), t=2, p=1; or 12 MiB/t=3, 9 MiB/t=4, 7 MiB/t=5 (all p=1). scrypt: N=2^17, r=8, p=1. [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- **Bitwarden Argon2id default:** 32 MiB, 6 iterations, 4 threads (PBKDF2 default: 600,000). [Bitwarden](https://bitwarden.com/help/kdf-algorithms/)
- **KeePassXC Argon2 default:** memory `1 << 16` KiB = 64 MiB, 10 rounds, parallelism = min(CPU threads, 4). [Argon2Kdf.cpp](https://github.com/keepassxreboot/keepassxc/blob/develop/src/crypto/kdf/Argon2Kdf.cpp)

**Implication for us:** the industry pattern is the same everywhere. A random per-vault data key is wrapped by one or more key-encryption keys (password, keychain, recovery key, YubiKey), as in LUKS keyslots and the Cryptomator masterkey file. Content uses chunked AEAD with the chunk index and file ID in the AAD. That gives range requests for the asset protocol. The "master key" the lead asked about should be **one more keyslot** on each vault, not one key that encrypts every vault directly.

---

## 4. Encrypting the SQLite FTS index

- **What rusqlite offers:** rusqlite 0.40.2 / libsqlite3-sys 0.38.2 have the features `sqlcipher` (system library), `bundled-sqlcipher` and `bundled-sqlcipher-vendored-openssl`. [crates.io](https://crates.io/crates/rusqlite/0.40.2)
  - The bundled SQLCipher is under Zetetic's BSD-style licence (`libsqlite3-sys-0.38.2/sqlcipher/LICENSE`).
  - It sits on SQLite 3.51.3.
- **Crypto provider selection for `bundled-sqlcipher`** (from `libsqlite3-sys/build.rs`, [source](https://github.com/rusqlite/rusqlite/blob/master/libsqlite3-sys/build.rs)):
  - **macOS target on a macOS host:** CommonCrypto (`-DSQLCIPHER_CRYPTO_CC`). No OpenSSL is needed.
  - **"Windows" is detected only when the host *and* target are both Windows.** From macOS → `x86_64-pc-windows-msvc` with no `OPENSSL_DIR`, it falls to the generic branch and emits `rustc-link-lib=dylib=crypto`. That is the Unix library name, so linking fails unless you supply a Windows OpenSSL whose lib is named `crypto`.
  - With `OPENSSL_DIR`, you must ship a prebuilt Windows libcrypto, and the DLL then has to be distributed. Issue [#1739](https://github.com/rusqlite/rusqlite/issues/1739) covers STATUS_DLL_NOT_FOUND.
- **`bundled-sqlcipher-vendored-openssl` → `openssl-src`** (300.x, OpenSSL 3.x): for `*-msvc` targets it skips cross-tool setup and looks up **`nmake.exe` via the Windows registry**, which does not exist on macOS. It also wants Perl and optionally NASM. [openssl-src lib.rs](https://github.com/alexcrichton/openssl-src-rs/blob/main/src/lib.rs)
- **Upstream status:** rusqlite issue [#966](https://github.com/rusqlite/rusqlite/issues/966), "Windows support for bundled-sqlcipher", is still **open** (since 2021). Vendored-OpenSSL Windows bugs: [#1025](https://github.com/rusqlite/rusqlite/issues/1025).
- **Bottom line:** SQLCipher + cargo-xwin means a prebuilt OpenSSL for each Windows arch plus build-script workarounds. This cost is high and untested upstream. (My inference from the build scripts; I did not try the build.)
- **SQLite3 Multiple Ciphers (sqlite3mc):**
  - Upstream v2.6.1 (2026-10-12), MIT. Default cipher: sqleet ChaCha20-Poly1305; it also offers SQLCipher-compatible AES-CBC, Ascon and AEGIS. Keys are set with `PRAGMA key` or `sqlite3_key()`. [docs](https://utelle.github.io/SQLite3MultipleCiphers/), [repo](https://github.com/utelle/SQLite3MultipleCiphers)
  - Its crypto is self-contained C (no OpenSSL), but I could not find an upstream statement saying so explicitly (unverified).
  - **There are no rusqlite/libsqlite3-sys features for it.** The only crate is `sqlite3mc-src` 205.1.0 (2026-09-23; MIT AND CC0-1.0 AND Unlicense AND (CC0-1.0 OR Apache-2.0)), which provides the amalgamation and whose only reverse dependency is `sqlite-wasm-rs` (wasm). [crates.io](https://crates.io/crates/sqlite3mc-src). Wiring it into libsqlite3-sys would be our own fork or build hack.
  - The `walletkit-sqlite` wrapper exists but is niche and app-specific.
- **In-memory index:** rebuild the FTS5 index at unlock into `:memory:` (or into a temp DB we encrypt ourselves). This needs no new dependencies. The cost is reindex time on every unlock, and the index still lives in process RAM.

**Implication for us:** for an encrypted vault, prefer an in-memory FTS5 index rebuilt at unlock, optionally cached as one app-encrypted blob, over SQLCipher. SQLCipher's Windows cross-compile story is the single biggest build risk on this list.

---

## 5. OS key storage and biometrics

- **keyring 4.2.0** (2026-08-29, MIT OR Apache-2.0, MSRV 1.88) is now a thin "v1-compatible" wrapper. New code should depend on **keyring-core 1.0.1** plus per-OS store crates. [README](https://github.com/open-source-cooperative/keyring-rs)
  - `apple-native-keyring-store` 1.0.2
  - `windows-native-keyring-store` 1.1.0
  - `dbus-secret-service-keyring-store` 1.0.1 / `zbus-secret-service-keyring-store` 1.0.1 (zbus already appears in our deny.toml advisory ignores)
  - `linux-keyutils-keyring-store` 1.0.0
  - All are MIT OR Apache-2.0.
- **Apple store:** the `keychain` module is for apps that are not provisioning-profile signed. The `protected` module (Data Protection keychain) **supports biometric-gated items but requires a provisioning profile**; without one you get error -34018. [README](https://github.com/open-source-cooperative/apple-native-keyring-store)
- **Biometric gating that actually protects the key:** store the vault KEK in a Keychain item with `SecAccessControl` `kSecAccessControlBiometryCurrentSet` (KeePassXC does this, with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`). [KeePassXC TouchID.mm](https://github.com/keepassxreboot/keepassxc/blob/develop/src/quickunlock/TouchID.mm), [Apple biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset). An `LAContext.evaluatePolicy` yes/no answer alone is just a UI gate.
- **Windows Hello:** KeePassXC uses `KeyCredentialManager.RequestSignAsync(challenge)`, takes SHA-256 of the signature as the AES-256-GCM key, and uses the challenge as the IV. [WindowsHello.cpp](https://github.com/keepassxreboot/keepassxc/blob/develop/src/quickunlock/WindowsHello.cpp)
- **Tauri plugins:**
  - Official `tauri-plugin-biometric` 2.5.0 supports **macOS, Android and iOS only, not Windows or Linux**. [README](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/biometric/README.md)
  - Community `tauri-plugin-biometry` 0.2.8 (2026-09-01, MIT) claims Touch ID + Windows Hello plus biometric-protected data storage. [repo](https://github.com/Choochmeque/tauri-plugin-biometry)
  - `robius-authentication` 0.3.1 (MIT) gives prompt-only auth on macOS, Windows Hello and polkit; its repo is archived and moved to project-robius/robius. [README](https://github.com/project-robius/robius-authentication)
- **Low-level bindings:** `objc2-local-authentication` 0.3.2 and `security-framework` 3.7.0 for DIY. [crates.io](https://crates.io/crates/security-framework)

**Implication for us:** "remember on this device" means storing a keyslot KEK in keyring-core. Real Touch ID binding needs the Data Protection keychain (signing and provisioning-profile cost) or a DIY Security.framework item. Windows Hello needs the KeyCredentialManager sign-a-challenge pattern. Do not ship a prompt-only gate as security.

---

## 6. Leak surfaces (Tauri / WKWebView / WebView2 / OS)

- **Custom-scheme caching:**
  - No authoritative doc says whether WKURLSchemeHandler or WebView2 WebResourceRequested responses are written to the HTTP disk cache (unverified).
  - WebView2 *does* cache intercepted responses when they carry `Cache-Control: public, max-age` (community report): [WebView2Feedback #4702](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/4702).
  - Tauri on Windows serves custom protocols as `http://<scheme>.localhost` (`useHttpsScheme` switches to https). [tauri-utils config.rs](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-utils/src/config.rs)
  - Our asset protocol already sends `no-store`.
- **Incognito:** Tauri `WindowConfig.incognito`. wry maps it to `WKWebsiteDataStore::nonPersistentDataStore` on macOS and `SetIsInPrivateModeEnabled` on WebView2 ([wry wkwebview](https://github.com/tauri-apps/wry/blob/dev/src/wkwebview/mod.rs), [wry webview2](https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs)).
  - Apple: a non-persistent store means "no data will be written to the file system". [WKWebsiteDataStore.h](https://opensource.apple.com/source/WebKit2/WebKit2-7606.4.5/UIProcess/API/Cocoa/WKWebsiteDataStore.h.auto.html)
  - It also wipes localStorage and IndexedDB, which matters if the UI relies on them.
- **Clipboard:**
  - macOS: add the `org.nspasteboard.ConcealedType` / `TransientType` markers so clipboard managers skip the item. [nspasteboard.org](http://nspasteboard.org/)
  - Windows: register `ExcludeClipboardContentFromMonitorProcessing`, or `CanIncludeInClipboardHistory`=0 and `CanUploadToCloudClipboard`=0. [Microsoft](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)
  - WebView copy/paste goes through the browser engine, so these need native hooks (inference).
- **Spotlight and QuickLook:**
  - Spotlight indexes plaintext `.md` files in the vault. Exclude a folder with the `.noindex` suffix or the Privacy list, but "excluded" items can still show in direct `mdfind` queries. [Eclectic Light](https://eclecticlight.co/2024/07/09/excluding-folders-and-files-from-time-machine-spotlight-and-icloud-drive/)
  - The QuickLook thumbnail cache stores previews of files, even from encrypted containers, in the clear and keeps them after deletion (Reguła/Wardle 2018; no Apple fix found). [Objective-See](https://objective-see.org/blog/blog_0x30.html)
- **Swap and hibernation:**
  - macOS swap is encrypted; observed `vm.swapusage … (encrypted)` on this Mac (macOS 27.0.1).
  - Windows pagefile encryption is off unless `fsutil behavior set EncryptPagingFile 1` or full-disk BitLocker. [fsutil behavior](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-behavior)
  - Hibernation writes RAM, including keys, to disk. [CIS/Tenable](https://www.tenable.com/audits/items/CIS_Apple_macOS_13.0_Ventura_v1.0.0_L2.audit:779f8833afd8c111d65a975587cbb169)
- **Crash dumps:**
  - Windows WER LocalDumps are off by default; when enabled, the default type is minidump in `%LOCALAPPDATA%\CrashDumps`. [Microsoft](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps)
  - `WerRegisterExcludedMemoryBlock` excludes a buffer from WER reports. [Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/werapi/nf-werapi-werregisterexcludedmemoryblock)
  - Task Manager can make live full dumps.
- **Snapshots and backups:** Time Machine local APFS snapshots run hourly and are kept 24 h. Pre-encryption plaintext survives in them. [Apple](https://support.apple.com/en-us/102154)

**Implication for us:** decrypted notes will exist in the WebView JS heap and the DOM. JS strings cannot be zeroised (inference), so memory hygiene in Rust is only a partial measure. Concrete steps:
- Set `incognito` (check what the UI stores first).
- Keep `no-store`.
- Add clipboard markers for copies the app makes natively.
- Document Spotlight, QuickLook, pagefile and snapshots as residual risks.

---

## 7. Secure delete on SSDs and APFS (converting an existing plaintext vault)

- Wei et al., FAST '11, tested sanitisation on flash: **software methods for erasing individual files were not effective**, and built-in drive commands work but are sometimes implemented wrongly. [USENIX](https://www.usenix.org/conference/fast11/reliably-erasing-data-flash-based-solid-state-drives), [PDF](https://static.usenix.org/event/fast11/tech/full_papers/Wei.pdf)
- Apple's `man diskutil` (checked on this machine): "This kind of secure erase is no longer considered safe. Modern devices have wear-leveling, block-sparing, and possibly-persistent cache hardware… The modern solution… is encryption." Apple removed Secure Empty Trash in El Capitan for this reason. [Intego](https://www.intego.com/mac-security-blog/how-to-securely-empty-trash-in-os-x-el-capitan/amp/)
- On top of this, APFS is copy-on-write and keeps snapshots (see §6), and sync clients such as iCloud or Dropbox keep version history. Overwriting a file in place writes new blocks, and the old ones stay readable until trimmed (CoW inference, consistent with the man page).

**Implication for us:** "encrypt existing vault" must **not** promise to destroy the plaintext. The honest UX is:
1. Encrypt into a new folder.
2. Delete the plaintext normally.
3. Warn that remnants persist in free space, snapshots, backups and sync history unless FileVault/BitLocker was already on.
4. Recommend rotating any secrets the notes contained.
