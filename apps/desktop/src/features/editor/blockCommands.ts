// Block moves in the editor (M4 §3, §5): one transaction per move — a single
// undo step of its own — and Alt+↑ / Alt+↓ for headings, list items and table
// rows (anywhere else CodeMirror's line move stays).
import { isolateHistory } from '@codemirror/commands';
import type { EditorState, Text } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import i18next from 'i18next';
import {
  movableBlocks,
  neighbourSlot,
  unitAt,
  type BlockModel,
  type Slot,
  type Unit,
} from '../../markdown/blockModel';
import { moveBlock, type MoveOptions } from '../../markdown/blockMoves';
import { reparse } from '../../markdown/incremental';
import { parsePage } from '../../markdown/parse';
import type { ParsedPage } from '../../markdown/types';
import { useToastStore } from '../../stores/toastStore';

interface Modelled {
  text: string;
  page: ParsedPage;
  model: BlockModel;
}

/** The block model of each document seen, re-parsed incrementally from the
 *  last one (a move needs it at once; Live Preview's model can lag). */
const models = new WeakMap<Text, Modelled>();
let last: Modelled | null = null;

export function modelFor(state: EditorState): Modelled {
  const known = models.get(state.doc);
  if (known) return known;
  const text = state.doc.toString();
  const page = last ? reparse(last.page, last.text, text) : parsePage(text);
  const out = { text, page, model: movableBlocks(text, page) };
  models.set(state.doc, out);
  last = out;
  return out;
}

/** Moves `unit` to `slot` in the editor as one undo step; the cursor goes to
 *  the start of the moved block. */
export function applyMove(
  view: EditorView,
  unit: Unit,
  slot: Slot,
  options: MoveOptions = {},
): 'moved' | 'refused' | 'none' {
  const { text, model } = modelFor(view.state);
  const r = moveBlock(text, model, unit, slot, options);
  if (!r) return 'none';
  if ('refused' in r) {
    useToastStore.getState().push({ message: i18next.t('editor.blocks.refused'), tone: 'error' });
    return 'refused';
  }
  view.dispatch({
    changes: r.changes,
    selection: { anchor: r.at },
    scrollIntoView: true,
    userEvent: 'move.block',
    annotations: isolateHistory.of('full'),
  });
  return 'moved';
}

/** The units Alt+↑ / Alt+↓ move from the editor. */
const KEYED = new Set(['heading', 'listItem', 'tableRow']);

/** The heading, list item or table row holding the whole selection. */
function unitAtSelection(state: EditorState, model: BlockModel): Unit | null {
  const sel = state.selection.main;
  const u = unitAt(model, sel.head);
  if (!u || !KEYED.has(u.kind)) return null;
  return sel.from >= u.from && sel.to <= u.to ? u : null;
}

/** Alt+↑ (-1) / Alt+↓ (+1). */
export function moveBlockAtCursor(dir: -1 | 1): Command {
  return (view) => {
    const { model } = modelFor(view.state);
    const unit = unitAtSelection(view.state, model);
    if (!unit) return false;
    const slot = neighbourSlot(model, unit, dir);
    // At the edge nothing moves — and the key isn't passed on to move a line.
    if (slot) applyMove(view, unit, slot);
    return true;
  };
}

export const blockKeymap = [
  { key: 'Alt-ArrowUp', run: moveBlockAtCursor(-1) },
  { key: 'Alt-ArrowDown', run: moveBlockAtCursor(1) },
];
