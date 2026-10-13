import i18next from 'i18next';
import { create } from 'zustand';
import { LARGE_NOTE_CHARS } from '../features/editor/limits';
import { PageDoc, type PageDocHooks, type SaveStatus } from '../features/editor/pageDoc';
import { isTauri, onCloseRequested, type ChangedPayload, type CommandError } from '../ipc';
import { errorMessage } from './messages';
import { openNewPage, openPage } from './navigate';
import { useToastStore } from './toastStore';
import { nameOf, remap } from './tree';

/** How long closing the window waits for pending saves (M2a §3.3). */
export const QUIT_FLUSH_MS = 2000;

interface EditorState {
  /** The page being edited, or `null`. */
  doc: PageDoc | null;
  path: string | null;
  status: SaveStatus;
  dirty: boolean;
  orphaned: boolean;
  hash: string | null;
  /** Over 200 KB: Live Preview uses the reduced decoration set. */
  large: boolean;
  /** Why the requested page can't be edited (e.g. `binary`). */
  error: CommandError | null;
  open: (path: string) => Promise<void>;
  /** Saves and closes the current page. */
  close: () => Promise<void>;
  /** Saves every open page (current and background); capped at `timeoutMs`. */
  flushAll: (timeoutMs?: number) => Promise<void>;
  onExternalChange: (c: ChangedPayload, exists?: (path: string) => boolean) => Promise<void>;
  follow: (from: string, to: string) => void;
  /** Re-reads pages rewritten by our own link updates (rename/move). */
  syncPaths: (paths: string[]) => Promise<void>;
  /** Writes an orphaned page (deleted outside while dirty) to a new page. */
  saveAsNew: () => Promise<void>;
  /** Saves every page (capped at `timeoutMs`); returns the paths that still
   *  have unsaved text (failing or orphaned pages). */
  saveAll: (timeoutMs?: number) => Promise<string[]>;
  /** Drops every page (after `saveAll` left nothing unsaved). */
  reset: () => void;
}

/** Every page with a live document: the current one plus pages switched away
 *  from whose last save hasn't succeeded yet (they keep retrying). */
const docs = new Map<string, PageDoc>();
let seq = 0;

const IDLE = {
  doc: null,
  path: null,
  status: 'saved' as SaveStatus,
  dirty: false,
  orphaned: false,
  hash: null,
  large: false,
  error: null,
};

const snapshot = (doc: PageDoc) => ({
  doc,
  path: doc.path,
  status: doc.status,
  dirty: doc.dirty,
  orphaned: doc.orphaned,
  hash: doc.hash,
  large: doc.text.length > LARGE_NOTE_CHARS,
  error: null,
});

const hooks: PageDocHooks = {
  onChange: (doc) => {
    const current = useEditorStore.getState().doc;
    if (doc === current) useEditorStore.setState(snapshot(doc));
    else dropIfDone(doc);
  },
  onConflictCopy: (_doc, copy) => {
    useToastStore.getState().push({
      message: i18next.t('editor.conflictCopy', { name: nameOf(copy).replace(/\.md$/i, '') }),
      action: { label: i18next.t('editor.openCopy'), run: () => void openPage(copy) },
    });
  },
};

/** A background page is dropped once it's saved. An orphaned one (deleted
 *  outside with unsaved text) is kept: its text must not be dropped silently,
 *  so it still blocks closing the vault or the window (M2a §3.3). */
function dropIfDone(doc: PageDoc) {
  if (doc === useEditorStore.getState().doc) return;
  if (doc.status === 'saved') {
    doc.dispose();
    if (docs.get(doc.path) === doc) docs.delete(doc.path);
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Test helper. */
export function resetEditorStore() {
  seq++;
  docs.forEach((d) => d.dispose());
  docs.clear();
  useEditorStore.setState({ ...IDLE });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  ...IDLE,
  open: async (path) => {
    const prev = get().doc;
    if (prev?.path === path) return;
    const mine = ++seq;
    if (prev) void prev.flush().then(() => dropIfDone(prev));
    set({ ...IDLE, path });
    let doc = docs.get(path);
    if (!doc) {
      const res = await PageDoc.load(path, hooks);
      if (mine !== seq) return; // a newer open won
      if (!res.ok) {
        set({ ...IDLE, path, error: res.error });
        return;
      }
      doc = res.value;
      docs.set(path, doc);
    }
    set(snapshot(doc));
  },
  close: async () => {
    seq++;
    const doc = get().doc;
    set({ ...IDLE });
    if (doc) {
      await doc.flush();
      dropIfDone(doc);
    }
  },
  flushAll: async (timeoutMs) => {
    const all = Promise.all([...docs.values()].map((d) => d.flush()));
    await (timeoutMs === undefined ? all : Promise.race([all, delay(timeoutMs)]));
    docs.forEach((d) => dropIfDone(d));
  },
  onExternalChange: async (c, exists) => {
    for (const [from, to] of c.renamed) get().follow(from, to);
    for (const doc of [...docs.values()]) {
      const removed = c.removed.some((r) => remap(doc.path, r, r) !== null);
      const touched = removed || c.modified.includes(doc.path) || c.created.includes(doc.path);
      if (removed && !(exists?.(doc.path) ?? false)) {
        if (!doc.markDeleted()) {
          doc.dispose();
          docs.delete(doc.path);
          if (get().doc === doc) set({ ...IDLE });
        }
      } else if (touched) {
        await doc.sync();
      }
    }
  },
  follow: (from, to) => {
    for (const doc of [...docs.values()]) {
      const next = remap(doc.path, from, to);
      if (!next) continue;
      docs.delete(doc.path);
      docs.set(next, doc);
      doc.moveTo(next);
    }
  },
  syncPaths: async (paths) => {
    await Promise.all(paths.flatMap((p) => docs.get(p)?.sync() ?? []));
  },
  saveAll: async (timeoutMs) => {
    await get().flushAll(timeoutMs);
    return [...docs.values()].filter((d) => d.dirty).map((d) => d.path);
  },
  reset: () => resetEditorStore(),
  saveAsNew: async () => {
    const doc = get().doc;
    if (!doc) return;
    const old = doc.path;
    const res = await doc.saveAsNew();
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    docs.delete(old);
    docs.set(doc.path, doc);
    set(snapshot(doc));
    await openNewPage(doc.path);
  },
}));

/** Says that `path` has text that couldn't be written, with a button that
 *  shows it (its save status, or the orphan banner with "Save as new page").
 *  Returns the toast id. */
export function warnUnsaved(
  path: string,
  key: 'editor.unsavedBlocks' | 'editor.unsavedKeepsWindow',
) {
  return useToastStore.getState().push({
    message: i18next.t(key, { name: nameOf(path).replace(/\.md$/i, '') }),
    tone: 'error',
    action: { label: i18next.t('editor.openUnsaved'), run: () => void openPage(path) },
  });
}

/** The warning shown by the last refused close, while it is on screen. */
let closeWarning: number | null = null;

/** Whether the window may close: saves every page first (max 2 s). Text that
 *  still can't be written (failing or orphaned page) keeps the window open
 *  with a warning; closing again while it shows quits anyway (M2a §3.3). */
export async function mayClose(): Promise<boolean> {
  const unsaved = await useEditorStore.getState().saveAll(QUIT_FLUSH_MS);
  if (!unsaved.length) return true;
  const warned = useToastStore.getState().toasts.some((t) => t.id === closeWarning);
  if (warned) return true;
  closeWarning = warnUnsaved(unsaved[0], 'editor.unsavedKeepsWindow');
  return false;
}

/** Closing the window (or quitting) first saves every unsaved page. */
export async function installQuitGuard(): Promise<void> {
  await onCloseRequested(mayClose);
}

/** Installs the quit guard when running inside Tauri. */
export function installQuitGuardIfTauri(): void {
  if (isTauri()) void installQuitGuard().catch(() => undefined);
}
