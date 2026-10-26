import i18next from 'i18next';
import { create } from 'zustand';
import { LARGE_NOTE_CHARS } from '../features/editor/limits';
import {
  PageDoc,
  type PageDocHooks,
  type SaveStatus,
  type Unwritable,
} from '../features/editor/pageDoc';
import { viewOf } from '../features/editor/views';
import { isTauri, onCloseRequested, type ChangedPayload, type CommandError } from '../ipc';
import {
  setFrontmatter,
  type FrontmatterEdit,
  type FrontmatterPatch,
} from '../markdown/frontmatterEdit';
import { confirmUnsaved, needsUnsavedPrompt } from '../features/editor/unsavedPrompt';
import { errorMessage } from './messages';
import { openNewPage, openPage } from './navigate';
import { useSettingsStore } from './settingsStore';
import { useToastStore } from './toastStore';
import { nameOf, remap } from './tree';

/** How long closing the window waits for pending saves (M2a §3.3). */
export const QUIT_FLUSH_MS = 2000;

/** How a frontmatter edit of a live document ended. */
export type LiveEdit = 'saved' | 'pending' | 'refused';

interface EditorState {
  /** The page being edited, or `null`. */
  doc: PageDoc | null;
  path: string | null;
  status: SaveStatus;
  dirty: boolean;
  orphaned: boolean;
  /** Why the page's text can't be saved to its file (final review I3). */
  unwritable: Unwritable | null;
  hash: string | null;
  /** Over 200 KB: Live Preview uses the reduced decoration set. */
  large: boolean;
  /** Why the requested page can't be edited (e.g. `binary`). */
  error: CommandError | null;
  /** Pastes/drops being saved into the vault (M2c §5): the status says so. */
  copying: number;
  open: (path: string) => Promise<void>;
  /** Saves and closes the current page. */
  close: () => Promise<void>;
  /** Saves every open page (current and background); capped at `timeoutMs`. */
  flushAll: (timeoutMs?: number) => Promise<void>;
  /** Before a move or trash: everything with auto save on; with it off only
   *  the pages under `under` (a trash), never others (M5b final review I1). */
  flushBefore: (under?: string) => Promise<void>;
  onExternalChange: (c: ChangedPayload, exists?: (path: string) => boolean) => Promise<void>;
  follow: (from: string, to: string) => void;
  /** Saves a page kept loaded in the background and lets it go (0.1.2: closed
   *  from the Open list). */
  release: (path: string) => Promise<void>;
  /** Re-reads pages rewritten by our own link updates (rename/move). */
  syncPaths: (paths: string[]) => Promise<void>;
  /** Writes an orphaned page (deleted outside while dirty) to a new page. */
  saveAsNew: () => Promise<void>;
  /** Saves every page (capped at `timeoutMs`); returns the paths that still
   *  have unsaved text (failing or orphaned pages). */
  saveAll: (timeoutMs?: number) => Promise<string[]>;
  /** Drops every page (after `saveAll` left nothing unsaved). */
  reset: () => void;
  /** Pages with text not written yet (auto save off, failing, orphaned). */
  dirtyPaths: () => string[];
  /** Unsaved pages Save / Don't Save can act on: a page deleted outside the
   *  app has its own banner (M5b final review M3). */
  askPaths: () => string[];
  /** Don't Save (M5b §6): every page back to its saved text; nothing written. */
  discardAll: () => void;
  /** Header edits (cover, subtitle, M2c §4): changes the current page's
   *  frontmatter as an undoable editor change and saves at once. `false` when
   *  there is no editable page or its frontmatter can't be edited safely (invalid
   *  YAML, or a form the byte-minimal edit refuses; toast). */
  editFrontmatter: (patch: FrontmatterPatch) => Promise<boolean>;
  /** A frontmatter edit of `path` while it has a live document (M3b §5):
   *  the current page as an undoable editor change, a background page as a
   *  text change; saved at once. `null` when the page has no live document
   *  (the caller writes the file); `refused` (with the toast); `pending`
   *  when made but not on disk yet: its save is retrying, or the page was
   *  deleted outside (final review m6). */
  editPage: (path: string, edit: (text: string) => FrontmatterEdit) => Promise<LiveEdit | null>;
  /** The text of `path`'s live document (the current page or a background
   *  one), as `editPage` would edit it; `null` without one (final review m7). */
  liveText: (path: string) => string | null;
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
  unwritable: null,
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
  unwritable: doc.unwritable,
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
  // Final review I3: its notice shows with the page; the toast reaches a page
  // switched away from too.
  onUnwritable: (doc) => {
    const key = doc.unwritable === 'text' ? 'editor.tooLargeToast' : 'editor.notTextToast';
    useToastStore.getState().push({
      message: i18next.t(key, { name: nameOf(doc.path) }),
      tone: 'error',
      action: { label: i18next.t('editor.openUnsaved'), run: () => void openPage(doc.path) },
    });
  },
};

/** A live document's text: its view's when it has one. */
const textOf = (doc: PageDoc) => viewOf(doc)?.state.doc.toString() ?? doc.text;

/** A frontmatter edit of a live document: through its view when it has one
 *  (undoable), else its text; saved at once. Refused: toast. */
async function applyEdit(doc: PageDoc, edit: (text: string) => FrontmatterEdit): Promise<LiveEdit> {
  const view = viewOf(doc);
  const text = textOf(doc);
  const res = edit(text);
  if (!res.ok) {
    useToastStore.getState().push({ message: i18next.t('page.frontmatterInvalid'), tone: 'error' });
    return 'refused';
  }
  const c = res.change;
  if (c) {
    if (view) view.dispatch({ changes: c, userEvent: 'input.frontmatter' });
    else doc.edit(text.slice(0, c.from) + c.insert + text.slice(c.to));
  }
  await doc.flush();
  return doc.status === 'saved' && !doc.orphaned ? 'saved' : 'pending';
}

/** Whether a page left behind stays loaded (0.1.2: those in the sidebar's
 *  Open list keep their selection, scroll and undo history). */
let keepLoaded: (path: string) => boolean = () => false;
export const setKeepLoaded = (keep: (path: string) => boolean) => {
  keepLoaded = keep;
};

/** A background page is dropped once it's saved. An orphaned one (deleted
 *  outside with unsaved text) is kept: its text must not be dropped silently,
 *  so it still blocks closing the vault or the window (M2a §3.3). */
function dropIfDone(doc: PageDoc) {
  if (doc === useEditorStore.getState().doc) return;
  if (doc.status === 'saved' && !keepLoaded(doc.path)) {
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
  useEditorStore.setState({ ...IDLE, copying: 0 });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  ...IDLE,
  copying: 0,
  editFrontmatter: async (patch) => {
    const doc = get().doc;
    if (!doc) return false;
    return (await applyEdit(doc, (text) => setFrontmatter(text, patch))) !== 'refused';
  },
  editPage: async (path, edit) => {
    const doc = get().doc?.path === path ? get().doc : docs.get(path);
    return doc ? applyEdit(doc, edit) : null;
  },
  liveText: (path) => {
    const doc = get().doc?.path === path ? get().doc : docs.get(path);
    return doc ? textOf(doc) : null;
  },
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
  flushBefore: async (under) => {
    if (useSettingsStore.getState().settings.autoSave !== false) return get().flushAll();
    if (under === undefined) return; // a moved page follows its file, unsaved
    const docsUnder = [...docs.values()].filter((d) => remap(d.path, under, under) !== null);
    await Promise.all(docsUnder.map((d) => d.flush()));
    docsUnder.forEach((d) => dropIfDone(d));
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
  release: async (path) => {
    const doc = docs.get(path);
    if (!doc) return;
    await doc.flush();
    dropIfDone(doc);
  },
  syncPaths: async (paths) => {
    await Promise.all(paths.flatMap((p) => docs.get(p)?.sync() ?? []));
  },
  saveAll: async (timeoutMs) => {
    await get().flushAll(timeoutMs);
    return [...docs.values()].filter((d) => d.dirty).map((d) => d.path);
  },
  reset: () => resetEditorStore(),
  dirtyPaths: () => [...docs.values()].filter((d) => d.dirty).map((d) => d.path),
  askPaths: () => [...docs.values()].filter((d) => d.dirty && !d.orphaned).map((d) => d.path),
  discardAll: () => {
    for (const doc of [...docs.values()]) {
      if (doc.dirty && !doc.orphaned) doc.revert();
      dropIfDone(doc);
    }
  },
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

/** Work a feature finishes before the window closes, ahead of saving pages
 *  (M6 §10.7: a take in progress is stopped and inserted first). */
const beforeClose = new Set<() => Promise<unknown>>();

export function onBeforeClose(run: () => Promise<unknown>): () => void {
  beforeClose.add(run);
  return () => beforeClose.delete(run);
}

/** Checks run before anything else on close; `false` keeps the window. */
const quitChecks = new Set<() => boolean>();

export function onQuitCheck(check: () => boolean): () => void {
  quitChecks.add(check);
  return () => quitChecks.delete(check);
}

/** The warning shown by the last refused close, while it is on screen. */
let closeWarning: number | null = null;

/** Whether the window may close: saves every page first (max 2 s). Text that
 *  still can't be written (failing or orphaned page) keeps the window open
 *  with a warning; closing again while it shows quits anyway (M2a §3.3). */
export async function mayClose(): Promise<boolean> {
  // A check that keeps the window says why itself (encrypting in place).
  if ([...quitChecks].some((check) => !check())) return false;
  // Auto save off (M5b §6): Save / Don't Save / Cancel first, so Cancel also
  // keeps a recording going (batch 6 review M3).
  if (needsUnsavedPrompt() && !(await confirmUnsaved())) return false;
  await Promise.all([...beforeClose].map((run) => run().catch(() => undefined)));
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

// Auto save turned on or off (M5b §6): unsaved pages save soon, or wait.
useSettingsStore.subscribe((s, prev) => {
  if (s.settings.autoSave === prev.settings.autoSave) return;
  docs.forEach((d) => d.settle());
});
