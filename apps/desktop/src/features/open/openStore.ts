// The sidebar's Open list (0.1.2): the pages and files open for editing, in
// the order they were opened. Rust keeps it in `.liber/vault.json` beside the
// favorites (it follows renames and forgets deletions there). Their documents
// stay loaded, so going back to one finds its cursor, scroll and undo history.
import { create } from 'zustand';
import { fileWindowName, openGet, openSet, type TreeNode } from '../../ipc';
import { setKeepLoaded, useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { usePageStore } from '../../stores/pageStore';
import { useToastStore } from '../../stores/toastStore';
import { useTrailStore } from '../../stores/trailStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { confirmUnsaved, needsUnsavedPrompt } from '../editor/unsavedPrompt';

interface OpenState {
  /** Every entry, those in the Trash or the Archive too (they come back). */
  paths: string[];
  load: () => Promise<void>;
  add: (path: string) => Promise<void>;
  /** Closes one; the page on screen gives way to its neighbour in the list. */
  close: (path: string) => Promise<void>;
  closeAll: () => Promise<void>;
}

const binned = (p: string) => p.startsWith('.trash/') || p.startsWith('.archive/');

/** The entries to show: those in the tree (none in the Trash or the Archive,
 *  none missing, no folders), in order. */
export function shownOpen(paths: string[], nodes: TreeNode[]): TreeNode[] {
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  return paths.flatMap((p) => {
    const node = byPath.get(p);
    return node && !binned(p) && node.kind !== 'folder' ? [node] : [];
  });
}

/** Shows an entry for editing, as the explorer opens a page (a fresh link
 *  trail), from any screen. */
export function openFromList(path: string): Promise<void> {
  useVaultStore.getState().select(path);
  useTrailStore.getState().reset();
  useUiStore.getState().setScreen('edit');
  return usePageStore.getState().load(path);
}

export const useOpenStore = create<OpenState>((set, get) => {
  // One save at a time, each applied to the list Rust holds at its turn (as
  // the favorites do): a rename there since the last read isn't undone.
  let queue: Promise<void> = Promise.resolve();
  const change = (edit: (paths: string[]) => string[]) => {
    set({ paths: edit(get().paths) }); // shown at once
    const turn = queue.then(async () => {
      const now = await openGet();
      const base = now.ok && Array.isArray(now.value) ? now.value : get().paths;
      const res = await openSet(edit(base));
      if (res.ok && Array.isArray(res.value)) set({ paths: res.value });
      else if (!res.ok) {
        useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
        await get().load();
      }
    });
    queue = turn.catch(() => undefined);
    return turn;
  };
  const shown = () => shownOpen(get().paths, useVaultStore.getState().nodes).map((n) => n.path);
  return {
    paths: [],
    load: async () => {
      if (!useVaultStore.getState().info || fileWindowName() !== null) {
        set({ paths: [] });
        return;
      }
      const res = await openGet();
      set({ paths: res.ok && Array.isArray(res.value) ? res.value : [] });
    },
    add: async (path) => {
      // A single-file window has no sidebar.
      if (fileWindowName() !== null || get().paths.includes(path)) return;
      await change((paths) => (paths.includes(path) ? paths : [...paths, path]));
    },
    close: async (path) => {
      if (usePageStore.getState().path === path) {
        const list = shown();
        const i = list.indexOf(path);
        const next = list[i + 1] ?? list[i - 1] ?? null;
        if (next) {
          await openFromList(next);
          // Cancelled at the unsaved-changes prompt: it stays open.
          if (usePageStore.getState().path === path) return;
        } else {
          if (needsUnsavedPrompt() && !(await confirmUnsaved())) return;
          usePageStore.getState().clear();
        }
      }
      await change((paths) => paths.filter((p) => p !== path));
    },
    closeAll: async () => {
      const all = get().paths;
      if (all.includes(usePageStore.getState().path ?? '')) {
        if (needsUnsavedPrompt() && !(await confirmUnsaved())) return;
        usePageStore.getState().clear();
      }
      await change(() => []);
    },
  };
});

setKeepLoaded((path) => !binned(path) && useOpenStore.getState().paths.includes(path));

// A page that leaves the list (closed, or gone when the list is read again or
// another vault opens) no longer stays loaded once it's out of view.
useOpenStore.subscribe((s, prev) => {
  for (const path of prev.paths) {
    if (!s.paths.includes(path)) void useEditorStore.getState().release(path);
  }
});

// Renames, moves, the Trash and another vault change the list in Rust: read
// it again whenever the tree or the vault changes.
useVaultStore.subscribe((s, prev) => {
  if (s.nodes !== prev.nodes || s.info !== prev.info) void useOpenStore.getState().load();
});

// Whatever shows in the editor joins the list.
usePageStore.subscribe((s, prev) => {
  if (s.state === 'ready' && s.path && (s.path !== prev.path || prev.state !== 'ready')) {
    void useOpenStore.getState().add(s.path);
  }
});
