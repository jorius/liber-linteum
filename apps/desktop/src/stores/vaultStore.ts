import i18next from 'i18next';
import { create } from 'zustand';
import {
  entryCreateFolder,
  entryCreatePage,
  entryRename,
  entryTrash,
  onVaultChanged,
  onVaultProgress,
  onVaultWarning,
  scratchpadOpen,
  vaultClose,
  vaultCreate,
  vaultOpen,
  vaultTree,
  type ChangedPayload,
  type CommandError,
  type IpcResult,
  type ProgressPayload,
  type RenameOutcome,
  type TreeNode,
  type VaultInfo,
} from '../ipc';
import { useEditorStore, warnUnsaved } from './editorStore';
import { errorMessage } from './messages';
import { usePageStore } from './pageStore';
import { useToastStore } from './toastStore';
import { useTrailStore } from './trailStore';
import { useUiStore } from './uiStore';
import { childrenByParent, joinPath, nextFreeName, parentOf, remap } from './tree';

/** External changes arriving within this window trigger one tree refresh. */
export const COALESCE_MS = 100;

export type VaultStatus = 'closed' | 'opening' | 'open';

interface VaultState {
  status: VaultStatus;
  progress: ProgressPayload | null;
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
  create: (path: string) => Promise<IpcResult<VaultInfo>>;
  close: () => Promise<void>;
  refreshTree: () => Promise<void>;
  select: (path: string | null) => void;
  toggle: (path: string) => void;
  expand: (path: string) => void;
  startRename: (path: string | null) => void;
  createPage: (dir: string) => Promise<IpcResult<string>>;
  createFolder: (dir: string) => Promise<IpcResult<string>>;
  /** `quiet`: a refused rename isn't toasted (the caller shows it inline,
   *  like the page title — final review m4). */
  rename: (
    from: string,
    to: string,
    opts?: { quiet?: boolean },
  ) => Promise<IpcResult<RenameOutcome>>;
  trash: (path: string) => Promise<IpcResult<void>>;
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
let unlisten: (() => void)[] = [];
let pending: ChangedPayload | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const EMPTY = {
  status: 'closed' as VaultStatus,
  progress: null,
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
  useVaultStore.setState({ ...EMPTY, children: new Map(), expanded: new Set() });
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
  async function savedEverything(): Promise<boolean> {
    await Promise.all([...beforeSwitch].map((run) => run().catch(() => undefined)));
    const unsaved = await useEditorStore.getState().saveAll();
    if (!unsaved.length) return true;
    warnUnsaved(unsaved[0], 'editor.unsavedBlocks');
    return false;
  }

  async function opened(
    res: IpcResult<VaultInfo>,
    before: VaultStatus,
  ): Promise<IpcResult<VaultInfo>> {
    if (!res.ok) {
      // The backend keeps the vault it had (M1b §10 a).
      set({ status: before === 'open' ? 'open' : 'closed', progress: null });
      toast().push({ message: errorMessage(res.error), tone: 'error' });
      return res;
    }
    // The global Scratchpad reads as "Quick notes" wherever the vault's
    // name shows (M4c §7.19).
    const info = res.value.scratchpad
      ? { ...res.value, name: i18next.t('scratchpad.title') }
      : res.value;
    set({ info, selected: null, expanded: new Set(), renaming: null });
    useUiStore.getState().setScreen('edit');
    useTrailStore.getState().reset();
    usePageStore.getState().clear();
    useEditorStore.getState().reset();
    await get().refreshTree();
    await startListening();
    set({ status: 'open', progress: null });
    const warnings = res.value.report.warnings ?? [];
    if (warnings.length) {
      toast().push({
        message: i18next.t('toasts.openedWithWarnings', { count: warnings.length }),
        detail: warnings,
      });
    }
    return res;
  }

  async function withProgress(
    run: () => Promise<IpcResult<VaultInfo>>,
  ): Promise<IpcResult<VaultInfo>> {
    const before = get().status;
    // One open at a time (M1b §10 b).
    if (before === 'opening') return { ok: false, error: BUSY };
    if (before === 'open' && !(await savedEverything())) return { ok: false, error: BUSY };
    set({ status: 'opening', progress: null });
    // Progress is a nicety: if it can't be subscribed, open without it.
    const stop = await onVaultProgress((p) => set({ progress: p })).catch(() => null);
    try {
      return await opened(await run(), before);
    } catch (e) {
      // Never leave the opening overlay up without a way out.
      set({ status: before === 'open' ? 'open' : 'closed', progress: null });
      const error: CommandError = {
        kind: 'io',
        message: e instanceof Error ? e.message : String(e),
      };
      toast().push({ message: errorMessage(error), tone: 'error' });
      return { ok: false, error };
    } finally {
      if (stop) safeUnlisten(stop);
    }
  }

  return {
    ...EMPTY,
    open: (path) => withProgress(() => vaultOpen(path)),
    openScratchpad: () => withProgress(() => scratchpadOpen()),
    create: (path) => withProgress(() => vaultCreate(path)),
    close: async () => {
      // Unsaved text is written before the vault goes away (M2a §3.3).
      if (!(await savedEverything())) return;
      useEditorStore.getState().reset();
      stopListening();
      await vaultClose();
      useTrailStore.getState().reset();
      usePageStore.getState().clear();
      treeSeq++;
      set({ ...EMPTY, children: new Map(), expanded: new Set() });
    },
    refreshTree: async () => {
      const mine = ++treeSeq;
      const res = await vaultTree();
      if (mine !== treeSeq || !res.ok) return; // a newer refresh won, or no vault
      const nodes = res.value;
      const exists = new Set(nodes.map((n) => n.path));
      let { selected } = get();
      // Selection falls back to the nearest ancestor that still exists.
      while (selected && !exists.has(selected)) {
        const parent = parentOf(selected);
        selected = parent || null;
      }
      const expanded = new Set([...get().expanded].filter((p) => exists.has(p)));
      set({ nodes, children: childrenByParent(nodes), selected, expanded });
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
      await useEditorStore.getState().flushAll(); // the move takes the latest text
      const res = await entryRename(from, to);
      if (!res.ok) {
        if (!opts?.quiet) toast().push({ message: errorMessage(res.error), tone: 'error' });
        return res;
      }
      await get().applyRename(from, to, res.value);
      return res;
    },
    applyRename: async (from, to, out, opts) => {
      const { selected, expanded } = get();
      set({
        selected: selected ? (remap(selected, from, to) ?? selected) : selected,
        expanded: new Set([...expanded].map((p) => remap(p, from, to) ?? p)),
        renaming: null,
      });
      useTrailStore.getState().renamed(from, to);
      get().expand(parentOf(to));
      await get().refreshTree();
      await usePageStore.getState().follow(from, to);
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
      await useEditorStore.getState().flushAll(); // the Trash gets the latest text
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
      toast().push({ message: i18next.t('toasts.trashed') });
      return res;
    },
  };
});

export { joinPath };
