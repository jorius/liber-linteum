// Moving a block (M4 §3): the source edits for one move, and the guard that
// refuses any move whose result wouldn't hold the same blocks.
import type { Node, Parent, RootContent } from 'mdast';
import {
  kindOf,
  slotsFor,
  sameSlot,
  spanOf,
  topUnits,
  type BlockModel,
  type Slot,
  type Unit,
} from './blockModel';
import type { TextChange } from './frontmatterEdit';
import { parsePage } from './parse';

export interface Move {
  /** Non-overlapping edits of the original text, in order (one transaction). */
  changes: TextChange[];
  /** Where the moved block starts in the new text. */
  at: number;
}

/** `null`: the slot leaves the block where it is (or isn't one of its slots). */
export type MoveResult = Move | { refused: true } | null;

export interface MoveOptions {
  /** Alt: a heading moves its line alone, not its section (DND-07). */
  lineOnly?: boolean;
}

const eolOf = (text: string) => {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
};

/** `text` with `changes` (sorted, non-overlapping) applied. */
export function applyChanges(text: string, changes: TextChange[]): string {
  let out = '';
  let last = 0;
  for (const c of changes) {
    out += text.slice(last, c.from) + c.insert;
    last = c.to;
  }
  return out + text.slice(last);
}

/** Where `pos` of the old text lands in the new one. */
function mapPos(changes: TextChange[], pos: number, assoc: -1 | 1): number {
  let delta = 0;
  for (const c of changes) {
    if (c.to < pos || (c.to === pos && (c.from < pos || assoc === 1))) {
      delta += c.insert.length - (c.to - c.from);
    } else if (c.from < pos) {
      return c.from + delta + (assoc === 1 ? c.insert.length : 0);
    }
  }
  return pos + delta;
}

/** The previous line is blank, or `pos` is where content starts. */
function blankBefore(text: string, pos: number, contentStart: number): boolean {
  return pos <= contentStart || /\n[ \t]*\r?\n$/.test(text.slice(Math.max(0, pos - 256), pos));
}

/** A top-level block (or section) moved before `before`, or to the end. */
function topMove(
  text: string,
  model: BlockModel,
  unit: Unit,
  before: Unit | null,
  lineOnly: boolean,
): Move {
  const eol = eolOf(text);
  const [from, to] = spanOf(unit, lineOnly);
  const tops = topUnits(model);
  const prev = [...tops].reverse().find((u) => u.to <= from && u.from < from);
  const next = tops.find((u) => u.from >= to && u.from > from);
  const chunk = text.slice(from, to);

  // Take it out: the blank lines around it go too, and its neighbours keep
  // one blank line between them. Anything that isn't a block next to it (a
  // %% comment) stays: only the block's own lines go then.
  const gapBefore = text.slice(prev ? prev.to : model.contentStart, from);
  const gapAfter = text.slice(to, next ? next.from : text.length);
  let del: TextChange;
  if (/\S/.test(gapBefore) || /\S/.test(gapAfter)) {
    const end = text.startsWith('\r\n', to) ? to + 2 : text[to] === '\n' ? to + 1 : to;
    del = { from, to: end, insert: '' };
  } else if (prev && next) {
    del = { from: prev.to, to: next.from, insert: eol + eol };
  } else if (next) {
    del = { from, to: next.from, insert: '' };
  } else if (prev) {
    del = { from: prev.to, to, insert: '' };
  } else {
    del = { from, to, insert: '' };
  }

  // Put it in, with a blank line on each side.
  let ins: TextChange;
  let lead: number;
  if (before) {
    const prefix = blankBefore(text, before.from, model.contentStart) ? '' : eol;
    lead = prefix.length;
    ins = { from: before.from, to: before.from, insert: prefix + chunk + eol + eol };
  } else {
    const endsEol = /\n$/.test(text);
    const prefix = endsEol ? eol : eol + eol;
    lead = prefix.length;
    ins = { from: text.length, to: text.length, insert: prefix + chunk + (endsEol ? eol : '') };
  }
  const changes = ins.from <= del.from ? [ins, del] : [del, ins];
  return { changes, at: mapPos(changes, ins.from, -1) + lead };
}

/** Moves `unit` to `slot` (M4 §3). */
export function moveBlock(
  text: string,
  model: BlockModel,
  unit: Unit,
  slot: Slot,
  options: MoveOptions = {},
): MoveResult {
  const lineOnly = !!options.lineOnly;
  if (!slotsFor(model, unit, lineOnly).some((s) => sameSlot(s, slot))) return null;
  let move: Move | null = null;
  if (slot.scope === 'top' && unit.scope === 'top') {
    move = topMove(
      text,
      model,
      unit,
      slot.before === null ? null : model.units[slot.before],
      lineOnly,
    );
  }
  if (!move) return null;
  return holdsTheSameBlocks(text, model, move.changes) ? move : { refused: true };
}

// ---- the guard ------------------------------------------------------------

/** Containers recorded in a block's signature; lists only as "in a list", so
 *  moving an item between levels or lists keeps its signature. */
const FLAG: Record<string, string> = {
  blockquote: 'Q',
  callout: 'C',
  columns: 'K',
  column: 'k',
  table: 'T',
  footnoteDefinition: 'F',
};
const LEAF = new Set([
  'paragraph',
  'heading',
  'code',
  'html',
  'thematicBreak',
  'definition',
  'math',
  'yaml',
  'tableRow',
  'calloutTitle',
]);

/** What must survive a move: every block's text (indentation, `>` and list
 *  markers aside), the containers it sits in, task states, `%%` comments and
 *  the kinds of the top-level blocks. */
function signature(src: string): string[] {
  const page = parsePage(src);
  const out: string[] = page.comments.map(([s, e]) => `%${src.slice(s, e)}`);
  const norm = (n: Node) =>
    src
      .slice(n.position!.start.offset!, n.position!.end.offset!)
      .split(/\r?\n/)
      .map((l) => l.replace(/^[ \t>]*/, '').trimEnd())
      .join('\n');
  const walk = (node: Node, flags: string) => {
    if (node.type === 'listItem')
      out.push(`item:${flags}:${String((node as { checked?: boolean | null }).checked ?? '')}`);
    if (LEAF.has(node.type)) {
      const n = node as {
        depth?: number;
        lang?: string | null;
        meta?: string | null;
        value?: string;
      };
      const body = node.type === 'code' ? `${n.lang ?? ''}|${n.meta ?? ''}|${n.value}` : norm(node);
      out.push(`${flags}:${node.type}:${n.depth ?? ''}:${body}`);
      return;
    }
    const inList = node.type === 'list' || node.type === 'listItem';
    const next = inList
      ? flags.includes('L')
        ? flags
        : `${flags}L`
      : flags + (FLAG[node.type] ?? '');
    for (const c of ((node as Parent).children as Node[]) ?? []) walk(c, next);
  };
  for (const node of page.tree.children as RootContent[]) {
    if (node.type !== 'yaml') out.push(`top:${kindOf(node)}`);
    walk(node, '');
  }
  return out.sort();
}

/** The old text's windows around the edits: the top-level blocks they touch
 *  and one more on each side, merged where they meet. */
function windows(text: string, model: BlockModel, changes: TextChange[]): [number, number][] {
  const tops = topUnits(model);
  const spans = changes.map((c): [number, number] => {
    let i = -1;
    tops.forEach((u, k) => {
      if (u.from <= c.from) i = k;
    });
    let j = tops.findIndex((u) => u.to >= c.to);
    if (j < 0) j = tops.length;
    const a = i >= 1 ? tops[i - 1].from : 0;
    const b = j + 1 < tops.length ? tops[j + 1].to : text.length;
    return [Math.min(a, c.from), Math.max(b, c.to)];
  });
  spans.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

/** The move keeps every block (M4 §3, the re-parse guard). Only the windows
 *  around the edits are parsed, so a 200 KB note stays fast (amendment). */
function holdsTheSameBlocks(text: string, model: BlockModel, changes: TextChange[]): boolean {
  const next = applyChanges(text, changes);
  const before: string[] = [];
  const after: string[] = [];
  for (const [a, b] of windows(text, model, changes)) {
    before.push(...signature(text.slice(a, b)));
    after.push(...signature(next.slice(mapPos(changes, a, -1), mapPos(changes, b, 1))));
  }
  return before.sort().join('\u0000') === after.sort().join('\u0000');
}
