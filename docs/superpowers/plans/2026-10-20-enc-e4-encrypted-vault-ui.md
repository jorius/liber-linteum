# Encryption E4: Encrypted-Vault UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the app, the maintainer can create an encrypted vault from Welcome, unlock it with a passphrase or a recovery key, and use it normally. The vault locks on demand, after idle time, on sleep, on screen lock and on quit, and can be unlocked again. Settings → Security covers auto-lock, changing the passphrase and creating a new recovery key.

**Architecture:**
- **UI only, on the React app.** It sits on E3's Tauri commands and events, pinned in `docs/superpowers/plans/2026-10-20-enc-e3-encrypted-storage.md` Task 5.
- **New vault status.** `vaultStore` gains a `locked` status that shows an Unlock screen in place of Welcome or the shell.
- **One lock pipeline.** Menu, idle, sleep and screen-lock events all run a single `lock()` pipeline (spec §6.2) that flushes saves before E3's `vault_lock`.
- **Settings and create flow.** Settings gets a `security` category. Welcome's "New vault" gains an "Encrypt this vault" switch and a create dialog.

**Tech Stack:** React 19, TS, zustand, i18next (ICU, en and es), the existing dialog, toast, field (`.field-control`) and button styles, Playwright with `e2e/ipcMock.ts`, and vitest.

**Spec:**
- `docs/superpowers/specs/2026-10-20-encryption-design.md` §6 (unlock, lock, auto-lock), §7 (create), §8 (frontend), §4.3 (couldn't read), and §16 #4 (a voided recovery code).
- E3 must be merged first.

## Global Constraints

- **The E3 command contract is fixed:**
  - `vault_open` → `locked`;
  - `vault_create_encrypted(path, passphrase)` → `{ info, recovery }`;
  - `vault_unlock(path, secret: { kind: 'passphrase' | 'recovery', value })` → `VaultInfo`. Errors are `wrongSecret`, `rollback` and `invalidInput`;
  - `vault_lock()`;
  - `security_change_passphrase(current, next)`;
  - `security_new_recovery(passphrase)` → code;
  - `vault_unreadable()`;
  - `vault_reveal_unreadable(osPath)`;
  - `attachment_open_decrypted(path)`;
  - events `vault:locked { path }` and `vault:lock-request { reason }`;
  - `VaultInfo.encrypted`, `VaultInfo.recoveryVoid`, `RecentVaultDto.encrypted`, and the setting `autoLockMinutes: number | null`. The default is 15; allowed values are 1–60, or `null` for never.
- **Passphrase rules (spec §7):**
  - minimum 12 characters;
  - a strength hint;
  - no composition rules;
  - "Show passphrase" is a toggle and defaults to hidden.
- **Lock never drops an edit** (spec §6.2.1). Lock saves every open page whether auto save is on or off, with no "Save / Don't Save" prompt. If a save fails, lock aborts and shows the usual unsaved-error toast.
- **Secrets in the UI:**
  - Passphrase and recovery inputs are `type="password"` or `autocomplete="off"`, with `spellCheck={false}`.
  - They are cleared from React state as soon as the IPC call returns.
  - They are never logged, and never put in `localStorage` or a toast.
  - A recovery code is shown only in the create and new-code dialogs.
- **Everything encryption-related carries a visible "Beta" label:** the switch, the Unlock screen and the Security category (spec §12).
- **Strings:** every string is in `en` and `es` (`pnpm check:i18n`), in ICU format with single braces.
- **Accessibility:** forms label their fields, errors are `role="alert"` and tied to their field with `aria-describedby`, focus moves to the first field when a dialog opens, and new screens pass axe.
- **Fields:** use `.field-control`.
- **Commits:** signed, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Gate:** `$SP/check.sh all <worktree>` with `LIBER_E2E_PORT`.

## Review Focus

1. **Locking with unsaved edits and auto save off.** The edits are written without a prompt, then the vault locks. Unlocking shows them. → Task 3, `lock_saves_without_asking`.
2. **A wrong passphrase.**
   - The error reads "That passphrase doesn't open this vault".
   - The field keeps its text selected and its focus.
   - Nothing counts attempts.
   - A later correct passphrase works.

   → Task 2, `unlock_wrong_then_right`.
3. **A loosely typed recovery key** (lower case, spaces, `O` typed for `0`) unlocks. The UI passes the text through unchanged, because E3's parser is forgiving. → Task 2, `unlock_with_loose_recovery_key`.
4. **Idle timing.**
   - The idle timer resets on any key, pointer or wheel event in any app window.
   - It is postponed while a recording is running.
   - A sleep or screen-lock request during a recording still locks, and the take is kept by E3.

   → Task 3, `idle_resets_and_waits_for_recording`.
5. **Leaving the Unlock screen.** "Back" from it returns to Welcome. No page, tree, search or Global View state from that vault remains in any store, and the next vault opens clean. → Task 2, `back_from_unlock_leaves_nothing`.

---

## File structure

- `apps/desktop/src/features/encryption/`, one component per file:
  - `UnlockScreen.tsx`
  - `CreateEncryptedDialog.tsx`
  - `PassphraseFields.tsx`, which holds the shared new-passphrase and confirm fields plus the strength hint
  - `strength.ts`
  - `RecoveryCodeStep.tsx`
  - `SecuritySettings.tsx`
  - `UnreadableList.tsx`
  - `autoLock.ts`
  - `Encryption.module.css`
  - tests next to each
- **Modify:**
  - `src/ipc/index.ts` (calls and types)
  - `src/stores/vaultStore.ts`
  - `src/app/App.tsx`
  - `src/features/welcome/{Welcome.tsx,RecentList.tsx}`
  - `src/features/dialogs/{SettingsDialog.tsx,VaultSettingsSection.tsx}`
  - `src/features/shell/shellMenu.ts`
  - the attachment open action (find the caller of `os_path`-backed open in `features/editor` / `features/preview`)
  - `src/locales/{en,es}.json`
  - `e2e/ipcMock.ts`
  - `apps/desktop/src-tauri/src/menu.rs` (new menu items)

---

### Task 1: The IPC layer and the store's `locked` state

**Files:**
- Modify: `src/ipc/index.ts`, `src/stores/vaultStore.ts`, `src/app/App.tsx`, `e2e/ipcMock.ts`
- Test: `src/stores/vaultStore.encryption.test.ts`

**Interfaces:**
- Consumes: the E3 contract (Global Constraints).
- Produces:

```ts
// ipc
export type UnlockSecret = { kind: 'passphrase' | 'recovery'; value: string };
export const vaultCreateEncrypted = (path: string, passphrase: string) =>
  call<{ info: VaultInfo; recovery: string }>('vault_create_encrypted', { path, passphrase });
export const vaultUnlock = (path: string, secret: UnlockSecret) => call<VaultInfo>('vault_unlock', { path, secret });
export const vaultLock = () => call<void>('vault_lock');
export const securityChangePassphrase = (current: string, next: string) => call<void>('security_change_passphrase', { current, next });
export const securityNewRecovery = (passphrase: string) => call<string>('security_new_recovery', { passphrase });
export const vaultUnreadable = () => call<{ osPath: string; reason: string }[]>('vault_unreadable');
export const vaultRevealUnreadable = (osPath: string) => call<void>('vault_reveal_unreadable', { osPath });
export const attachmentOpenDecrypted = (path: string) => call<void>('attachment_open_decrypted', { path });
export const onVaultLocked = (cb: (path: string) => void) => listen<{ path: string }>('vault:locked', (e) => cb(e.payload.path), mine());
export const onLockRequest = (cb: (reason: 'sleep' | 'screenLock') => void) => listen<{ reason: 'sleep' | 'screenLock' }>('vault:lock-request', (e) => cb(e.payload.reason), mine());
// VaultInfo += { encrypted: boolean; recoveryVoid: boolean }; RecentVault += { encrypted: boolean }; Settings += { autoLockMinutes: number | null }

// vaultStore
export type VaultStatus = 'closed' | 'opening' | 'open' | 'locked';
interface VaultState {
  lockedPath: string | null;                       // the encrypted vault waiting for Unlock
  unlock: (secret: UnlockSecret) => Promise<IpcResult<VaultInfo>>;
  createEncrypted: (path: string, passphrase: string) => Promise<IpcResult<{ info: VaultInfo; recovery: string }>>;
  lock: (reason: 'menu' | 'idle' | 'sleep' | 'screenLock') => Promise<boolean>;  // false = aborted (a save failed)
  cancelUnlock: () => void;                        // back to Welcome
}
```

- **`open(path)`.** If the result is `{ ok: false, error.kind === 'locked' }`, set `status: 'locked'` and `lockedPath: path`, and show no error toast.
- **`unlock(secret)`.** Goes through the same `withProgress` / `opened` path as `open`, so progress, warnings, tree and spell bump behave identically.
- **`lock()`** runs the spec §6.2 pipeline, in this order:
  1. `savedEverything({ ask: false })`: the existing function gains an option that skips the auto-save-off prompt and saves anyway.
  2. Stop recording through the audio store's `stop` (keep the take). E3's `vault_lock` stops a running take anyway; this step keeps the UI's recorder state consistent.
  3. `vaultLock()`.
  4. Reset the editor, page, trail and search stores and the Global View selection, the same resets `close` does.
  5. `status: 'locked'`, `lockedPath: info.root`.
- **`App.tsx`:**
  - `'locked'` → `<UnlockScreen />`;
  - `'open'` → `<AppShell />`;
  - otherwise → `<Welcome />`.
- **`ipcMock.ts`:** add an `encrypted` mock vault (`{ passphrase, recovery }`) that implements every command above and emits `vault:locked`.

- [ ] **Step 1: Write the failing tests** in `vaultStore.encryption.test.ts`, mocking IPC:
  - `open_locked_goes_to_locked`: `vaultOpen` returns `{ ok: false, error: { kind: 'locked' } }`. Then `status === 'locked'`, `lockedPath === path`, and no toast was pushed.
  - `unlock_opens_like_open`: `vaultUnlock` returns `ok`. Then `status === 'open'`, `refreshTree` was called, and the spell store was bumped.
  - `lock_saves_then_locks`: a dirty editor doc with `autoSave: false`. `lock('menu')` calls `saveAll` without `confirmUnsaved`, then `vaultLock`. Then `status === 'locked'`, and the page and editor stores are empty.
  - `lock_aborts_when_a_save_fails`: `saveAll` returns one unsaved path. `lock` resolves `false`, `vaultLock` is not called, and the status stays `open`.
- [ ] **Step 2: Run** `pnpm --filter @liber/desktop exec vitest run src/stores/vaultStore.encryption.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(encryption): IPC and the vault store's locked state (E4)`.

### Task 2: The Unlock screen and the recent-list badge

**Files:**
- Create: `src/features/encryption/{UnlockScreen.tsx,Encryption.module.css}`, `UnlockScreen.test.tsx`
- Modify: `src/features/welcome/RecentList.tsx`, `src/locales/{en,es}.json`
- Test: also `e2e/e4-encryption.spec.ts` (created here; Tasks 3–6 append to it)

**Interfaces:**
- Consumes: `useVaultStore` `lockedPath`, `unlock`, `cancelUnlock` (Task 1).
- **Produces the UI:**
  - **Layout.** The Welcome card style, with:
    - a lock icon;
    - the vault folder name (the last segment of `lockedPath`);
    - a "Beta" pill;
    - a password field labelled "Passphrase", autofocused;
    - an Unlock button (primary);
    - a "Use recovery key instead" link that swaps the field to a text input labelled "Recovery key" with the placeholder `LIBER-XXXX-…`;
    - a "Back" button.
  - **Errors** (`role="alert"`):
    - `wrongSecret`: "That passphrase doesn't open this vault." or "That recovery key doesn't open this vault.";
    - `rollback`: "This vault's key file is older than one this computer has already seen. It may have been restored from a backup or replaced. It wasn't opened.";
    - `invalidInput` (recovery format): "That doesn't look like a recovery key.";
    - other errors use the existing `errorMessage`.
  - **While unlocking,** a spinner reads "Unlocking… (this takes a second on purpose)".
  - **Recent list:** encrypted vaults show a lock glyph instead of the emoji, plus an accessible name suffix: "Encrypted".

- [ ] **Step 1: Write the failing tests:**
  - **vitest `UnlockScreen.test.tsx`:**
    - `unlock_wrong_then_right` (Review Focus 2);
    - `unlock_with_loose_recovery_key` (Review Focus 3: the exact typed text reaches `vaultUnlock`);
    - `rollback_message`;
    - `back_from_unlock_leaves_nothing` (Review Focus 5: after Back, the page, editor, search and Global View stores are empty and the status is `closed`);
    - the passphrase is cleared from component state after the call returns.
  - **e2e `e4-encryption.spec.ts`**, Chromium and WebKit; add the file to WebKit's `testMatch`:
    - open the mock encrypted vault from the recent list: the lock badge shows, then Unlock appears;
    - a wrong passphrase, then the right one, opens the shell;
    - axe passes on the Unlock screen in light and dark.
- [ ] **Step 2: Run** `pnpm --filter @liber/desktop exec vitest run src/features/encryption` and `pnpm --filter @liber/desktop exec playwright test e2e/e4-encryption.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(encryption): Unlock screen and the encrypted badge in recent vaults (E4)`.

### Task 3: Locking (menu, idle, sleep and screen lock)

**Files:**
- Create: `src/features/encryption/autoLock.ts` and `autoLock.test.ts`
- Modify:
  - `src/features/shell/shellMenu.ts`;
  - `apps/desktop/src-tauri/src/menu.rs`: Vault → "Lock Vault" (`Alt+CmdOrCtrl+L`) and "New Encrypted Vault…". Both emit `menu:vault` with `"lock"` or `"newEncrypted"`. "Lock Vault" is enabled only while an encrypted vault is open, through the existing menu-state update path, or via a `menu_set_lock_enabled(bool)` command if none exists;
  - `src/features/shell/AppShell.tsx` (mount `useAutoLock`).
- Test: `autoLock.test.ts`, plus `e2e/e4-encryption.spec.ts` (append)

**Interfaces:**
- Produces: `export function useAutoLock(): void`.
  - It is mounted while `status === 'open' && info.encrypted`.
  - It listens to `keydown`, `pointerdown`, `pointermove` (throttled to 1 per second) and `wheel` on `window`, and resets an idle timer of `autoLockMinutes` minutes. A `null` setting means no timer.
  - It doesn't fire while `useAudioStore.getState().recording` is true; instead it re-arms one minute later.
  - It subscribes to `onLockRequest`: `sleep` and `screenLock` call `lock(reason)` at once, even while recording.
  - `menu:vault` `"lock"` calls `lock('menu')`.
  - `onVaultLocked` from the backend, when the UI didn't start the lock, makes the store go to `locked` without IPC. This is the backend's idempotent path.
- **Shortcut:** "Lock Vault" is ⌥⌘L / Ctrl+Alt+L. Plain ⌘⇧L is 1Password's global lock shortcut, so it isn't used. List it in Settings → Shortcuts.

- [ ] **Step 1: Write the failing tests:**
  - **vitest, fake timers**, `idle_resets_and_waits_for_recording` (Review Focus 4):
    - with `autoLockMinutes = 1`, a keydown at 50 s means the lock happens at 1 min 50 s, not at 1 min;
    - with `recording = true` at 1 min 50 s, nothing locks; once recording becomes false, it locks within 1 min;
    - a `lockRequest('sleep')` during recording locks at once;
    - with `autoLockMinutes = null`, nothing ever locks.
  - **vitest** `lock_saves_without_asking` (Review Focus 1): auto save off and a dirty page. Fire `menu:vault "lock"`: `confirmUnsaved` is not called, `saveAll` is called, and the status becomes `locked`.
  - **e2e:** with the vault unlocked, press ⌥⌘L and the Unlock screen shows. Unlock, edit, then emit `vault:lock-request` from the mock: the edit was saved (the mock records `page_write`) and Unlock shows.
- [ ] **Step 2: Run** the vitest and e2e files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same commands, plus `cargo test -p liber-desktop menu` for the menu items. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(encryption): lock from the menu, idle, sleep and screen lock (E4)`.

### Task 4: Creating an encrypted vault

**Files:**
- Create:
  - `src/features/encryption/{CreateEncryptedDialog.tsx,PassphraseFields.tsx,strength.ts,RecoveryCodeStep.tsx}`
  - their tests
- Modify: `src/features/welcome/Welcome.tsx`, `src/features/shell/shellMenu.ts` (`"newEncrypted"`), and the locales
- Test: the tests next to each file, plus e2e (append)

**Interfaces:**
- **`strength(passphrase: string): 'tooShort' | 'weak' | 'fair' | 'strong'`:**
  - `tooShort` is under 12 code points;
  - otherwise the estimate is `bits = length × log2(pool)`, where the pool is the sum of the character classes present: lower 26, upper 26, digits 10, symbols 33, and non-ASCII 100;
  - then subtract 10 bits if the input is all one class;
  - `weak` is under 50 bits, `fair` is 50 to 79, and `strong` is 80 or more.

  This is a hint only; it never blocks anything except `tooShort`. Words are not checked against a dictionary, and the hint text says so: "Longer is stronger; a few unrelated words work well."
- **Welcome:** under the "New vault" button, a switch labelled "Encrypt this vault" with a "Beta" pill. It is off by default and not remembered.
  - Off: today's flow.
  - On: pick a folder (the existing `pickFolder`), then `<CreateEncryptedDialog path>`.
  - The menu's "New Encrypted Vault…" also picks a folder, then opens the dialog.
- **`CreateEncryptedDialog`** has three steps.
  1. **Passphrase:**
     - a passphrase field, a confirm field, a "Show" toggle and the strength hint;
     - Continue is disabled while `tooShort` or while the two fields differ;
     - a mismatch error reads "The passphrases don't match.".
  2. **Creating:** `createEncrypted(path, passphrase)` runs, with the label "Setting up encryption…".
     - On success the passphrase is cleared from state, and the vault is open behind the dialog (status `open`).
     - On `notEmpty`, show the error and go back to step 1.
  3. **Recovery key (`RecoveryCodeStep`):**
     - the code shows in a monospace box, with the text: "Write this down or store it in a password manager. It's the only way into this vault if you forget the passphrase. We can't recover it for you.";
     - a Copy button copies it and shows "Copied — clear your clipboard once you've stored it.";
     - "I've saved it" leads to the confirm sub-step: two random group numbers ("Type group 3 and group 11"). Each input accepts loose case.
     - Done becomes enabled only when both match.
     - The code is then dropped from state.
     - The dialog can't be dismissed (Escape or backdrop) before Done. The vault is already created, so this is about not losing the code.

- [ ] **Step 1: Write the failing tests:**
  - **vitest `strength.test.ts`:**
    - `"correct horse"` (13 characters) is `fair`;
    - `"aaaaaaaaaaaa"` is `weak`;
    - `"short"` is `tooShort`;
    - `"Tr0ub4dor&3xx!"` is `strong`;
    - Unicode is counted in code points: 12 emoji count as 12.
  - **vitest `CreateEncryptedDialog.test.tsx`:**
    - a mismatch blocks Continue;
    - a successful create shows the code;
    - Escape does nothing at step 3;
    - wrong group values keep Done disabled and the right ones enable it;
    - after Done, no component state holds the code (assert through the rendered DOM and the store).
  - **e2e:** turn on the Welcome switch, pick a folder (the mock answers the dialog), type a passphrase, read the code from the box, confirm the two groups, and the shell is open. Run axe on each step.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(encryption): create an encrypted vault from Welcome or the Vault menu (E4)`.

### Task 5: Settings → Security, a voided recovery key, and "Couldn't read"

**Files:**
- Create: `src/features/encryption/{SecuritySettings.tsx,UnreadableList.tsx}` and their tests
- Modify:
  - `src/features/dialogs/SettingsDialog.tsx`: add `'security'` to `APP_CATEGORIES`, after `files`;
  - `src/features/dialogs/VaultSettingsSection.tsx`: add `UnreadableList` when `info.encrypted`;
  - `src/stores/vaultStore.ts`: the `recoveryVoid` prompt after `opened`;
  - the locales.

**Interfaces:**
- **The Security category** (with a "Beta" pill in its title):
  - **Lock after inactivity:** a select with Never, 1, 5, 15, 30 or 60 minutes, bound to `autoLockMinutes`. The help line reads "Encrypted vaults also lock when the computer sleeps, the screen locks, or the app quits."
  - **When an encrypted vault is open**, two more items:
    - **Change passphrase:** current, new and confirm fields, using `PassphraseFields`. It calls `securityChangePassphrase`. On success it shows a toast "Passphrase changed"; on `wrongSecret` an inline error.
    - **New recovery key:** asks for the current passphrase, then calls `securityNewRecovery`, then shows `RecoveryCodeStep` (same confirm). The explanatory line: "Your old recovery key stops working."
  - **When no encrypted vault is open:** the line "Open an encrypted vault to change its passphrase or recovery key."
- **A voided recovery key.** After `opened` with `info.recoveryVoid`, a non-dismissable dialog explains: "Your recovery key for this vault was replaced on another device and no longer works. Make a new one now." It has one action, "Make a new recovery key", which leads to the New recovery key flow.
- **`UnreadableList`** goes in This vault and appears only when the list isn't empty. Its title is "Couldn't read". Each row shows the reason and a "Show in Finder" (or "Show in Explorer") button that calls `vaultRevealUnreadable`. A line explains: "These files are in the vault folder but their names couldn't be decrypted. They're never deleted. Export arrives in a later version."

- [ ] **Step 1: Write the failing tests:**
  - **vitest:**
    - Security appears in the category list, and its search keywords match "lock" and "passphrase";
    - the auto-lock select saves `autoLockMinutes: 5` and `null`;
    - change passphrase covers the `wrongSecret` inline error and the success toast;
    - the new recovery flow reaches the confirm step;
    - the `recoveryVoid` dialog can't be dismissed and leads to the new-code flow;
    - `UnreadableList` renders two rows and calls `vaultRevealUnreadable` with the row's path.
  - **e2e:** in Settings → Security, change the passphrase, lock, unlock with the new one, then run axe.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(encryption): Settings → Security, voided recovery key prompt, couldn't-read list (E4)`.

### Task 6: Decrypted copies, the localStorage audit, and the final gate

**Files:**
- Modify:
  - the attachment "Open with default app" action;
  - `FavoritesSection.tsx`, `features/icons/emoji.ts`, `SplitHint.tsx`, `Outline.tsx`: audit only, and change a key only if it holds page titles or paths;
  - the locales.
- Test: vitest next to the open action; e2e (append)

**Interfaces:**
- **Open attachment in an encrypted vault.** Before opening, show a confirm dialog: "A decrypted copy will be written to a temporary folder until the vault locks." The buttons are "Open copy" and "Cancel". On confirm, call `attachmentOpenDecrypted(path)`. Plain vaults are unchanged.
- **localStorage audit:**
  - for each key in the four files, record what it stores in the spec's E3/E4 audit table (§16);
  - any key holding a page path or title is not written while `info.encrypted`;
  - a vitest asserts that, after an encrypted session's actions, `localStorage` has no key or value containing the mock's canary title.

- [ ] **Step 1: Write the failing tests:**
  - **vitest:** in an encrypted vault, the open action shows the confirm, and Cancel calls nothing. In a plain vault, there's no confirm.
  - **vitest** `no_canary_in_localStorage`: open the mock encrypted vault, then open, favourite and outline the page `Canary-7f3a`. No `localStorage` entry contains `Canary-7f3a`.
  - **e2e:** the full journey in Chromium and WebKit:
    1. Create.
    2. Write a page.
    3. Lock with ⌥⌘L.
    4. Unlock with the passphrase.
    5. The page is there.
    6. Lock from a `screenLock` request.
    7. Unlock with the recovery key, typed in lower case.
    8. Run axe.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `$SP/check.sh all <worktree>`. Expected: ALL-OK.
- [ ] **Step 5: Commit**: `feat(encryption): decrypted-copy confirm, localStorage audit, end-to-end journey (E4)`.

---

## Rulings made while planning

1. **Lock shortcut is ⌥⌘L / Ctrl+Alt+L.** ⌘⇧L belongs to 1Password's global lock. *Cost if wrong:* one accelerator string.
2. **The passphrase strength hint is a local entropy estimate,** with no zxcvbn dependency and no dictionary. It only blocks under 12 characters, as the spec says. *Cost if wrong:* a weak but long passphrase like `aaaaaaaaaaaaaaaa` gets "weak" but is allowed.
3. **Changing the passphrase and making a new recovery key both ask for the current passphrase,** even though the vault is open. That stops someone at an unlocked Mac from taking over the vault's credentials (threat "someone at my unlocked Mac"). *Cost if wrong:* one extra field.
4. **The recovery-code dialog can't be dismissed until both groups are confirmed.** *Cost if wrong:* a user who wants to skip has to type two groups.
5. **An active recording postpones the idle lock.** Sleep and screen lock still lock at once, and E3 keeps the take. *Cost if wrong:* a forgotten recording keeps the vault open past the idle limit.
6. **No Touch ID or keyring buttons** on the Unlock screen until E5 and E7. The layout leaves room under the main button. *Cost if wrong:* none.
7. **Notion import into an encrypted vault stays out:** the importer still creates plain vaults (spec §7). *Cost if wrong:* none until asked for.
