# Hand-off: the "Encrypt <vault> in place" dialog (2026-10-21)

Branch `feat/enc-ux`. Design: `docs/superpowers/specs/2026-10-21-encryption-ux-design.md`
§4.2 as amended by §8 (the recovery key is shown and confirmed **before** any file
is copied). The backend it drives (`vault_encrypt_*`, `vault_trash_originals`,
`vault_reveal_originals`, the `vault:encrypt-progress` / `vault:encrypt-recovered`
events) came from `feat/enc-convert`; see the contract block in
`apps/desktop/src/ipc/index.ts`.

## How to try it by hand

1. Open a plain vault (not Quick notes, not your home/Desktop/Documents/Downloads).
2. Vault → Encrypt "<name>"… (or the sidebar's vault-name menu, or New vault →
   a folder with notes → Encrypted → "Encrypt in place…").
3. Intro: file count, the warning box (backups/Time Machine/sync history, pause
   sync, Syncthing `.stversions`). "Choose a passphrase…".
4. Passphrase (12+ characters). Continue saves every open page without asking,
   leaves the vault (Welcome shows behind the dialog: the backend closed the
   session), and begins.
5. Recovery key: copy, "I've saved it", type the two groups asked, Done.
6. Encrypting: progress bar, "Stop and undo".
7. Done: "Open" closes the dialog; the encrypted vault is already open behind it.

Use a throwaway copy of a folder: the originals go to the real Trash as
"<name> (unencrypted originals)".

## What is where

| Piece | File |
|---|---|
| Dialog, host, originals banner | `apps/desktop/src/features/encryption/EncryptInPlaceDialog.tsx` |
| `openEncryptInPlace`, refused-folder toast, recovered toasts, menu item | `apps/desktop/src/features/encryption/encryptInPlace.ts` |
| `encryptBegin` / `encryptRun` (save, leave, reopen on failure, open on success) | `apps/desktop/src/stores/vaultStore.ts` |
| `encryptInPlace` dialog type, `HOLDERS` (held dialogs) | `apps/desktop/src/stores/uiStore.ts` |
| New vault: no offer for refused folders | `apps/desktop/src/features/encryption/NewVaultDialog.tsx` |
| `folder_kind`: recover first, `refused` kind | `apps/desktop/src-tauri/src/vault_commands.rs` |
| Strings | `encryptInPlace.*` in `src/i18n/locales/{en,es}.json` |

## Rules the code keeps

- **Held** from begin until Done or an error (`uiStore.hold`): `openDialog`
  refuses, Escape does nothing, and `leaveVaultUi` (lock, Close, another vault)
  keeps it. The host is in `App.tsx`, outside the status switch, so it outlives
  the shell, Welcome and Unlock.
- **Secrets**: the passphrase is a prop of `encryptBegin` only and is cleared from
  the dialog's state on every outcome; the recovery code lives in the dialog's
  state until the key step's Done, then is dropped. Neither reaches a store,
  toast or log (tests check the stores' JSON).
- **Failure = the plain vault back**: if the converted folder was the open vault,
  `encryptBegin` dropped its UI; any later failure (begin refused, run error,
  Stop and undo) reopens it with `open(root)`.
- **Refused folders** (§8.10) are answered by `folder_kind` → `refused`
  (Scratchpad by setting or by open, home, Desktop, Documents, Downloads, a
  volume root). The menu gets a toast "Encrypt a vault folder, not <folder>.",
  New vault an inline alert. The convert commands refuse them again.
- **Recovery toasts** heard while a vault is opening wait until the open ends
  (leaving a vault clears toasts).
- **Originals banner** (§8.8) shows while `info.originalsPending`; Dismiss hides it
  for that vault until the app restarts.

## Tests

- vitest: `EncryptInPlaceDialog.test.tsx` (every step and branch),
  `encryptInPlace.test.ts`, `NewVaultDialog.test.tsx` (refused),
  `AppShell.test.tsx` (menu opens the dialog).
- e2e: `e2e/enc-ux.spec.ts` (journey, blocked preflight, Stop and undo, banner,
  axe on every step, light and dark, Chromium and WebKit). The mock's
  `encryptInPlace.holdRun` pauses the run after one file;
  `window.__liberFinishEncrypt()` lets it finish.
- Rust: `tests/convert_commands.rs` →
  `folder_kind_recovers_an_interrupted_conversion_and_names_refused_folders`.

## Open ends

- No "Cancel" at the recovery-key step (the backend supports it; the spec holds
  the dialog there). Stop and undo is offered while encrypting.
- If the folder picked in New vault is the open vault under a different spelling
  (symlink, case), the shell isn't dropped at begin; the backend still closes it.
- `is_refused`'s Windows branch is compile-unchecked here (no `cargo xwin` run).
