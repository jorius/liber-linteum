// Moving a block (M4 §3): the source edits for one move, and the guard that
// refuses any move whose result wouldn't hold the same blocks.
import type { Node, Parent, RootContent } from 'mdast';
import {
  ITEM_LINE,
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

/** Taking the top-level span [from, to) out: the blank lines around it go
 *  too, and its neighbours keep one blank line between them. Anything that
 *  isn't a block next to it (a %% comment) stays: only the span's own lines
 *  go then. */
function topDeletion(text: string, model: BlockModel, from: number, to: number): TextChange {
  const eol = eolOf(text);
  const tops = topUnits(model);
  const prev = [...tops].reverse().find((u) => u.to <= from && u.from < from);
  const next = tops.find((u) => u.from >= to && u.from > from);
  const gapBefore = text.slice(prev ? prev.to : model.contentStart, from);
  const gapAfter = text.slice(to, next ? next.from : text.length);
  if (/\S/.test(gapBefore) || /\S/.test(gapAfter)) {
    const end = text.startsWith('\r\n', to) ? to + 2 : text[to] === '\n' ? to + 1 : to;
    return { from, to: end, insert: '' };
  }
  if (prev && next) return { from: prev.to, to: next.from, insert: eol + eol };
  if (next) return { from, to: next.from, insert: '' };
  if (prev) return { from: prev.to, to, insert: '' };
  return { from, to, insert: '' };
}

/** Putting `chunk` among the top-level blocks, before `before` or at the
 *  end, with a blank line on each side; `lead` is what comes before it. */
function topInsertion(
  text: string,
  model: BlockModel,
  before: Unit | null,
  chunk: string,
): { change: TextChange; lead: number } {
  const eol = eolOf(text);
  if (before) {
    const prefix = blankBefore(text, before.from, model.contentStart) ? '' : eol;
    return {
      change: { from: before.from, to: before.from, insert: prefix + chunk + eol + eol },
      lead: prefix.length,
    };
  }
  const endsEol = /\n$/.test(text);
  const prefix = endsEol ? eol : eol + eol;
  return {
    change: { from: text.length, to: text.length, insert: prefix + chunk + (endsEol ? eol : '') },
    lead: prefix.length,
  };
}

/** Insertions before replacements at the same place. */
const sorted = (changes: TextChange[]) =>
  [...changes].sort((a, b) => a.from - b.from || a.to - a.from - (b.to - b.from));

/** A top-level block (or section) moved before `before`, or to the end. */
function topMove(
  text: string,
  model: BlockModel,
  unit: Unit,
  before: Unit | null,
  lineOnly: boolean,
): Move {
  const [from, to] = spanOf(unit, lineOnly);
  const del = topDeletion(text, model, from, to);
  const { change: ins, lead } = topInsertion(text, model, before, text.slice(from, to));
  const changes = sorted([ins, del]);
  return { changes, at: mapPos(changes, ins.from, -1) + lead };
}

// ---- list items and table rows (line by line inside their top-level block) --

/** Leading whitespace in columns (a tab to the next multiple of 4). */
function leadCols(line: string): number {
  let c = 0;
  for (const ch of line) {
    if (ch === ' ') c++;
    else if (ch === '\t') c += 4 - (c % 4);
    else break;
  }
  return c;
}

/** `line` without its first `n` columns of leading whitespace. */
function stripCols(line: string, n: number): string {
  let c = 0;
  let i = 0;
  while (i < line.length && c < n && (line[i] === ' ' || line[i] === '\t')) {
    c = line[i] === '\t' ? c + 4 - (c % 4) : c + 1;
    i++;
  }
  return ' '.repeat(Math.max(0, c - n)) + line.slice(i);
}

/** Where an item's content starts — and where its children must start
 *  (CommonMark; M2b I2): `- ` → 2, `1. ` → 3, `10. ` → 4. */
function contentCol(line: string): number {
  const m = ITEM_LINE.exec(line)!;
  const gap = m[5].length;
  return leadCols(m[1]) + m[2].length + (gap >= 1 && gap <= 4 ? gap : 1);
}

/** Gives the item at lines [s, e] the marker `marker`; when the marker's
 *  width changes, its other lines (nested items included) shift with it. */
function setMarker(lines: string[], s: number, e: number, marker: string) {
  const m = ITEM_LINE.exec(lines[s]);
  if (!m || m[2] === marker) return;
  const before = contentCol(lines[s]);
  lines[s] = m[1] + marker + lines[s].slice(m[1].length + m[2].length);
  const d = contentCol(lines[s]) - before;
  if (!d) return;
  for (let k = s + 1; k <= e; k++) {
    if (!lines[k].trim()) continue;
    lines[k] = d > 0 ? ' '.repeat(d) + lines[k] : stripCols(lines[k], -d);
  }
}

/** Where line `k` of `lines` starts once they're joined with `eol`. */
const offsetOf = (lines: string[], k: number, eol: string) =>
  lines.slice(0, k).reduce((n, l) => n + l.length + eol.length, 0);

/** The lines of a top-level block with `removed` taken out and `ins` put
 *  before original line `insertAt`; `map` gives each kept line's new index. */
function rebuild(
  lines: string[],
  removed: [number, number] | null,
  insertAt: number | null,
  ins: string[],
) {
  const out: string[] = [];
  const map: number[] = [];
  let insAt = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i === insertAt) {
      insAt = out.length;
      out.push(...ins);
    }
    if (i === lines.length) break;
    if (removed && i >= removed[0] && i <= removed[1]) {
      map[i] = -1;
      continue;
    }
    map[i] = out.length;
    out.push(lines[i]);
  }
  return { out, map, insAt };
}

/** The numbers an ordered list's items get after a move, given its numbers
 *  before (`original`) and each item's own number in the new order
 *  (`current`): a sequential list stays sequential, an all-the-same list
 *  stays the same, any other keeps every item's own number. */
function numbersFor(original: number[], current: number[]): number[] {
  const start = original.length ? original[0] : 1;
  if (original.every((n, k) => n === start + k)) return current.map((_, k) => start + k);
  if (original.every((n) => n === start)) return current.map(() => start);
  return current;
}

/** A list item moved to `slot` (M4 §3). */
function itemMove(
  text: string,
  model: BlockModel,
  unit: Unit,
  slot: Slot,
): { move: Move; topDelta: number } | null {
  const eol = eolOf(text);
  const list = model.lists[unit.container!];
  const srcTop = model.units[list.top];
  const alone = list.depth === 0 && list.items.length === 1;
  if (alone && slot.scope === 'top') {
    return {
      move: topMove(
        text,
        model,
        srcTop,
        slot.before === null ? null : model.units[slot.before],
        false,
      ),
      topDelta: 0,
    };
  }
  const linesOf = (u: Unit) => text.slice(u.from, u.to).split(/\r?\n/);
  const lineIn = (region: Unit, pos: number) => text.slice(region.from, pos).split('\n').length - 1;
  const spanIn = (region: Unit, id: number): [number, number] => [
    lineIn(region, model.units[id].from),
    lineIn(region, model.units[id].to),
  ];
  const lineText = (pos: number) =>
    text
      .slice(pos, text.indexOf('\n', pos) < 0 ? text.length : text.indexOf('\n', pos))
      .replace(/\r$/, '');
  const numberOf = (id: number) => Number(ITEM_LINE.exec(lineText(model.units[id].from))?.[3] ?? 1);

  // The item's lines, and what goes with taking them out.
  const srcLines = linesOf(srcTop);
  const [s, e] = spanIn(srcTop, unit.id);
  const idx = list.items.indexOf(unit.id);
  let removed: [number, number];
  if (idx < list.items.length - 1) removed = [s, spanIn(srcTop, list.items[idx + 1])[0] - 1];
  else if (idx > 0) removed = [spanIn(srcTop, list.items[idx - 1])[1] + 1, e];
  else {
    let k = s;
    while (k > 0 && !srcLines[k - 1].trim()) k--;
    removed = [k, e];
  }

  // Where it goes, how indented, with which marker.
  const own = ITEM_LINE.exec(srcLines[s])!;
  let target: Unit | null = null;
  let insertAt = 0;
  let indent = '';
  let marker = own[2];
  let into: number | null = null; // the list it joins
  let loose = false;
  const looseList = (l: number) =>
    model.lists[l].items.some((id, k) => {
      if (k === 0) return false;
      const at = model.units[id].from;
      return /\n[ \t]*\r?\n$/.test(text.slice(Math.max(0, at - 64), at));
    });
  if (slot.scope === 'item') {
    const l = model.lists[slot.list];
    target = model.units[l.top];
    into = slot.list;
    loose = looseList(slot.list);
    const others = l.items.filter((id) => id !== unit.id);
    const ref = slot.before ?? others[others.length - 1];
    indent = /^[ \t]*/.exec(lineText(model.units[ref].from))![0];
    insertAt = slot.before !== null ? spanIn(target, slot.before)[0] : spanIn(target, ref)[1] + 1;
    marker = l.ordered ? `1${l.marker}` : l.marker;
  } else if (slot.scope === 'child') {
    const p = model.units[slot.of];
    target = model.units[model.lists[p.container!].top];
    indent = ' '.repeat(contentCol(lineText(p.from)));
    insertAt = spanIn(target, p.id)[1] + 1;
    if (own[3]) marker = `1${own[4]}`;
  }
  const chunk = srcLines
    .slice(s, e + 1)
    .map((l) => (l.trim() ? indent + stripCols(l, leadCols(srcLines[s])) : ''));
  setMarker(chunk, 0, chunk.length - 1, marker);
  const ins =
    slot.scope === 'item' && loose
      ? slot.before !== null
        ? [...chunk, '']
        : ['', ...chunk]
      : chunk;

  // Renumbers an ordered list in the rebuilt lines.
  const renumber = (
    out: string[],
    map: number[],
    region: Unit,
    l: number,
    insAt: number | null,
  ) => {
    const info = model.lists[l];
    if (!info.ordered) return;
    const items = info.items
      .filter((id) => id !== unit.id)
      .map((id) => ({
        span: spanIn(region, id).map((i) => map[i]) as [number, number],
        own: numberOf(id),
      }));
    if (insAt !== null && l === into) {
      const first = insAt + (ins[0] === '' ? 1 : 0);
      items.push({ span: [first, first + chunk.length - 1], own: own[3] ? Number(own[3]) : NaN });
    }
    items.sort((a, b) => a.span[0] - b.span[0]);
    const original = info.items.map(numberOf);
    const nums = numbersFor(
      original,
      items.map((it, k) =>
        Number.isNaN(it.own) ? (items[k - 1]?.own ?? original[0] ?? 0) + 1 : it.own,
      ),
    );
    items.forEach((it, k) => setMarker(out, it.span[0], it.span[1], `${nums[k]}${info.marker}`));
  };

  const first = (insAt: number) => insAt + (ins[0] === '' ? 1 : 0);
  if (target && target.id === srcTop.id) {
    // Within one top-level list: one edit.
    const { out, map, insAt } = rebuild(srcLines, removed, insertAt, ins);
    if (into !== null) renumber(out, map, srcTop, into, insAt);
    if (list.ordered && unit.container !== into) renumber(out, map, srcTop, unit.container!, null);
    return {
      move: {
        changes: [{ from: srcTop.from, to: srcTop.to, insert: out.join(eol) }],
        at: srcTop.from + offsetOf(out, first(insAt), eol),
      },
      topDelta: 0,
    };
  }
  // Out of its list (the list goes with its last item)…
  const changes: TextChange[] = [];
  let topDelta = 0;
  if (alone) {
    changes.push(topDeletion(text, model, srcTop.from, srcTop.to));
    topDelta = -1;
  } else {
    const { out, map } = rebuild(srcLines, removed, null, []);
    if (list.ordered) renumber(out, map, srcTop, unit.container!, null);
    changes.push({ from: srcTop.from, to: srcTop.to, insert: out.join(eol) });
  }
  // …into another top-level list…
  if (target) {
    const { out, map, insAt } = rebuild(linesOf(target), null, insertAt, ins);
    if (into !== null) renumber(out, map, target, into, insAt);
    changes.push({ from: target.from, to: target.to, insert: out.join(eol) });
    const ordered = sorted(changes);
    const at = mapPos(ordered, target.from, -1) + offsetOf(out, first(insAt), eol);
    return { move: { changes: ordered, at }, topDelta };
  }
  // …or among the top-level blocks, as a list of its own.
  const before = slot.scope === 'top' && slot.before !== null ? model.units[slot.before] : null;
  const { change, lead } = topInsertion(text, model, before, chunk.join(eol));
  changes.push(change);
  const ordered = sorted(changes);
  return {
    move: { changes: ordered, at: mapPos(ordered, change.from, -1) + lead },
    topDelta: topDelta + 1,
  };
}

/** A table body row moved within its table. */
function rowMove(text: string, model: BlockModel, unit: Unit, slot: Slot & { scope: 'row' }): Move {
  const eol = eolOf(text);
  const table = model.tables[unit.container!];
  const region = model.units[table.unit];
  const lines = text.slice(region.from, region.to).split(/\r?\n/);
  const lineIn = (pos: number) => text.slice(region.from, pos).split('\n').length - 1;
  const s = lineIn(unit.from);
  const last = model.units[table.rows[table.rows.length - 1]];
  const insertAt =
    slot.before === null ? lineIn(last.to) + 1 : lineIn(model.units[slot.before].from);
  const { out, insAt } = rebuild(lines, [s, s], insertAt, [lines[s]]);
  return {
    changes: [{ from: region.from, to: region.to, insert: out.join(eol) }],
    at: region.from + offsetOf(out, insAt, eol),
  };
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
  let topDelta = 0;
  if (unit.scope === 'top' && slot.scope === 'top') {
    move = topMove(
      text,
      model,
      unit,
      slot.before === null ? null : model.units[slot.before],
      lineOnly,
    );
  } else if (unit.scope === 'item') {
    const r = itemMove(text, model, unit, slot);
    if (r) ({ move, topDelta } = r);
  } else if (unit.scope === 'row' && slot.scope === 'row') {
    move = rowMove(text, model, unit, slot);
  }
  if (!move) return null;
  return holdsTheSameBlocks(text, model, move.changes, topDelta) ? move : { refused: true };
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
function holdsTheSameBlocks(
  text: string,
  model: BlockModel,
  changes: TextChange[],
  topLists = 0,
): boolean {
  const next = applyChanges(text, changes);
  // A list item dropped among the top-level blocks makes a new list; the
  // last item leaving a list takes the list away.
  const before: string[] = Array.from({ length: Math.max(0, topLists) }, () => 'top:list');
  const after: string[] = Array.from({ length: Math.max(0, -topLists) }, () => 'top:list');
  for (const [a, b] of windows(text, model, changes)) {
    // A window that doesn't start the note must not read as one: a `---`
    // there is a rule, not the start of front matter.
    const lead = a > 0 ? '\n' : '';
    before.push(...signature(lead + text.slice(a, b)));
    after.push(...signature(lead + next.slice(mapPos(changes, a, -1), mapPos(changes, b, 1))));
  }
  return before.sort().join('\u0000') === after.sort().join('\u0000');
}
