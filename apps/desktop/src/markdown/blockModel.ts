// What can be moved, and where it can go (M4 §2): the page's blocks as
// whole-line source ranges, with the slots a drop or a keyboard move may use.
// Pure: no DOM, no editor.
import type { Heading, List, ListItem, Node, Paragraph, RootContent, Table } from 'mdast';
import type { ParsedPage } from './types';

export type UnitKind =
  | 'heading'
  | 'paragraph'
  | 'embed'
  | 'list'
  | 'listItem'
  | 'quote'
  | 'callout'
  | 'code'
  | 'table'
  | 'tableRow'
  | 'html'
  | 'columns'
  | 'rule'
  | 'other';

/** A movable block. */
export interface Unit {
  /** Index in `BlockModel.units` (document order). */
  id: number;
  kind: UnitKind;
  /** Start of its first line. */
  from: number;
  /** End of its last line (before the line break). */
  to: number;
  /** A top-level block, a list item (any depth) or a table body row. */
  scope: 'top' | 'item' | 'row';
  /** Items: index of their list in `lists`; rows: index of their table in `tables`. */
  container: number | null;
  /** Items: nesting depth (0 = an item of a top-level list). */
  depth: number;
  /** Headings: level, and where the section ends (DND-07). */
  level?: number;
  sectionTo?: number;
  /** Top-level lists: their index in `lists`. */
  list?: number;
}

/** A list (top-level or nested) and its items. */
export interface ListInfo {
  from: number;
  to: number;
  depth: number;
  ordered: boolean;
  /** `-`, `*`, `+`, or the ordered delimiter `.` / `)`. */
  marker: string;
  /** Unit ids of its items, in order. */
  items: number[];
  /** The item holding this (nested) list; null for a top-level list. */
  parentItem: number | null;
  /** The top-level list unit it belongs to. */
  top: number;
}

export interface TableInfo {
  /** The table's unit id. */
  unit: number;
  /** Unit ids of its body rows, in order. */
  rows: number[];
}

export interface BlockModel {
  units: Unit[];
  lists: ListInfo[];
  tables: TableInfo[];
  /** Where content starts (after the front matter). */
  contentStart: number;
}

/** Where a block may go. */
export type Slot =
  /** Between top-level blocks: before unit `before`, or at the end (`null`). */
  | { scope: 'top'; before: number | null }
  /** Into list `list`: before its item `before`, or at its end (`null`). */
  | { scope: 'item'; list: number; before: number | null }
  /** As the first child of item `of`, which has no nested list yet. */
  | { scope: 'child'; of: number }
  /** Into table `table`: before its body row `before`, or at its end. */
  | { scope: 'row'; table: number; before: number | null };

const start = (n: Node) => n.position!.start.offset!;
const end = (n: Node) => n.position!.end.offset!;

const lineStartAt = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1;
function lineEndAt(text: string, pos: number): number {
  let e = pos;
  while (e < text.length && text[e] !== '\n' && text[e] !== '\r') e++;
  return e;
}

/** A paragraph holding only an embed or an image (and whitespace). */
function isLoneEmbed(p: Paragraph): boolean {
  const kids = p.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
  return kids.length === 1 && (kids[0].type === ('embed' as string) || kids[0].type === 'image');
}

function kindOf(node: RootContent): UnitKind {
  switch (node.type as string) {
    case 'heading':
      return 'heading';
    case 'paragraph':
      return isLoneEmbed(node as Paragraph) ? 'embed' : 'paragraph';
    case 'list':
      return 'list';
    case 'blockquote':
      return 'quote';
    case 'callout':
      return 'callout';
    case 'code':
      return 'code';
    case 'table':
      return 'table';
    case 'html':
      return 'html';
    case 'columns':
      return 'columns';
    case 'thematicBreak':
      return 'rule';
    default:
      return 'other';
  }
}

/** The marker of an item's first line: `-`, `*`, `+`, or `.` / `)` when ordered. */
export const ITEM_LINE = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+|$)/;

/** The page's movable blocks (M4 §2). */
export function movableBlocks(text: string, page: ParsedPage): BlockModel {
  const units: Unit[] = [];
  const lists: ListInfo[] = [];
  const tables: TableInfo[] = [];
  const fm = page.frontmatter;
  const contentStart = fm ? Math.min(text.length, lineEndAt(text, fm.range[1]) + 1) : 0;

  const add = (u: Omit<Unit, 'id'>): Unit => {
    const unit = { ...u, id: units.length } as Unit;
    units.push(unit);
    return unit;
  };
  const range = (n: Node): [number, number] => [
    lineStartAt(text, start(n)),
    lineEndAt(text, end(n)),
  ];

  const addList = (list: List, depth: number, parentItem: number | null, top: number): number => {
    const first = list.children[0];
    const m = first ? ITEM_LINE.exec(text.slice(lineStartAt(text, start(first)))) : null;
    const index = lists.length;
    const [from, to] = range(list);
    lists.push({
      from,
      to,
      depth,
      ordered: !!list.ordered,
      marker: m ? (m[4] ?? m[2]) : list.ordered ? '.' : '-',
      items: [],
      parentItem,
      top,
    });
    for (const item of list.children as ListItem[]) {
      const [f, t] = range(item);
      const unit = add({
        kind: 'listItem',
        from: f,
        to: t,
        scope: 'item',
        container: index,
        depth,
      });
      lists[index].items.push(unit.id);
      for (const child of item.children) {
        if (child.type === 'list') addList(child, depth + 1, unit.id, top);
      }
    }
    return index;
  };

  for (const node of page.tree.children as RootContent[]) {
    if (node.type === 'yaml' || !node.position) continue;
    const [from, to] = range(node);
    const kind = kindOf(node);
    const unit = add({ kind, from, to, scope: 'top', container: null, depth: 0 });
    if (kind === 'heading') unit.level = (node as Heading).depth;
    if (kind === 'list') unit.list = addList(node as List, 0, null, unit.id);
    if (kind === 'table') {
      const index = tables.length;
      tables.push({ unit: unit.id, rows: [] });
      // The first row is the header; the delimiter row isn't a node.
      for (const row of (node as Table).children.slice(1)) {
        const [f, t] = range(row);
        tables[index].rows.push(
          add({ kind: 'tableRow', from: f, to: t, scope: 'row', container: index, depth: 0 }).id,
        );
      }
    }
  }

  // Heading sections: up to the next top-level heading of the same or a
  // higher level (DND-07).
  const tops = units.filter((u) => u.scope === 'top');
  tops.forEach((u, i) => {
    if (u.kind !== 'heading') return;
    let last = u;
    for (let k = i + 1; k < tops.length; k++) {
      const next = tops[k];
      if (next.kind === 'heading' && next.level! <= u.level!) break;
      last = next;
    }
    u.sectionTo = last.to;
  });
  return { units, lists, tables, contentStart };
}

/** The top-level units, in order. */
export const topUnits = (model: BlockModel): Unit[] => model.units.filter((u) => u.scope === 'top');

/** The source range a move of `unit` carries: a heading's whole section,
 *  unless `lineOnly` (Alt). */
export function spanOf(unit: Unit, lineOnly = false): [number, number] {
  return [unit.from, unit.kind === 'heading' && !lineOnly ? unit.sectionTo! : unit.to];
}

/** Ids of the units inside `unit`'s span (its section, or its nested items). */
function inside(model: BlockModel, unit: Unit, lineOnly: boolean): Set<number> {
  const [from, to] = spanOf(unit, lineOnly);
  return new Set(
    model.units.filter((u) => u.id !== unit.id && u.from >= from && u.to <= to).map((u) => u.id),
  );
}

/** The list whose items have this marker kind, for "would two lists merge". */
const markerKind = (l: ListInfo) => (l.ordered ? `o${l.marker}` : `b${l.marker}`);

/** The marker kind of a top-level list unit, or null for other units. */
function topListKind(model: BlockModel, u: Unit | undefined): string | null {
  return u && u.kind === 'list' && u.list !== undefined ? markerKind(model.lists[u.list]) : null;
}

/** The marker kind a list made of `item` alone would have. */
function itemKind(model: BlockModel, item: Unit): string {
  return markerKind(model.lists[item.container!]);
}

/** Every slot `unit` may move to (M4 §2), in document order, without the
 *  ones that leave it where it is. */
export function slotsFor(model: BlockModel, unit: Unit, lineOnly = false): Slot[] {
  const out: Slot[] = [];
  const skip = inside(model, unit, lineOnly);
  const [, spanTo] = spanOf(unit, lineOnly);
  const tops = topUnits(model).filter((u) => u.id !== unit.id && !skip.has(u.id));

  if (unit.scope === 'row') {
    const table = model.tables[unit.container!];
    const rows = table.rows;
    const i = rows.indexOf(unit.id);
    rows.forEach((r, k) => {
      if (k !== i && k !== i + 1) out.push({ scope: 'row', table: unit.container!, before: r });
    });
    if (i !== rows.length - 1) out.push({ scope: 'row', table: unit.container!, before: null });
    return out;
  }

  // Top-level slots: before each top-level unit (outside the moved span), or
  // at the end. A list would merge with a same-marker list next to it.
  const ownKind =
    unit.scope === 'top'
      ? topListKind(model, unit)
      : unit.scope === 'item'
        ? itemKind(model, unit)
        : null;
  const all = topUnits(model);
  const nextAfter = all.find((u) => u.from > spanTo && !skip.has(u.id));
  const prevOf = (pos: number) => [...tops].reverse().find((u) => u.to <= pos);
  const topSlot = (before: Unit | null) => {
    if (unit.scope === 'top' && (before?.id ?? null) === (nextAfter?.id ?? null)) return;
    if (unit.scope === 'top' && before?.id === unit.id) return;
    if (ownKind) {
      const prev = prevOf(before ? before.from : Number.MAX_SAFE_INTEGER);
      if (
        topListKind(model, prev) === ownKind ||
        topListKind(model, before ?? undefined) === ownKind
      )
        return;
    }
    out.push({ scope: 'top', before: before?.id ?? null });
  };
  for (const u of tops) topSlot(u);
  topSlot(null);

  if (unit.scope !== 'item') return out;

  // Item slots: before any item of any list (not inside the item itself), at
  // the end of any list, or as the first child of an item with no nested list.
  const ownList = model.lists[unit.container!];
  const i = ownList.items.indexOf(unit.id);
  const itemSlots: Slot[] = [];
  model.lists.forEach((list, li) => {
    if (list.parentItem !== null && (skip.has(list.parentItem) || list.parentItem === unit.id))
      return;
    list.items.forEach((item, k) => {
      if (skip.has(item) || item === unit.id) return;
      if (li === unit.container && k === i + 1) return;
      itemSlots.push({ scope: 'item', list: li, before: item });
    });
    if (!(li === unit.container && i === ownList.items.length - 1)) {
      itemSlots.push({ scope: 'item', list: li, before: null });
    }
  });
  for (const item of model.units) {
    if (item.scope !== 'item' || item.id === unit.id || skip.has(item.id)) continue;
    if (model.lists.some((l) => l.parentItem === item.id)) continue;
    itemSlots.push({ scope: 'child', of: item.id });
  }
  return [...out, ...itemSlots].sort(
    (a, b) => slotAt(model, a) - slotAt(model, b) || order(a) - order(b),
  );
}

/** Child slots sort after the item they nest under; list ends after the list. */
const order = (s: Slot) =>
  s.scope === 'child' ? 2 : s.scope === 'item' && s.before === null ? 1 : 0;

/** The source offset a slot stands for (for ordering and drawing). */
export function slotAt(model: BlockModel, slot: Slot): number {
  const u = (id: number) => model.units[id];
  switch (slot.scope) {
    case 'top':
      return slot.before === null ? Number.MAX_SAFE_INTEGER : u(slot.before).from;
    case 'item':
      return slot.before === null ? model.lists[slot.list].to : u(slot.before).from;
    case 'child':
      return u(slot.of).to;
    case 'row': {
      const rows = model.tables[slot.table].rows;
      return slot.before === null ? u(rows[rows.length - 1]).to : u(slot.before).from;
    }
  }
}

/** Two slots are the same place. */
export const sameSlot = (a: Slot, b: Slot): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The slot for Move up (-1) / Move down (+1), or null at the edge (M4 §5).
 *  A heading's section moves past the neighbouring section of its level. */
export function neighbourSlot(
  model: BlockModel,
  unit: Unit,
  dir: -1 | 1,
  lineOnly = false,
): Slot | null {
  if (unit.scope === 'row') {
    const rows = model.tables[unit.container!].rows;
    const i = rows.indexOf(unit.id);
    if (dir === -1)
      return i > 0 ? { scope: 'row', table: unit.container!, before: rows[i - 1] } : null;
    if (i >= rows.length - 1) return null;
    return {
      scope: 'row',
      table: unit.container!,
      before: i + 2 < rows.length ? rows[i + 2] : null,
    };
  }
  if (unit.scope === 'item') {
    const items = model.lists[unit.container!].items;
    const i = items.indexOf(unit.id);
    if (dir === -1)
      return i > 0 ? { scope: 'item', list: unit.container!, before: items[i - 1] } : null;
    if (i >= items.length - 1) return null;
    return {
      scope: 'item',
      list: unit.container!,
      before: i + 2 < items.length ? items[i + 2] : null,
    };
  }
  const tops = topUnits(model);
  const i = tops.indexOf(unit);
  const section = unit.kind === 'heading' && !lineOnly;
  const allowed = slotsFor(model, unit, lineOnly);
  const ok = (s: Slot | null) => (s && allowed.some((a) => sameSlot(a, s)) ? s : null);
  if (dir === -1) {
    // Before the previous top-level unit — for a section, before the
    // previous heading of its level or higher.
    let k = i - 1;
    if (section)
      while (k >= 0 && !(tops[k].kind === 'heading' && tops[k].level! <= unit.level!)) k--;
    if (k < 0 && section && i > 0) k = 0;
    return k >= 0 ? ok({ scope: 'top', before: tops[k].id }) : null;
  }
  const [, to] = spanOf(unit, lineOnly);
  const next = tops.find((u) => u.from > to);
  if (!next) return null;
  // After the next unit — for a section (or past a heading), after the next
  // heading's section at the moved heading's level.
  let after = next.to;
  if (next.kind === 'heading' && section) {
    const level = Math.max(unit.level!, next.level!);
    const j = tops.indexOf(next);
    after = next.to;
    for (let k = j + 1; k < tops.length; k++) {
      if (tops[k].kind === 'heading' && tops[k].level! <= level) break;
      after = tops[k].to;
    }
  }
  const beyond = tops.find((u) => u.from > after);
  return ok({ scope: 'top', before: beyond ? beyond.id : null });
}

/** Indent (+1: become the last child of the previous sibling) or outdent
 *  (-1: follow the parent item in its list) a list item; null when it can't. */
export function indentSlot(model: BlockModel, unit: Unit, dir: -1 | 1): Slot | null {
  if (unit.scope !== 'item') return null;
  const list = model.lists[unit.container!];
  const i = list.items.indexOf(unit.id);
  if (dir === 1) {
    if (i === 0) return null;
    const prev = list.items[i - 1];
    const nested = model.lists.findIndex((l) => l.parentItem === prev);
    return nested >= 0
      ? { scope: 'item', list: nested, before: null }
      : { scope: 'child', of: prev };
  }
  if (list.parentItem === null) return null;
  const parent = model.units[list.parentItem];
  const outer = model.lists[parent.container!];
  const k = outer.items.indexOf(parent.id);
  return {
    scope: 'item',
    list: parent.container!,
    before: k + 1 < outer.items.length ? outer.items[k + 1] : null,
  };
}

/** The deepest unit whose range holds `pos` (items before their list). */
export function unitAt(model: BlockModel, pos: number): Unit | null {
  let best: Unit | null = null;
  for (const u of model.units) {
    if (u.from <= pos && pos <= u.to && (!best || u.to - u.from <= best.to - best.from)) best = u;
  }
  return best;
}
