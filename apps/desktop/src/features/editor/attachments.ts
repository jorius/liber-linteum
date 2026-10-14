// Pasted images and files dropped from the OS (M2c §5): saved into the vault
// by Rust, then an embed or link is inserted where they landed. Drops come
// from Tauri's native drag events (Rust only imports paths it saw dropped).
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import i18next from 'i18next';
import {
  attachmentImport,
  attachmentPaste,
  isTauri,
  onDragDrop,
  type CommandError,
  type DragDropPayload,
} from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { nameOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { pagePath } from './livePreview';

const PASTE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

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

/** The text inserted for a saved file whose wiki target is `link`. */
export function embedFor(link: string): string {
  const name = link.slice(link.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return EMBEDDED.has(ext) ? `![[${link}]]` : `[[${link}]]`;
}

// ---- drop caret / pending insertion point ----

/** Where dropped files will land; mapped through edits made while copying. */
const setDropAt = StateEffect.define<number | null>();

class CaretWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-nimw-drop-caret';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

const dropAt = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setDropAt)) return e.value;
    return pos === null ? null : tr.changes.mapPos(pos, 1);
  },
  provide: (f) =>
    EditorView.decorations.from(f, (pos): DecorationSet =>
      pos === null
        ? Decoration.none
        : Decoration.set([Decoration.widget({ widget: new CaretWidget(), side: 1 }).range(pos)]),
    ),
});

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

async function pasteImages(view: EditorView, files: File[]) {
  const page = view.state.facet(pagePath)();
  const inserted: string[] = [];
  track(1);
  try {
    for (const file of files) {
      const name = pastedName(new Date(), file.type)!;
      const res = await attachmentPaste(page, name, new Uint8Array(await file.arrayBuffer()));
      if (res.ok) inserted.push(embedFor(res.value.link));
      else useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    }
  } finally {
    track(-1);
  }
  if (!inserted.length) return;
  const text = inserted.join('\n');
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: 'input.paste',
  });
  void useVaultStore.getState().refreshTree();
}

const pasteHandler = EditorView.domEventHandlers({
  paste(e, view) {
    const data = e.clipboardData;
    if (!data || data.types.includes('text/plain')) return false;
    const files = [...data.files].filter((f) => PASTE_TYPES[f.type]);
    if (!files.length) return false;
    e.preventDefault();
    void pasteImages(view, files);
    return true;
  },
});

/** Paste handling and the drop caret, for every editor mode. */
export function attachmentHandlers(): Extension {
  return [pasteHandler, dropAt, caretTheme];
}

// ---- drop ----

/** The editor under a drag position (physical px from the webview's corner). */
function target(e: DragDropPayload): { view: EditorView; pos: number } | null {
  if (e.x === undefined || e.y === undefined) return null;
  const x = e.x / window.devicePixelRatio;
  const y = e.y / window.devicePixelRatio;
  const el = document.elementFromPoint?.(x, y)?.closest('.cm-editor');
  const view = el instanceof HTMLElement ? EditorView.findFromDOM(el) : null;
  if (!view) return null;
  const pos = view.posAtCoords({ x, y }) ?? view.state.selection.main.head;
  return { view, pos };
}

const failureLine = (source: string, error: CommandError) =>
  `${nameOf(source.replace(/[\\/]+$/, ''))}: ${errorMessage(error)}`;

async function dropFiles(view: EditorView, paths: string[]) {
  const page = view.state.facet(pagePath)();
  track(1);
  const res = await attachmentImport(page, paths).finally(() => track(-1));
  const pos = view.state.field(dropAt, false) ?? view.state.selection.main.head;
  view.dispatch({ effects: setDropAt.of(null) });
  if (!res.ok) {
    useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    return;
  }
  const links = res.value.flatMap((r) => (r.ok ? [embedFor(r.ok.link)] : []));
  const failed = res.value.flatMap((r) => (r.err ? [failureLine(r.source, r.err)] : []));
  if (links.length) {
    const text = links.join('\n');
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: 'input.drop',
    });
    void useVaultStore.getState().refreshTree();
  }
  if (failed.length) {
    useToastStore.getState().push({
      message: i18next.t('attach.someFailed'),
      detail: failed,
      tone: 'error',
    });
  }
}

let caretView: EditorView | null = null;

function moveCaret(next: { view: EditorView; pos: number } | null) {
  if (caretView && caretView !== next?.view) {
    caretView.dispatch({ effects: setDropAt.of(null) });
  }
  caretView = next?.view ?? null;
  next?.view.dispatch({ effects: setDropAt.of(next.pos) });
}

function onDrag(e: DragDropPayload) {
  if (e.type === 'leave') return moveCaret(null);
  const hit = target(e);
  if (e.type !== 'drop') return moveCaret(hit);
  caretView = null;
  if (!hit) {
    useToastStore.getState().push({ message: i18next.t('attach.dropOnText') });
    return;
  }
  hit.view.dispatch({ effects: setDropAt.of(hit.pos) });
  void dropFiles(hit.view, e.paths ?? []);
}

/** Listens to native file drags for the whole window; returns the unsubscribe. */
export function installFileDrop(): Promise<() => void> {
  return onDragDrop(onDrag);
}

export function installFileDropIfTauri(): void {
  if (isTauri()) void installFileDrop().catch(() => undefined);
}
