// Pasted images and files dropped from the OS (M2c §5): saved into the vault
// by Rust, then an embed or link is inserted where they landed. Drops come
// from Tauri's native drag events (Rust only imports paths it saw dropped).
import {
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import i18next from 'i18next';
import {
  attachmentImport,
  attachmentPaste,
  fileWindowName,
  isTauri,
  onDragDrop,
  type Attached,
  type CommandError,
  type DragDropPayload,
} from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { nameOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { pagePath } from './livePreview';
import type { PageDoc } from './pageDoc';
import { pageDocOf, storedState, storeState, viewOf } from './views';

const PASTE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Image types pasted as PNG (M4b §4): TIFF from Preview or Photos, BMP,
 *  HEIC… whatever the webview can decode. SVG is left to the editor. */
const convertible = (type: string) =>
  type.startsWith('image/') && !PASTE_TYPES[type] && type !== 'image/svg+xml';

/** `image` drawn into a PNG through a canvas; `null` when the webview can't
 *  decode it. */
export async function toPng(image: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(image);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
  } catch {
    return null;
  }
}

/** Files shown inline (`![[…]]`); anything else is linked (`[[…]]`). */
const EMBEDDED = new Set([
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'pdf'],
  ...['mp3', 'm4a', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'webm'],
]);

const pad = (n: number) => String(n).padStart(2, '0');

/** Obsidian's name for a pasted image (local time); `null` for other types. */
export function pastedName(at: Date, type: string): string | null {
  const ext = PASTE_TYPES[type];
  if (!ext) return null;
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

const embedded = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && EMBEDDED.has(name.slice(dot + 1).toLowerCase());
};

/** The text inserted for a saved file whose wiki target is `link`. */
export function embedFor(link: string): string {
  return embedded(link.slice(link.lastIndexOf('/') + 1)) ? `![[${link}]]` : `[[${link}]]`;
}

/** A file named by its `file:` URL (M4b part 3 §7, §8): `![](url)` for media
 *  and PDFs, `[name](url)` for the rest — the form Obsidian opens too. */
export function fileLinkFor(name: string, url: string): string {
  if (embedded(name)) return `![](${url})`;
  return `[${name.replace(/[[\]\r\n]/g, ' ')}](${url})`;
}

/** What to insert for a saved attachment: its file: URL in the absolute link
 *  format, else its wiki embed or link. */
export function markupFor(a: Attached): string {
  return a.url ? fileLinkFor(a.link.slice(a.link.lastIndexOf('/') + 1), a.url) : embedFor(a.link);
}

// ---- drop caret and pending insertion points ----

/** The hover caret: where files dragged over the text would land. */
const setDropAt = StateEffect.define<number | null>();

/** A drop whose files are being copied, and where they will land. */
interface Pending {
  id: number;
  pos: number;
}
const addPending = StateEffect.define<Pending>();
const endPending = StateEffect.define<number>();

class CaretWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-nimw-drop-caret';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

const caretsAt = (positions: readonly number[]): DecorationSet =>
  Decoration.set(
    positions.map((pos) => Decoration.widget({ widget: new CaretWidget(), side: 1 }).range(pos)),
    true,
  );

const dropAt = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setDropAt)) return e.value;
    return pos === null ? null : tr.changes.mapPos(pos, 1);
  },
  provide: (f) => EditorView.decorations.from(f, (pos) => caretsAt(pos === null ? [] : [pos])),
});

/** Insertion points of drops still copying, one per drop, mapped through edits
 *  made meanwhile. They are kept apart from the hover caret, so dragging more
 *  files over the text can't move them (final review minor 4); each shows a
 *  caret until its files land. */
const pending = StateField.define<readonly Pending[]>({
  create: () => [],
  update(list, tr) {
    let next =
      tr.docChanged && list.length
        ? list.map(({ id, pos }) => ({ id, pos: tr.changes.mapPos(pos, 1) }))
        : list;
    for (const e of tr.effects) {
      if (e.is(addPending)) next = [...next, e.value];
      else if (e.is(endPending)) next = next.filter((p) => p.id !== e.value);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (list) => caretsAt(list.map((p) => p.pos))),
});

const pendingAt = (state: EditorState, id: number): number | undefined =>
  state.field(pending, false)?.find((p) => p.id === id)?.pos;

const caretTheme = EditorView.baseTheme({
  '.cm-nimw-drop-caret': {
    display: 'inline-block',
    width: '2px',
    height: '1.2em',
    marginRight: '-2px',
    verticalAlign: 'text-bottom',
    background: 'var(--color-accent)',
  },
});

// ---- paste ----

function track(delta: number) {
  useEditorStore.setState((s) => ({ copying: Math.max(0, s.copying + delta) }));
}

// ---- the page a paste or drop belongs to (final review I1) ----

/** The page a paste or drop was made in, taken when it starts. Saving can take
 *  seconds (a large video), and by then the editor may show another page (it
 *  swaps page states into one view) or be gone. */
interface Origin {
  view: EditorView;
  doc: PageDoc | null;
  /** The vault it was made in. */
  root: string | null;
}

const vaultRoot = () => useVaultStore.getState().info?.root ?? null;

const originOf = (view: EditorView): Origin => ({
  view,
  doc: view.state.facet(pageDocOf),
  root: vaultRoot(),
});

/** `state` brought up to `text` (the page was reloaded or merged while in the
 *  background) as the editor does when it shows the page again: outside the
 *  undo history. One change over the differing middle keeps every position
 *  before and after it. */
function caughtUp(state: EditorState, text: string): EditorState {
  const old = state.doc.toString();
  if (old === text) return state;
  const max = Math.min(old.length, text.length);
  let head = 0;
  while (head < max && old.charCodeAt(head) === text.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < max - head &&
    old.charCodeAt(old.length - 1 - tail) === text.charCodeAt(text.length - 1 - tail)
  ) {
    tail++;
  }
  return state.update({
    changes: { from: head, to: old.length - tail, insert: text.slice(head, text.length - tail) },
    annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
  }).state;
}

/** Applies `spec` to the page the paste or drop was made in, wherever it is
 *  now: through the view showing it; else (switched away from, or the editor
 *  closed) to its stored state and its text, which autosaves. Never to the page
 *  shown instead, and not at all once another vault is open. */
function land(origin: Origin, spec: (state: EditorState) => TransactionSpec): void {
  const { doc } = origin;
  if (!doc) return origin.view.dispatch(spec(origin.view.state));
  const live = viewOf(doc);
  if (live) return live.dispatch(spec(live.state));
  if (vaultRoot() !== origin.root) return;
  const stored = storedState(doc);
  const state = caughtUp(stored ?? EditorState.create({ doc: doc.text }), doc.text);
  const next = state.update(spec(state)).state;
  if (stored) storeState(doc, next);
  doc.edit(next.doc.toString());
}

// ---- paste ----

async function pasteImages(view: EditorView, files: File[]) {
  const origin = originOf(view);
  const page = view.state.facet(pagePath)();
  const inserted: string[] = [];
  track(1);
  try {
    for (const pasted of files) {
      const file = PASTE_TYPES[pasted.type] ? pasted : await toPng(pasted);
      if (!file) {
        useToastStore.getState().push({ message: i18next.t('attach.cantPaste'), tone: 'error' });
        continue;
      }
      const name = pastedName(new Date(), PASTE_TYPES[pasted.type] ? pasted.type : 'image/png')!;
      const res = await attachmentPaste(page, name, new Uint8Array(await file.arrayBuffer()));
      if (res.ok) inserted.push(markupFor(res.value));
      else useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    }
  } finally {
    track(-1);
  }
  if (!inserted.length) return;
  const text = inserted.join('\n');
  land(origin, (state) => {
    const { from, to } = state.selection.main;
    return {
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.paste',
    };
  });
  void useVaultStore.getState().refreshTree();
}

const pasteHandler = EditorView.domEventHandlers({
  paste(e, view) {
    // No vault to save the image in (a single-file window, M4c §3), or the
    // page can't change (archived, round-2 review M5).
    if (fileWindowName() !== null || view.state.readOnly) return false;
    const data = e.clipboardData;
    if (!data || data.types.includes('text/plain')) return false;
    const files = [...data.files].filter((f) => PASTE_TYPES[f.type] || convertible(f.type));
    if (!files.length) return false;
    e.preventDefault();
    void pasteImages(view, files);
    return true;
  },
});

/** Paste handling and the drop caret, for every editor mode. */
export function attachmentHandlers(): Extension {
  return [pasteHandler, dropAt, pending, caretTheme];
}

// ---- drop ----

/** Device pixels per unit of a Tauri drag position (final review C1). Tauri
 *  types the position as `PhysicalPosition`, but only WebView2 (Windows)
 *  reports physical pixels. On macOS wry 0.57.0 (`wkwebview/drag_drop.rs`)
 *  takes `NSDraggingInfo.draggingLocation()` and the view frame in AppKit
 *  points, with no `convertPointToBacking`, and tauri-runtime-wry 2.12.1 wraps
 *  that in `PhysicalPosition` unscaled: points are CSS pixels. WebKitGTK
 *  (Linux) reports logical widget coordinates too. */
export function dragPixelRatio(): number {
  const windows = /^Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent);
  return windows ? window.devicePixelRatio || 1 : 1;
}

/** The editor under a drag position (from the webview's top-left corner). */
function target(e: DragDropPayload): { view: EditorView; pos: number } | null {
  if (e.x === undefined || e.y === undefined) return null;
  const ratio = dragPixelRatio();
  const x = e.x / ratio;
  const y = e.y / ratio;
  const el = document.elementFromPoint?.(x, y)?.closest('.cm-editor');
  const view = el instanceof HTMLElement ? EditorView.findFromDOM(el) : null;
  if (!view) return null;
  const pos = view.posAtCoords({ x, y }) ?? view.state.selection.main.head;
  return { view, pos };
}

const failureLine = (source: string, error: CommandError) =>
  `${nameOf(source.replace(/[\\/]+$/, ''))}: ${errorMessage(error)}`;

/** Drops so far: each pending insertion point has its own id. */
let drops = 0;

async function dropFiles(origin: Origin, id: number, paths: string[]) {
  const page = origin.view.state.facet(pagePath)();
  track(1);
  const res = await attachmentImport(page, paths).finally(() => track(-1));
  if (!res.ok) {
    land(origin, () => ({ effects: endPending.of(id) }));
    useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    return;
  }
  const links = res.value.flatMap((r) => (r.ok ? [markupFor(r.ok)] : []));
  const failed = res.value.flatMap((r) => (r.err ? [failureLine(r.source, r.err)] : []));
  const text = links.join('\n');
  land(origin, (state) => {
    if (!text) return { effects: endPending.of(id) };
    const pos = pendingAt(state, id) ?? state.selection.main.head;
    return {
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: 'input.drop',
      effects: endPending.of(id),
    };
  });
  if (text) void useVaultStore.getState().refreshTree();
  if (failed.length) {
    useToastStore.getState().push({
      message: i18next.t('attach.someFailed'),
      detail: failed,
      tone: 'error',
    });
  }
}

/** Imports `paths` (granted by a drop or the Attach dialog) for the page in
 *  `view` and inserts them at the cursor, one per line (M4b part 3 §7). */
export function attachPaths(view: EditorView, paths: string[]): void {
  if (view.state.readOnly) return;
  const id = ++drops;
  view.dispatch({ effects: addPending.of({ id, pos: view.state.selection.main.head }) });
  void dropFiles(originOf(view), id, paths);
}

/** Inserts `text` at the cursor (replacing the selection) as one undo step. */
export function insertAtCursor(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
    userEvent: 'input.attach',
  });
}

let caretView: EditorView | null = null;

function moveCaret(next: { view: EditorView; pos: number } | null) {
  if (caretView && caretView !== next?.view) {
    caretView.dispatch({ effects: setDropAt.of(null) });
  }
  caretView = next?.view ?? null;
  next?.view.dispatch({ effects: setDropAt.of(next.pos) });
}

/** The files of the drag in progress, from its `enter` (`over` carries none).
 *  wry routes every drag through the native handler, so dragging text gives
 *  an empty list: such drags are left alone (final review minor 3). */
let dragPaths: string[] = [];

function onDrag(e: DragDropPayload) {
  if (e.type === 'enter') dragPaths = e.paths ?? [];
  const paths = e.type === 'drop' ? (e.paths ?? dragPaths) : dragPaths;
  if (e.type === 'drop' || e.type === 'leave') dragPaths = [];
  if (e.type === 'leave') return moveCaret(null);
  if (!paths.length) return moveCaret(null);
  const hit = target(e);
  if (e.type !== 'drop') return moveCaret(hit);
  moveCaret(null);
  if (!hit) {
    useToastStore.getState().push({ message: i18next.t('attach.dropOnText') });
    return;
  }
  if (hit.view.state.readOnly) return; // archived: nothing to add to (round-2 review M5)
  const id = ++drops;
  hit.view.dispatch({ effects: addPending.of({ id, pos: hit.pos }) });
  void dropFiles(originOf(hit.view), id, paths);
}

/** Listens to native file drags for the whole window; returns the unsubscribe. */
export function installFileDrop(): Promise<() => void> {
  return onDragDrop(onDrag);
}

export function installFileDropIfTauri(): void {
  if (isTauri()) void installFileDrop().catch(() => undefined);
}
