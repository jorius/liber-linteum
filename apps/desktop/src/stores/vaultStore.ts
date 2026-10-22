import i18next from 'i18next';
import { confirmUnsaved, needsUnsavedPrompt } from '../features/editor/unsavedPrompt';
import { create } from 'zustand';
import {
  entryCreateFolder,
  entryCreatePage,
  entryMakeFolderPage,
  entryMoveUnderPage,
  entryRename,
  entryTrash,
  binList,
  notionImport,
  notionOpenPartial,
  trashRestore,
  onVaultChanged,
  onVaultProgress,
  onVaultWarning,
  scratchpadOpen,
  vaultClose,
  vaultCreate,
  vaultCreateEncrypted,
  vaultDecryptBegin,
  vaultDecryptCancel,
  vaultDecryptRun,
  vaultEncryptBackup,
  vaultEncryptBegin,
  vaultEncryptCancel,
  vaultEncryptRun,
  vaultLock,
  vaultOpen,
  vaultUnlock,
  vaultTree,
  toCommandError,
  type ChangedPayload,
  type CommandError,
  type IpcResult,
  type NotionDone,
  type ProgressPayload,
  type RenameOutcome,
  type CreatedEncryptedVault,
  type TreeNode,
  type UnlockSecret,
  type VaultInfo,
} from '../ipc';
import { announceRecovered } from '../features/audio/announceRecovered';
import { useBinStore } from '../features/bin/binStore';
import { onQuitCheck, useEditorStore, warnUnsaved } from './editorStore';
import { errorMessage } from './messages';
import { usePageStore } from './pageStore';
import { useToastStore, type ToastAction } from './toastStore';
import { useTrailStore } from './trailStore';
import { HOLDERS, useUiStore } from './uiStore';
import { clearVaultCaches } from './leaveVault';
import {
  childrenByParent,
  folderPageOf,
  isArchived,
  joinPath,
  nameOf,
  nextFreeName,
  parentOf,
  remap,
} from './tree';
import { useSpellStore } from './spellStore';

/** External changes arriving within this window trigger one tree refresh. */
export const COALESCE_MS = 100;

interface OpenOpts {
  /** The vault being opened: an encrypted one answers `locked`. */
  path?: string;
  /** An unlock: its failure is shown by the Unlock screen, not toasted. */
  quiet?: boolean;
}

export type VaultStatus = 'closed' | 'opening' | 'open' | 'locked';

interface VaultState {
  status: VaultStatus;
  progress: ProgressPayload | null;
  /** The encrypted vault waiting for Unlock (status `locked`). */
  lockedPath: string | null;
  /** An unlock is in flight: the Unlock screen stays up under the overlay. */
  unlocking: boolean;
  /** `createEncrypted` is running (the dialog shows its own progress). */
  creating: boolean;
  /** A lock is running: the shell takes no input (keys typed now would be lost). */
  locking: boolean;
  info: VaultInfo | null;
  nodes: TreeNode[];
  children: Map<string, TreeNode[]>;
  expanded: Set<string>;
  selected: string | null;
  /** Path currently in inline-rename mode. */
  renaming: string | null;
  /** Asks the explorer to focus a row (`''` = the first row); `nonce` repeats it. */
  focusRequest: { path: string; nonce: number } | null;
  /** Breadcrumb (M2a §5): a folder is expanded with its ancestors and focused;
   *  `''` (the vault) collapses the tree and focuses its first row. */
  revealFolder: (path: string) => void;
  open: (path: string) => Promise<IpcResult<VaultInfo>>;
  /** Opens the global Scratchpad (M4c §2): Rust knows its folder. */
  openScratchpad: () => Promise<IpcResult<VaultInfo>>;
  /** Imports a Notion export into a new vault `name` (M7) and opens it. The
   *  import shows its own progress, so no opening overlay. */
  importNotion: (name: string) => Promise<IpcResult<NotionDone>>;
  /** Opens the vault a failed Notion import left part-way (M7 §8). */
  openPartialImport: () => Promise<IpcResult<VaultInfo>>;
  create: (path: string) => Promise<IpcResult<VaultInfo>>;
  /** Unlocks `lockedPath`; opens like `open`. A failure keeps the Unlock
   *  screen up and is not toasted (the screen shows it). */
  unlock: (secret: UnlockSecret) => Promise<IpcResult<VaultInfo>>;
  createEncrypted: (path: string, passphrase: string) => Promise<IpcResult<CreatedEncryptedVault>>;
  /** Encrypt in place, begin (UX §4.2): every page saved without asking
   *  (`null`: one couldn't be, and a toast says so), then the vault on screen
   *  left if begin closes it (`closesOpen`, from preflight: this folder under
   *  any spelling, inside it or around it), then the staging vault made. Its
   *  recovery code is only returned, for the dialog. From here until the
   *  conversion ends, nothing switches vaults (`refuseWhileConverting`). */
  encryptBegin: (
    root: string,
    passphrase: string,
    closesOpen: boolean,
    backup?: boolean,
  ) => Promise<IpcResult<{ recovery: string }> | null>;
  /** Encrypt in place with a readable backup (§9): writes and verifies the
   *  copy, after begin and before the recovery key. On any failure (Stop and
   *  undo too) the backend undid the begin, and the plain vault opens again. */
  encryptBackup: () => Promise<IpcResult<void>>;
  /** Encrypt in place, Cancel at the recovery-key step: the begin undone,
   *  the plain vault it left back. */
  encryptCancel: () => Promise<IpcResult<void>>;
  /** Encrypt in place, run: the encrypted vault opens as an unlock does. On
   *  any failure (Stop and undo too; the backend rolled back) the plain vault
   *  left at begin opens again. */
  encryptRun: () => Promise<IpcResult<VaultInfo>>;
  /** Decrypt in place, begin (§10.2): every page saved without asking
   *  (`null`: one couldn't be), then both secrets checked by the backend. A
   *  wrong one keeps the vault open; on success the backend closed it, and
   *  the Unlock screen waits behind the dialog. From here until the run
   *  ends, nothing switches vaults. */
  decryptBegin: (passphrase: string, recovery: string) => Promise<IpcResult<void> | null>;
  /** Decrypt in place, run: the folder opens as a plain vault. On a failure
   *  (Stop and undo too) it is encrypted as it was: the Unlock screen. */
  decryptRun: () => Promise<IpcResult<VaultInfo>>;
  /** Decrypt in place, Stop and undo before or during the run. */
  decryptCancel: () => Promise<IpcResult<void>>;
  /** Saves every page (never asking), then locks (spec §6.2). `false`: a save
   *  failed and nothing was locked. */
  lock: (reason: 'menu' | 'idle' | 'sleep' | 'screenLock') => Promise<boolean>;
  /** The backend locked the vault (`vault:locked`): to `locked` without IPC.
   *  Idempotent, and a no-op while this UI's own lock is running. */
  lockedByBackend: (path: string) => void;
  /** Back to Welcome from the Unlock screen. */
  cancelUnlock: () => void;
  close: () => Promise<void>;
  refreshTree: () => Promise<void>;
  select: (path: string | null) => void;
  toggle: (path: string) => void;
  expand: (path: string) => void;
  startRename: (path: string | null) => void;
  createPage: (dir: string) => Promise<IpcResult<string>>;
  /** Round 3b §6.4: the folder's own page, `X/X.md`, opened (no rename). */
  createFolderPage: (folder: string) => Promise<IpcResult<string>>;
  /** Add sub-page (round 3 §9): a new page under `page`, which becomes its
   *  folder's page first if it isn't one. */
  addSubPage: (page: string) => Promise<IpcResult<string>>;
  /** Moves `item` under `page` (round 3 §9.3), making `page` a folder page first. */
  moveUnder: (item: string, page: string) => Promise<IpcResult<unknown>>;
  /** The folder `page` heads, making it a folder page if needed. */
  folderFor: (page: string) => Promise<IpcResult<string>>;
  createFolder: (dir: string) => Promise<IpcResult<string>>;
  /** `quiet`: a refused rename isn't toasted (the caller shows it inline,
   *  like the page title — final review m4). */
  rename: (
    from: string,
    to: string,
    opts?: { quiet?: boolean },
  ) => Promise<IpcResult<RenameOutcome>>;
  /** Moves into the vault's Trash (M5b §5.1); its path there. */
  trash: (path: string) => Promise<IpcResult<string>>;
  /** What follows a rename done in the backend (`rename`, a quick note's
   *  auto-name, the scratch folder's new name): selection, trail, tree, the
   *  open page and pages whose links changed, and toasts (`quiet`: none for
   *  updated links, M4c §7). */
  applyRename: (
    from: string,
    to: string,
    outcome: RenameOutcome,
    opts?: { quiet?: boolean },
  ) => Promise<void>;
}

/** Work a feature must finish while its vault is still open (the Global
 *  View's card positions waiting for their save), run before another vault
 *  opens or this one closes. Features register it here, so this store
 *  doesn't depend on them (M3a final review m15). */
const beforeSwitch = new Set<() => Promise<unknown>>();

export function onBeforeVaultSwitch(run: () => Promise<unknown>): () => void {
  beforeSwitch.add(run);
  return () => beforeSwitch.delete(run);
}

const toast = () => useToastStore.getState();
const BUSY: CommandError = { kind: 'io', message: 'the vault is busy' };
let treeSeq = 0;
/** The vault whose voided-key prompt a lock or Close took down: it shows
 *  again on that vault's next open (E3 reports a voided key only once). In
 *  memory only: the path never reaches storage. */
let voidPending: string | null = null;
/** The plain vault an encrypt in place left (its begin closed it): opened
 *  again if the conversion fails. */
let convertLeft: string | null = null;
/** The folder from an encrypt (or decrypt) in place's begin until it ends:
 *  no vault switch. */
let converting: string | null = null;
/** The conversion running decrypts (§10): "Wait until decrypting finishes." */
let decrypting = false;
/** An idle, sleep or screen lock came while converting: the converted vault
 *  locks as soon as it opens (final review I2). */
let lockAfterConvert = false;

/** "Undo it on this device…" on another device's conversion that is still
 *  copying (spec §8.11): asks first. */
export const undoElsewhereAction = (path: string, decrypt = false): ToastAction => ({
  label: i18next.t('encryptInPlace.undoElsewhere'),
  run: () => void useUiStore.getState().openDialog({ type: 'undoElsewhere', path, decrypt }),
});

/** The toast action for an open another device's conversion refused. */
export const elsewhereAction = (kind: string, path: string): ToastAction | undefined =>
  kind === 'convertingElsewhere'
    ? undoElsewhereAction(path)
    : kind === 'decryptingElsewhere'
      ? undoElsewhereAction(path, true)
      : undefined;

/** Quitting mid-run asks first (final review M7): the next open finishes or
 *  undoes it. Registered at the first begin (editorStore loads after this). */
let quitCheck: (() => void) | null = null;
const convertingQuitCheck = () => {
  if (!converting) return true;
  useUiStore.setState({ quitAsked: true });
  return false;
};

/** While a folder is being encrypted in place, any switch of vault (open,
 *  New vault, Close, Lock from the menu, Back) says to wait: `true`. */
export function refuseWhileConverting(): boolean {
  if (!converting) return false;
  const key = decrypting ? 'decryptInPlace.wait' : 'encryptInPlace.wait';
  useToastStore.getState().push({ message: i18next.t(key) });
  return true;
}
let unlisten: (() => void)[] = [];
let pending: ChangedPayload | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const EMPTY = {
  status: 'closed' as VaultStatus,
  progress: null,
  lockedPath: null as string | null,
  unlocking: false,
  creating: false,
  info: null,
  nodes: [] as TreeNode[],
  children: new Map<string, TreeNode[]>(),
  expanded: new Set<string>(),
  selected: null,
  renaming: null,
  focusRequest: null as { path: string; nonce: number } | null,
};

/** Unsubscribes without ever throwing (the event runtime may already be gone). */
function safeUnlisten(u: () => unknown) {
  try {
    void Promise.resolve(u()).catch(() => undefined);
  } catch {
    // already unsubscribed / no Tauri runtime
  }
}

function stopListening() {
  unlisten.forEach(safeUnlisten);
  unlisten = [];
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
}

/** Test helper: back to a closed vault with no listeners. */
export async function resetVaultStore() {
  stopListening();
  treeSeq++;
  voidPending = null;
  convertLeft = null;
  converting = null;
  decrypting = false;
  lockAfterConvert = false;
  useUiStore.setState({ quitAsked: false });
  useVaultStore.setState({ ...EMPTY, locking: false, children: new Map(), expanded: new Set() });
}

/** Dialogs of the app, not of a vault (shown on Welcome too): they stay. */
const APP_DIALOGS = new Set(['notionImport', 'scratchpadSetup']);

/** Leaving a vault's UI (lock, Close, Back, another vault; E4 final review
 *  C1/I2): nothing of it stays on screen or in memory but a recovery code
 *  still to be confirmed. A pending question is answered Cancel; the
 *  voided-key prompt is parked for its own vault's next open. */
function leaveVaultUi() {
  const ui = useUiStore.getState();
  const d = ui.dialog;
  if (d?.type === 'unsaved') d.answer('cancel');
  if (d?.type === 'binClash') d.answer(false);
  const voided = d?.type === 'recoveryVoid' || (d?.type === 'newRecovery' && d.fromVoid);
  if (voided && !ui.held) voidPending = d.root;
  const held = ui.held && HOLDERS.has(d?.type ?? '');
  if (!held && !APP_DIALOGS.has(d?.type ?? '')) ui.closeDialog();
  useToastStore.getState().clear();
  useBinStore.getState().reset();
  clearVaultCaches();
}

/** Open warnings: the settings-folder codes from the rename are translated
 *  (`metaDir.*`, rename review M6); the rest are shown as Rust wrote them. */
function warningText(w: string): string {
  if (w === 'metaDir.both') return i18next.t('toasts.metaDirBoth');
  const unmoved = 'metaDir.unmoved:';
  if (w.startsWith(unmoved)) {
    return i18next.t('toasts.metaDirUnmoved', { error: w.slice(unmoved.length) });
  }
  return w;
}

export const useVaultStore = create<VaultState>((set, get) => {
  async function flushChanges() {
    timer = null;
    const change = pending;
    pending = null;
    if (!change) return;
    let { selected, expanded } = get();
    const trail = useTrailStore.getState();
    for (const [from, to] of change.renamed) {
      selected = selected ? (remap(selected, from, to) ?? selected) : selected;
      expanded = new Set([...expanded].map((p) => remap(p, from, to) ?? p));
      trail.renamed(from, to);
    }
    set({ selected, expanded });
    await get().refreshTree();
    const present = new Set(get().nodes.map((n) => n.path));
    const exists = (p: string) => present.has(p);
    await usePageStore.getState().onExternalChange(change, exists);
    // Only what is gone after the whole batch: an atomic save (delete +
    // re-create) keeps its place on the trail (final review m2). Pruned after
    // the page followed any rename, so it knows the page on screen (m3).
    const current = usePageStore.getState().path;
    for (const path of change.removed) trail.removed(path, { exists, current });
  }

  /** Subscribes to external-change and warning events. A refused
   *  subscription must not block the vault: it opens without live updates and
   *  says so (real-window regression: missing event permission). */
  async function startListening() {
    stopListening();
    try {
      unlisten = await subscribeAll();
    } catch {
      toast().push({ message: i18next.t('toasts.liveUpdatesUnavailable'), tone: 'error' });
    }
  }

  function subscribeAll() {
    return Promise.all([
      onVaultChanged((c) => {
        pending = pending
          ? {
              created: [...pending.created, ...c.created],
              modified: [...pending.modified, ...c.modified],
              removed: [...pending.removed, ...c.removed],
              renamed: [...pending.renamed, ...c.renamed],
            }
          : c;
        if (!timer) timer = setTimeout(() => void flushChanges(), COALESCE_MS);
      }),
      onVaultWarning((w) => toast().push({ message: w.message, tone: 'error' })),
    ]);
  }

  /** Saves open pages (and what features registered) before the vault
   *  changes (M2a §3.3); if a page can't be written, says so and returns
   *  false: its text must not be dropped. */
  async function savedEverything(opts?: { ask?: boolean }): Promise<boolean> {
    // Auto save off (M5b §6): Save / Don't Save / Cancel first (not for a lock:
    // it saves anyway, never dropping an edit).
    if (opts?.ask !== false && needsUnsavedPrompt() && !(await confirmUnsaved())) return false;
    await Promise.all([...beforeSwitch].map((run) => run().catch(() => undefined)));
    const unsaved = await useEditorStore.getState().saveAll();
    if (!unsaved.length) return true;
    warnUnsaved(unsaved[0], 'editor.unsavedBlocks');
    return false;
  }

  /** Drops everything of the vault on screen (close and lock share it). */
  function dropVault() {
    leaveVaultUi();
    useEditorStore.getState().reset();
    stopListening();
    useTrailStore.getState().reset();
    usePageStore.getState().clear();
    treeSeq++;
    set({ ...EMPTY, children: new Map(), expanded: new Set() });
    useSpellStore.getState().bump();
  }

  /** Back to where an open started. The backend keeps the vault it had (M1b
   *  §10 a). A failed unlock (`quiet`) stays on the Unlock screen, which shows
   *  the error; any other open started from there leaves it: closed. */
  function failed(
    before: VaultStatus,
    opts: OpenOpts | undefined,
    message: string,
    action?: ToastAction,
  ) {
    if (opts?.quiet) set({ status: before, progress: null });
    else {
      set({ status: before === 'open' ? 'open' : 'closed', progress: null });
      if (before === 'locked') set({ lockedPath: null });
      toast().push({ message, tone: 'error', action });
    }
  }

  async function opened(
    res: IpcResult<VaultInfo>,
    before: VaultStatus,
    opts?: OpenOpts,
  ): Promise<IpcResult<VaultInfo>> {
    const path = opts?.path;
    if (!res.ok) {
      if (res.error.kind === 'locked' && path) {
        // An encrypted vault: the Unlock screen, not an error.
        if (before === 'open') {
          await vaultClose();
          dropVault();
        }
        set({ status: 'locked', lockedPath: path, progress: null });
        return res;
      }
      const undo = path ? elsewhereAction(res.error.kind, path) : undefined;
      failed(before, opts, errorMessage(res.error), undo);
      return res;
    }
    // Another vault replaces the one on screen or at the door (plain or
    // encrypted): nothing of that one carries over.
    const previous = get().info?.root ?? get().lockedPath;
    if (previous && previous !== res.value.root) leaveVaultUi();
    // The global Scratchpad reads as "Quick notes" wherever the vault's
    // name shows (M4c §7.19).
    const info = res.value.scratchpad
      ? { ...res.value, name: i18next.t('scratchpad.title') }
      : res.value;
    set({ info, lockedPath: null, selected: null, expanded: new Set(), renaming: null });
    useUiStore.getState().setScreen('edit');
    useTrailStore.getState().reset();
    usePageStore.getState().clear();
    useEditorStore.getState().reset();
    await get().refreshTree();
    await startListening();
    set({ status: 'open', progress: null });
    // Another vault: its own words and dictionaries (spell checking).
    useSpellStore.getState().bump();
    const ui = useUiStore.getState();
    const d = ui.dialog;
    // Already up: a Cancel after a lock left it waiting for this vault.
    const showing = d?.type === 'recoveryVoid' && d.root === info.root;
    const parked = voidPending === info.root;
    if (parked) voidPending = null;
    const wanted = !showing && (res.value.recoveryVoid || parked);
    // Refused (a recovery code still on screen): asked again on the next open.
    if (wanted && !ui.openDialog({ type: 'recoveryVoid', root: info.root }))
      voidPending = info.root;
    const warnings = res.value.report.warnings ?? [];
    if (warnings.length) {
      toast().push({
        message: i18next.t('toasts.openedWithWarnings', { count: warnings.length }),
        detail: warnings.map(warningText),
      });
    }
    return res;
  }

  /** The plain vault an encrypt in place left, back (it was rolled back). */
  async function reopenLeft() {
    const root = convertLeft;
    convertLeft = null;
    if (root) await get().open(root);
  }

  async function withProgress(
    run: () => Promise<IpcResult<VaultInfo>>,
    opts?: OpenOpts,
  ): Promise<IpcResult<VaultInfo>> {
    const before = get().status;
    // One open at a time (M1b §10 b).
    if (before === 'opening' || refuseWhileConverting()) return { ok: false, error: BUSY };
    if (before === 'open' && !(await savedEverything())) return { ok: false, error: BUSY };
    set({ status: 'opening', progress: null });
    // Progress is a nicety: if it can't be subscribed, open without it.
    const stop = await onVaultProgress((p) => set({ progress: p })).catch(() => null);
    try {
      return await opened(await run(), before, opts);
    } catch (e) {
      // Never leave the opening overlay up without a way out.
      const error: CommandError = {
        kind: 'io',
        message: e instanceof Error ? e.message : String(e),
      };
      failed(before, opts, errorMessage(error));
      return { ok: false, error };
    } finally {
      if (stop) safeUnlisten(stop);
    }
  }

  return {
    ...EMPTY,
    locking: false,
    open: (path) => withProgress(() => vaultOpen(path), { path }),
    openScratchpad: () => withProgress(() => scratchpadOpen()),
    importNotion: async (name) => {
      const before = get().status;
      if (before === 'opening' || refuseWhileConverting()) return { ok: false, error: BUSY };
      // The import opens the new vault: unsaved text in this one is written first.
      if (before === 'open' && !(await savedEverything())) return { ok: false, error: BUSY };
      const res = await notionImport(name);
      // A failed import isn't opened: the dialog offers to open it anyway.
      if (res.ok && res.value.vault) await opened({ ok: true, value: res.value.vault }, before);
      return res;
    },
    openPartialImport: () => withProgress(() => notionOpenPartial()),
    create: (path) => withProgress(() => vaultCreate(path)),
    unlock: async (secret) => {
      const path = get().lockedPath;
      if (!path || refuseWhileConverting()) return { ok: false, error: BUSY };
      // The Unlock screen stays mounted while this runs (`unlocking`).
      set({ unlocking: true });
      let res: IpcResult<VaultInfo>;
      try {
        res = await withProgress(() => vaultUnlock(path, secret), { path, quiet: true });
      } finally {
        set({ unlocking: false });
      }
      if (res.ok && res.value.recovered?.length)
        announceRecovered(res.value.recovered.map((r) => r.path));
      return res;
    },
    createEncrypted: async (path, passphrase) => {
      let created: IpcResult<CreatedEncryptedVault> | null = null;
      set({ creating: true });
      let res: IpcResult<VaultInfo>;
      try {
        // quiet: the dialog shows the refusal inline.
        res = await withProgress(
          async () => {
            created = await vaultCreateEncrypted(path, passphrase);
            return created.ok ? { ok: true, value: created.value.info } : created;
          },
          { quiet: true },
        );
      } catch (e) {
        // Saving the open vault first failed: the dialog says why.
        res = { ok: false, error: toCommandError(e) };
      } finally {
        set({ creating: false });
      }
      // A vault that was created shows its code, even if opening it failed.
      const made = created as IpcResult<CreatedEncryptedVault> | null;
      return made ?? (res.ok ? { ok: false, error: BUSY } : res);
    },
    encryptBegin: async (root, passphrase, closesOpen, backup = false) => {
      const { status, info } = get();
      if (status === 'opening' || converting) return { ok: false, error: BUSY };
      lockAfterConvert = false;
      if (status === 'open' && !(await savedEverything({ ask: false }))) return null;
      if (status === 'open' && info && (closesOpen || info.root === root)) {
        dropVault();
        convertLeft = info.root;
      }
      converting = root;
      decrypting = false;
      quitCheck ??= onQuitCheck(convertingQuitCheck);
      const res = await vaultEncryptBegin(root, passphrase, backup);
      if (!res.ok) {
        converting = null;
        useUiStore.setState({ quitAsked: false });
        lockAfterConvert = false;
        await reopenLeft();
      }
      return res;
    },
    encryptBackup: async () => {
      const res = await vaultEncryptBackup();
      if (!res.ok) {
        converting = null;
        useUiStore.setState({ quitAsked: false });
        lockAfterConvert = false;
        await reopenLeft();
      }
      return res;
    },
    encryptCancel: async () => {
      const res = await vaultEncryptCancel();
      converting = null;
      useUiStore.setState({ quitAsked: false }); // the question is moot once it ends
      lockAfterConvert = false;
      await reopenLeft();
      return res;
    },
    encryptRun: async () => {
      const res = await vaultEncryptRun();
      converting = null;
      useUiStore.setState({ quitAsked: false }); // the question is moot once it ends
      const lockNow = lockAfterConvert;
      lockAfterConvert = false;
      if (!res.ok) {
        await reopenLeft();
        return res;
      }
      convertLeft = null;
      const out = await opened(res, get().status, { path: res.value.root });
      if (lockNow) await get().lock('idle');
      return out;
    },
    decryptBegin: async (passphrase, recovery) => {
      const { status, info } = get();
      if (status !== 'open' || !info?.encrypted || converting) return { ok: false, error: BUSY };
      if (!(await savedEverything({ ask: false }))) return null;
      const root = info.root;
      converting = root;
      decrypting = true;
      quitCheck ??= onQuitCheck(convertingQuitCheck);
      const res = await vaultDecryptBegin(passphrase, recovery);
      if (!res.ok) {
        converting = null;
        decrypting = false;
        useUiStore.setState({ quitAsked: false });
        // Refused before the session closed: the vault is still open. If it
        // closed anyway (a disk error after), it waits at the Unlock screen.
        const still = await vaultTree();
        if (!still.ok && still.error.kind === 'noVault') {
          dropVault();
          set({ status: 'locked', lockedPath: root });
        }
        return res;
      }
      // The backend closed the encrypted session: what was on screen goes.
      dropVault();
      set({ status: 'locked', lockedPath: root });
      return res;
    },
    decryptRun: async () => {
      const root = converting;
      const res = await vaultDecryptRun();
      converting = null;
      decrypting = false;
      lockAfterConvert = false; // a plain vault has nothing to lock
      useUiStore.setState({ quitAsked: false });
      if (!res.ok) {
        // Past `staged` the folder is plain already (review L8): opening it
        // finishes the decryption; there is nothing to unlock.
        if (root && res.error.kind === 'decryptFinishFailed') await get().open(root);
        return res;
      }
      return opened(res, get().status, { path: res.value.root });
    },
    decryptCancel: async () => {
      const res = await vaultDecryptCancel();
      converting = null;
      decrypting = false;
      lockAfterConvert = false;
      useUiStore.setState({ quitAsked: false });
      return res;
    },
    lock: async (reason) => {
      // A lock the user asks for waits; idle, sleep and screen lock still lock
      // what is open, and the converted vault as soon as it opens.
      if (converting && reason !== 'menu') lockAfterConvert = true;
      if (reason === 'menu' && refuseWhileConverting()) return false;
      // `locking` also keeps the backend's own `vault:locked` (sent while
      // `vault_lock` runs) from dropping the vault a second time.
      if (get().locking || get().status !== 'open' || !get().info) return false;
      // The shell turns inert: an aborted lock gives the keyboard back.
      const had = document.activeElement as HTMLElement | null;
      let locked = false;
      set({ locking: true });
      try {
        const root = get().info!.root;
        // beforeSwitch includes the recorder's stop (a running take is kept).
        if (!(await savedEverything({ ask: false }))) return false;
        // Something typed while the saves ran must not be dropped with the vault.
        if (
          useEditorStore.getState().dirtyPaths().length &&
          !(await savedEverything({ ask: false }))
        ) {
          return false;
        }
        const res = await vaultLock();
        if (!res.ok) {
          toast().push({ message: errorMessage(res.error), tone: 'error' });
          return false;
        }
        // Search and the Global View reset with `info` going away.
        dropVault();
        set({ status: 'locked', lockedPath: root });
        locked = true;
        return true;
      } finally {
        set({ locking: false });
        if (!locked && had?.isConnected) setTimeout(() => had.focus());
      }
    },
    lockedByBackend: (path) => {
      if (get().locking || get().status !== 'open' || !get().info?.encrypted) return;
      dropVault();
      set({ status: 'locked', lockedPath: path });
    },
    cancelUnlock: () => {
      if (refuseWhileConverting()) return;
      leaveVaultUi();
      set({ status: 'closed', lockedPath: null });
    },
    close: async () => {
      if (refuseWhileConverting()) return;
      // Unsaved text is written before the vault goes away (M2a §3.3).
      if (!(await savedEverything())) return;
      // Same order as before: the editor is dropped before the backend closes.
      useEditorStore.getState().reset();
      stopListening();
      await vaultClose();
      dropVault();
    },
    refreshTree: async () => {
      const mine = ++treeSeq;
      const res = await vaultTree();
      if (mine !== treeSeq || !res.ok) return; // a newer refresh won, or no vault
      // The Archive comes with the tree: its own read-only folder in the
      // sidebar (M5b round 2), kept out of `nodes` (the vault's pages and
      // folders everywhere else), but in `children` for its rows.
      const all = res.value;
      const nodes = all.filter((n) => !isArchived(n.path));
      const exists = new Set(all.map((n) => n.path));
      let { selected } = get();
      // Selection falls back to the nearest ancestor that still exists.
      while (selected && !exists.has(selected)) {
        const parent = parentOf(selected);
        selected = parent || null;
      }
      const expanded = new Set([...get().expanded].filter((p) => exists.has(p)));
      set({ nodes, children: childrenByParent(all), selected, expanded });
      // The Trash and Archive change with the tree (M5b §5).
      void useBinStore.getState().refresh();
    },
    select: (selected) => set({ selected }),
    toggle: (path) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      set({ expanded });
    },
    // Expands `path` and every ancestor, so whatever lives in it is visible
    // (final review I1: moves/creates into collapsed folders stayed hidden).
    expand: (path) => {
      const expanded = new Set(get().expanded);
      const before = expanded.size;
      for (let p = path; p; p = parentOf(p)) expanded.add(p);
      if (expanded.size !== before) set({ expanded });
    },
    startRename: (renaming) => set({ renaming }),
    revealFolder: (path) => {
      const nonce = (get().focusRequest?.nonce ?? 0) + 1;
      if (!path) {
        set({ expanded: new Set(), focusRequest: { path: '', nonce } });
        return;
      }
      get().expand(path);
      set({ focusRequest: { path, nonce } });
    },
    createPage: async (dir) => {
      const name = nextFreeName(get().nodes, dir, i18next.t('explorer.untitled'), '.md');
      const res = await entryCreatePage(dir, name);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().refreshTree();
      get().expand(dir);
      set({ selected: res.value, renaming: res.value });
      return res;
    },
    createFolderPage: async (folder) => {
      const res = await entryCreatePage(folder, nameOf(folder));
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().refreshTree();
      set({ selected: folder });
      await usePageStore.getState().load(res.value);
      return res;
    },
    addSubPage: async (page) => {
      const folder = await get().folderFor(page);
      return folder.ok ? get().createPage(folder.value) : folder;
    },
    // One Rust step (review #1): a refusal moves nothing, the page included.
    moveUnder: async (item, page) => {
      await useEditorStore.getState().flushBefore(); // the move takes the latest text
      const res = await entryMoveUnderPage(item, page);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      const { folder, page: after, converted, moved } = res.value;
      if (converted) await get().applyRename(page, after, converted, { quiet: true });
      await get().applyRename(item, joinPath(folder, nameOf(item)), moved);
      return res;
    },
    folderFor: async (page) => {
      const dir = parentOf(page);
      if (folderPageOf(dir, get().children) === page) return { ok: true, value: dir };
      await useEditorStore.getState().flushBefore(); // the move takes the latest text
      const res = await entryMakeFolderPage(page);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().applyRename(page, res.value.page, res.value.outcome);
      return { ok: true, value: res.value.folder };
    },
    createFolder: async (dir) => {
      const name = nextFreeName(get().nodes, dir, i18next.t('explorer.untitled'), '');
      const res = await entryCreateFolder(dir, name);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().refreshTree();
      get().expand(dir);
      set({ selected: res.value, renaming: res.value });
      return res;
    },
    rename: async (from, to, opts) => {
      await useEditorStore.getState().flushBefore(); // the move takes the latest text
      const res = await entryRename(from, to);
      if (!res.ok) {
        if (!opts?.quiet) toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().applyRename(from, to, res.value);
      return res;
    },
    applyRename: async (from, to, out, opts) => {
      const { selected, expanded, renaming } = get();
      // A folder page's rename moves twice (round 3b §6.3); every path follows both.
      const steps: [string, string][] = out.pair ? [[from, to], out.pair] : [[from, to]];
      const move = (p: string) => steps.reduce((x, [a, b]) => remap(x, a, b) ?? x, p);
      set({
        selected: selected ? move(selected) : selected,
        expanded: new Set([...expanded].map(move)),
        // Another entry's rename stays open (M4c final review I3).
        renaming: renaming && remap(renaming, from, to) === null ? renaming : null,
      });
      for (const [a, b] of steps) {
        useTrailStore.getState().renamed(a, b);
        useEditorStore.getState().follow(a, b);
      }
      get().expand(parentOf(move(to)));
      await get().refreshTree();
      // One reload, straight to the final path: never the in-between one.
      const open = usePageStore.getState().path;
      if (open && move(open) !== open) await usePageStore.getState().follow(open, move(open));
      // Our link rewrites aren't reported by the watcher: re-read open pages.
      await useEditorStore.getState().syncPaths(out.updatedFiles);
      if (out.failed.length) {
        toast().push({
          message: i18next.t('toasts.renameFailed', { count: out.failed.length }),
          detail: out.failed.map(([p, why]) => `${p} — ${why}`),
          tone: 'error',
        });
      } else if (out.updatedFiles.length && !opts?.quiet) {
        toast().push({
          message: i18next.t('toasts.linksUpdated', { count: out.updatedFiles.length }),
        });
      }
    },
    trash: async (path) => {
      const siblings = get().children.get(parentOf(path)) ?? [];
      const i = siblings.findIndex((n) => n.path === path);
      const next = siblings[i + 1]?.path ?? (parentOf(path) || null);
      await useEditorStore.getState().flushBefore(path); // the Trash gets the latest text
      const res = await entryTrash(path);
      if (!res.ok) {
        toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      const page = usePageStore.getState();
      useTrailStore.getState().removed(path, { current: page.path });
      if (page.path && remap(page.path, path, path)) page.clear();
      const selected = get().selected;
      if (selected && remap(selected, path, path)) set({ selected: next });
      await get().refreshTree();
      const inner = res.value;
      toast().push({
        message: i18next.t('toasts.trashed'),
        action: {
          label: i18next.t('bin.undo'),
          run: () =>
            void (async () => {
              // Only the item this toast trashed (final review M5): it may
              // have been restored, and another taken its name since.
              const list = await binList();
              const still =
                list.ok && list.value?.trash.some((i) => i.path === inner && i.from === path);
              if (!still) {
                toast().push({ message: i18next.t('bin.undoGone') });
                return;
              }
              const back = await trashRestore(inner, false);
              if (!back.ok) toast().push({ message: errorMessage(back.error), tone: 'error' });
              await get().refreshTree();
            })(),
        },
      });
      return res;
    },
  };
});

export { joinPath };
