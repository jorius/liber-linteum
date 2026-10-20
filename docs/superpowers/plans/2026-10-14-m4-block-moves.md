# M4 — Block moves (drag-and-drop reordering) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize a page by moving whole blocks — headings with their sections, paragraphs, lists and list items (across levels), quotes, callouts, code, table rows, embeds, HTML, columns and rules — by dragging in the Split pane or from the keyboard, each move one undo step that never changes a block's text.

**Architecture:** A pure block model (`markdown/blockModel.ts`) lists movable units and their drop slots; a pure rewriter (`markdown/blockMoves.ts`) turns a unit and a slot into source edits, guarded by a windowed re-parse that refuses any move that would change a block. The editor applies a move as one isolated CodeMirror transaction (`features/editor/blockCommands.ts`, plus Alt+↑/↓); the Split pane gets a gutter (`BlockGutter.tsx`) with a grip, Move up/down, Indent/Outdent, keyboard moves, a keyboard pick-up and a pointer drag.

**Tech Stack:** React 19 + TS, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`), unified/remark (mdast), Vitest (jsdom), Playwright (Chromium + WebKit). No new dependency; no Rust change.

**Spec:** `docs/superpowers/specs/2026-10-14-m4-block-moves-design.md` (§10 records this plan's amendments).

**How this plan was made:** every step below was run, in order, on a scratch clone of `feat/m4-block-moves` (`afc11b9`); each task's code blocks are the code that ran, taken from that task's commit, and every `Expected:` is the output observed. Tasks 9 and 11–14 are what the replay itself found (an e2e failure, the Safari floor, and the Review Focus pins).

## Global Constraints

- No network from the app (P1, NFR-04); the zero-network e2e covers block moves.
- A move never changes a block's text: only blank lines between blocks, a list item's indentation and number (and its marker, to fit the list it joins) change; a re-parse guard refuses anything else with "This block can't be moved here."
- One move = one undo step (`isolateHistory`), `userEvent: 'move.block'`; the moved block keeps the keyboard.
- Keyboard parity for every pointer action (DND-08); focus never lands on `<body>`; axe-clean in jsdom and in both engines, light and dark.
- i18n en + es parity (`pnpm check:i18n`), ICU syntax like the existing strings.
- Safari 15 floor: no regex lookbehind, no `color-mix()`, no `structuredClone`, no `Array.prototype.at` in new code.
- Typing latency unaffected: the pane's 150 ms render delay stays for typing (it drops to 0 only after a block move).
- Vitest with `--maxWorkers=2`; Node 24 first on PATH; Playwright browsers via `PLAYWRIGHT_BROWSERS_PATH`.

## Review Focus

1. **Setext headings, `)` and 0-based ordered lists, task lists** — moved like any other block, numbering and markers kept right. Pinned in Task 14: `blockMoves.sweep.test.ts` › `variants`.
2. **A large note** — after the first, a move in a 200 KB note takes well under 100 ms. Pinned in Task 12: `blockCommands.test.ts` › "after the first, Alt+↑ in a 200 KB note…".
3. **An embedded note in the pane** — its blocks carry the other note's offsets and must never get gutters or be moved as this page's. Pinned in Task 13: `BlockGutter.test.tsx` › "review focus: blocks of an embedded note get no gutter…".
4. **A move the guard refuses, from the gutter** — nothing changes, and the toast says why. Pinned in Task 13: "review focus: a move the guard refuses changes nothing and says why".
5. **A drag in a scrolled pane** — near the top edge the pane scrolls up, and the block lands where the line shows; no block is lost. Pinned in Task 14: `m4.spec.ts` › "review focus: in a scrolled pane…".

## File Structure

| Path | Responsibility |
|---|---|
| `apps/desktop/src/markdown/blockModel.ts` | units, sections, lists, rows; slots; Move up/down and indent neighbours |
| `apps/desktop/src/markdown/blockMoves.ts` | source edits for a move; list/row rewriting; the windowed guard |
| `apps/desktop/src/markdown/sanitize.ts` | HTML blocks wrapped with their source range |
| `apps/desktop/src/features/editor/blockCommands.ts` | model cache, `applyMove`, Alt+↑/↓ |
| `apps/desktop/src/features/editor/BlockGutter.tsx`, `BlockGutter.module.css` | the Split gutter, keyboard, pick-up, pointer drag, live region |
| `apps/desktop/src/features/editor/SplitHint.tsx` | the one-time hint |
| `apps/desktop/src/features/editor/{Editor.tsx,Editor.module.css,format.ts,livePreview.ts}` | wiring; pane render after moves; keymap; HTML-wrapper aware check |
| `apps/desktop/src/features/preview/Preview.tsx` | `onRendered`, `delay`, `data-note-embed` |
| `apps/desktop/src/i18n/locales/{en,es}.json` | `editor.blocks.*` |
| `apps/desktop/e2e/{m4.spec,zero-network.spec}.ts`, `playwright.config.ts` | end to end |

**Commands used throughout (repo root):** `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`; Vitest `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 <paths>`; E2E `pnpm --filter @liber/desktop exec vite build` then `PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test <spec>`.

---

### Task 1: The movable-block model: units, heading sections, lists, table rows, slots

Spec §2.

**Files:**
- Create: `apps/desktop/src/markdown/blockModel.test.ts`
- Create: `apps/desktop/src/markdown/blockModel.ts`

**Interfaces:**
- Consumes: `ParsedPage` (`parsePage`).
- Produces: `markdown/blockModel.ts`: `UnitKind`, `Unit { id, kind, from, to, scope: "top"|"item"|"row", container, depth, level?, sectionTo?, list? }`, `ListInfo { from, to, depth, ordered, marker, items, parentItem, top }`, `TableInfo { unit, rows }`, `BlockModel { units, lists, tables, contentStart }`, `Slot` (`{scope:"top",before}` | `{scope:"item",list,before}` | `{scope:"child",of}` | `{scope:"row",table,before}`), `movableBlocks(text, page)`, `topUnits`, `spanOf(unit, lineOnly)`, `slotsFor(model, unit, lineOnly)`, `slotAt`, `sameSlot`, `neighbourSlot(model, unit, dir, lineOnly)`, `indentSlot(model, unit, dir)`, `unitAt(model, pos)`, `ITEM_LINE`; `kindOf` (exported in Task 2).

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/markdown/blockModel.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import {
  indentSlot,
  movableBlocks,
  neighbourSlot,
  slotsFor,
  spanOf,
  unitAt,
  type BlockModel,
  type Unit,
} from './blockModel';
import { parsePage } from './parse';

const model = (text: string): BlockModel => movableBlocks(text, parsePage(text));
/** The deepest unit starting on the line where `start` first appears. */
const named = (m: BlockModel, text: string, start: string): Unit => {
  const line = text.lastIndexOf('\n', text.indexOf(start) - 1) + 1;
  const found = m.units
    .filter((x) => x.from === line)
    .sort((x, y) => x.to - x.from - (y.to - y.from))[0];
  if (!found) throw new Error(`no unit for ${start}`);
  return found;
};
const show = (m: BlockModel, text: string) =>
  m.units.map(
    (u) =>
      `${u.scope}:${u.kind}${u.depth ? `@${u.depth}` : ''} ${JSON.stringify(text.slice(u.from, u.to))}`,
  );

describe('movableBlocks (M4 §2)', () => {
  it('lists top-level blocks, list items at every depth and table body rows, never the front matter', () => {
    const text = [
      '---',
      'a: 1',
      '---',
      '# Title',
      '',
      'Para one.',
      '',
      '- a',
      '- b',
      '  - b1',
      '',
      '| h | i |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '![[img.png]]',
      '',
      '> [!note] Call',
      '> body',
      '',
      '---',
      '',
    ].join('\n');
    const m = model(text);
    expect(show(m, text)).toEqual([
      'top:heading "# Title"',
      'top:paragraph "Para one."',
      'top:list "- a\\n- b\\n  - b1"',
      'item:listItem "- a"',
      'item:listItem "- b\\n  - b1"',
      'item:listItem@1 "  - b1"',
      'top:table "| h | i |\\n|---|---|\\n| 1 | 2 |"',
      'row:tableRow "| 1 | 2 |"',
      'top:embed "![[img.png]]"',
      'top:callout "> [!note] Call\\n> body"',
      'top:rule "---"',
    ]);
    expect(m.contentStart).toBe(text.indexOf('# Title'));
    expect(m.lists.map((l) => [l.depth, l.items.length, l.parentItem])).toEqual([
      [0, 2, null],
      [1, 1, named(m, text, '- b').id],
    ]);
  });

  it('DND-07: a heading section runs to the next heading of the same or a higher level', () => {
    const text = '# A\n\npa\n\n## B\n\npb\n\n## C\n\npc\n\n# D\n\npd\n';
    const m = model(text);
    const end = (h: string) => text.slice(0, spanOf(named(m, text, h))[1]);
    expect(end('# A')).toBe('# A\n\npa\n\n## B\n\npb\n\n## C\n\npc');
    expect(end('## B')).toBe('# A\n\npa\n\n## B\n\npb');
    expect(text.slice(...spanOf(named(m, text, '## B'), true))).toBe('## B');
  });
});

describe('slots (M4 §2)', () => {
  const text = 'P1\n\nP2\n\n- a\n- b\n  - b1\n- c\n\n| h |\n|---|\n| 1 |\n| 2 |\n\nP3\n';
  const m = model(text);

  it('a top-level block lands before any other top-level block or at the end, never where it is', () => {
    expect(slotsFor(m, named(m, text, 'P2'))).toEqual([
      { scope: 'top', before: named(m, text, 'P1').id },
      { scope: 'top', before: named(m, text, '| h |').id },
      { scope: 'top', before: named(m, text, 'P3').id },
      { scope: 'top', before: null },
    ]);
  });

  it('a list item lands in any list, nested under an item, or at the top as its own list', () => {
    const slots = slotsFor(m, named(m, text, '- c'));
    expect(slots).toContainEqual({ scope: 'item', list: 0, before: named(m, text, '- a').id });
    expect(slots).toContainEqual({ scope: 'item', list: 1, before: null });
    expect(slots).toContainEqual({ scope: 'child', of: named(m, text, '- a').id });
    expect(slots).toContainEqual({ scope: 'top', before: named(m, text, 'P1').id });
    // Not where it is, and not into its own nested items.
    expect(slots).not.toContainEqual({ scope: 'item', list: 0, before: null });
  });

  it('two lists with the same marker never end up side by side (they would merge)', () => {
    const slots = slotsFor(m, named(m, text, '- c'));
    const list = m.units.find((u) => u.kind === 'list')!;
    // Just before the `-` list, or just after it, the new list would join it.
    expect(slots).not.toContainEqual({ scope: 'top', before: list.id });
    expect(slots).not.toContainEqual({ scope: 'top', before: named(m, text, '| h |').id });
    expect(slots).toContainEqual({ scope: 'top', before: named(m, text, 'P3').id });
  });

  it('a table row stays in its table body', () => {
    expect(slotsFor(m, named(m, text, '| 2 |'))).toEqual([
      { scope: 'row', table: 0, before: named(m, text, '| 1 |').id },
    ]);
  });

  it('a heading section never lands inside itself', () => {
    const t = '# A\n\npa\n\n## B\n\npb\n\n# C\n';
    const mm = model(t);
    const slots = slotsFor(mm, named(mm, t, '# A'));
    expect(slots).toEqual([{ scope: 'top', before: null }]);
    // Line only (Alt): anywhere but where it is.
    expect(slotsFor(mm, named(mm, t, '# A'), true).length).toBe(4);
  });
});

describe('keyboard neighbours (M4 §5)', () => {
  it('Move up / down: one slot; a section passes the neighbouring section of its level', () => {
    const t = '# A\n\npa\n\n## B\n\npb\n\n## C\n\npc\n';
    const m = model(t);
    const c = named(m, t, '## C');
    expect(neighbourSlot(m, c, -1)).toEqual({ scope: 'top', before: named(m, t, '## B').id });
    expect(neighbourSlot(m, named(m, t, '## B'), 1)).toEqual({ scope: 'top', before: null });
    expect(neighbourSlot(m, named(m, t, 'pa'), -1)).toEqual({
      scope: 'top',
      before: named(m, t, '# A').id,
    });
    expect(neighbourSlot(m, named(m, t, '# A'), -1)).toBeNull();
  });

  it('list items move among their siblings, indent under the previous one, outdent after their parent', () => {
    const t = '- a\n- b\n  - b1\n  - b2\n- c\n';
    const m = model(t);
    const b2 = named(m, t, '  - b2');
    expect(neighbourSlot(m, b2, -1)).toEqual({
      scope: 'item',
      list: 1,
      before: named(m, t, '  - b1').id,
    });
    expect(neighbourSlot(m, b2, 1)).toBeNull();
    expect(indentSlot(m, b2, 1)).toEqual({ scope: 'child', of: named(m, t, '  - b1').id });
    expect(indentSlot(m, b2, -1)).toEqual({
      scope: 'item',
      list: 0,
      before: named(m, t, '- c').id,
    });
    expect(indentSlot(m, named(m, t, '- c'), 1)).toEqual({ scope: 'item', list: 1, before: null });
    expect(indentSlot(m, named(m, t, '- a'), -1)).toBeNull();
  });

  it('unitAt finds the deepest unit at a position', () => {
    const t = '- a\n- b\n  - b1\n';
    const m = model(t);
    expect(t.slice(unitAt(m, t.indexOf('b1'))!.from, unitAt(m, t.indexOf('b1'))!.to)).toBe(
      '  - b1',
    );
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown/blockModel.test.ts`
Expected: FAIL — `Failed to resolve import "./blockModel"`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/markdown/blockModel.ts`:

````ts
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
````

Note: The tests name units by the line they start on and take the deepest one (an item before its list).

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown/blockModel.test.ts`
Expected: PASS — `Tests  10 passed (10)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/blockModel.test.ts apps/desktop/src/markdown/blockModel.ts
git commit -F - <<'MSG'
feat(markdown): the movable-block model — units, heading sections, lists, table rows and drop slots (M4 §2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Moving a top-level block or a heading section; the windowed re-parse guard

Spec §3, §6 (amendment 1).

**Files:**
- Modify: `apps/desktop/src/markdown/blockModel.ts`
- Create: `apps/desktop/src/markdown/blockMoves.test.ts`
- Create: `apps/desktop/src/markdown/blockMoves.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `markdown/blockMoves.ts`: `Move { changes: TextChange[]; at }`, `MoveResult = Move | { refused: true } | null`, `MoveOptions { lineOnly? }`, `moveBlock(text, model, unit, slot, options)`, `applyChanges(text, changes)`; `blockModel.kindOf` exported.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/markdown/blockMoves.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { movableBlocks, type BlockModel, type Slot, type Unit } from './blockModel';
import { applyChanges, moveBlock } from './blockMoves';
import { parsePage } from './parse';

const model = (text: string): BlockModel => movableBlocks(text, parsePage(text));
/** The deepest unit starting on the line where `start` first appears
 *  (`top:…`: the top-level one). */
const named = (m: BlockModel, text: string, start: string): Unit => {
  const top = start.startsWith('top:');
  const s = top ? start.slice(4) : start;
  const line = text.lastIndexOf('\n', text.indexOf(s) - 1) + 1;
  const found = m.units
    .filter((x) => x.from === line && (!top || x.scope === 'top'))
    .sort((x, y) => x.to - x.from - (y.to - y.from))[0];
  if (!found) throw new Error(`no unit for ${start}`);
  return found;
};
/** Moves the unit starting with `what` before the unit starting with `before` (or to the end). */
function move(
  text: string,
  what: string,
  before: string | null,
  lineOnly = false,
): string | 'refused' | null {
  const m = model(text);
  const slot: Slot = { scope: 'top', before: before === null ? null : named(m, text, before).id };
  const r = moveBlock(text, m, named(m, text, what), slot, { lineOnly });
  if (!r) return null;
  if ('refused' in r) return 'refused';
  const out = applyChanges(text, r.changes);
  const u = named(m, text, what);
  expect(out.slice(r.at).startsWith(text.slice(u.from, u.to).split(/\r?\n/)[0])).toBe(true);
  return out;
}

describe('moving top-level blocks (M4 §3)', () => {
  it('acceptance: P3 dropped above P1 reads P3, P1, P2, every byte of each paragraph unchanged', () => {
    expect(move('P1 *one*\n\nP2 `two`\n\nP3 [[three]]\n', 'P3', 'P1')).toBe(
      'P3 [[three]]\n\nP1 *one*\n\nP2 `two`\n',
    );
  });

  it('acceptance: a heading takes its section along (DND-07)', () => {
    const text = '## A\n\nA1\n\nA2\n\n## B\n\nB1\n';
    expect(move(text, '## A', null)).toBe('## B\n\nB1\n\n## A\n\nA1\n\nA2\n');
  });

  it('Alt moves the heading line alone', () => {
    const text = '## A\n\nA1\n\nA2\n\n## B\n\nB1\n';
    expect(move(text, '## A', null, true)).toBe('A1\n\nA2\n\n## B\n\nB1\n\n## A\n');
  });

  it('keeps CRLF line endings', () => {
    expect(move('P1\r\n\r\nP2\r\n\r\nP3\r\n', 'P3', 'P1')).toBe('P3\r\n\r\nP1\r\n\r\nP2\r\n');
  });

  it('never moves anything above the front matter', () => {
    expect(move('---\na: 1\n---\nP1\n\nP2\n', 'P2', 'P1')).toBe('---\na: 1\n---\nP2\n\nP1\n');
  });

  it('blocks that touched their neighbours keep them apart (no two paragraphs merge)', () => {
    expect(move('# H\nPara\n```\ncode\n```\nTail\n', '```', '# H')).toBe(
      '```\ncode\n```\n\n# H\nPara\n\nTail\n',
    );
    expect(move('Para\n- a\n- b\n', 'top:- a', 'Para')).toBe('- a\n- b\n\nPara\n');
  });

  it('a %% comment between blocks is never deleted', () => {
    expect(move('P1\n\n%% note %%\n\nP2\n', 'P2', 'P1')).toBe('P2\n\nP1\n\n%% note %%\n\n');
  });

  it('the guard refuses a move that would change a block (indented code swallowed by a list)', () => {
    expect(move('- a\n\nPara\n\n    code\n', '    code', 'Para')).toBe('refused');
  });

  it('the guard refuses a move after which two lists would merge', () => {
    expect(move('- a\n\nPara\n\n- b\n', 'Para', null)).toBe('refused');
  });

  it('a slot that leaves the block where it is gives nothing', () => {
    expect(move('P1\n\nP2\n', 'P1', 'P2')).toBeNull();
    expect(move('P1\n\nP2\n', 'P2', null)).toBeNull();
  });
});

describe('a large note (M4 §6)', () => {
  it('a move in a 200 KB note, guard included, takes well under 100 ms', () => {
    const para = (i: number) =>
      `Paragraph ${i} with **bold**, a [[link ${i}]] and #tag text that goes on for a while.\n\n- item ${i}\n- another\n\n`;
    let text = '';
    for (let i = 0; text.length < 200_000; i++) text += para(i);
    const m = model(text);
    const units = m.units.filter((u) => u.scope === 'top');
    const first = units[0];
    const last = units[units.length - 1];
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      const r = moveBlock(text, m, first, { scope: 'top', before: last.id });
      times.push(performance.now() - t);
      expect(r && 'changes' in r).toBe(true);
    }
    expect(Math.min(...times)).toBeLessThan(100);
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown/blockMoves.test.ts`
Expected: FAIL — `Failed to resolve import "./blockMoves"`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/markdown/blockModel.ts` (apply this change):

````diff
@@ -100,7 +100,7 @@ function isLoneEmbed(p: Paragraph): boolean {
   return kids.length === 1 && (kids[0].type === ('embed' as string) || kids[0].type === 'image');
 }
 
-function kindOf(node: RootContent): UnitKind {
+export function kindOf(node: RootContent): UnitKind {
   switch (node.type as string) {
     case 'heading':
       return 'heading';
````

Create `apps/desktop/src/markdown/blockMoves.ts`:

````ts
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
````

Note: A full `parsePage` of 200 KB takes ~450 ms in jsdom — far over §6's 100 ms — hence windows: the top-level blocks each edit touches plus one on each side, before and after.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown`
Expected: PASS — `blockMoves.test.ts` 11 passed (the 200 KB case: move + guard ~2.5 ms, first run ~12 ms); `Tests  146 passed (146)` in `src/markdown`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/blockModel.ts apps/desktop/src/markdown/blockMoves.test.ts apps/desktop/src/markdown/blockMoves.ts
git commit -F - <<'MSG'
feat(markdown): move a top-level block or a heading section, guarded by a windowed re-parse (M4 §3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 3: Moving list items between levels and lists; table rows within their table

Spec §3 (amendment 2).

**Files:**
- Create: `apps/desktop/src/markdown/blockMoves.lists.test.ts`
- Modify: `apps/desktop/src/markdown/blockMoves.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `moveBlock` handles `scope: "item"` units (to item, child and top slots) and `scope: "row"` units; the guard takes a top-level-list delta.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/markdown/blockMoves.lists.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { movableBlocks, type BlockModel, type Slot, type Unit } from './blockModel';
import { applyChanges, moveBlock } from './blockMoves';
import { parsePage } from './parse';

const model = (text: string): BlockModel => movableBlocks(text, parsePage(text));
/** The deepest unit starting on the line where `start` first appears. */
const named = (m: BlockModel, text: string, start: string): Unit => {
  const line = text.lastIndexOf('\n', text.indexOf(start) - 1) + 1;
  // A one-item list and its item share a range: the item is the deeper one.
  const found = m.units
    .filter((x) => x.from === line)
    .sort(
      (x, y) =>
        x.to - x.from - (y.to - y.from) || Number(x.scope === 'top') - Number(y.scope === 'top'),
    )[0];
  if (!found) throw new Error(`no unit for ${start}`);
  return found;
};
type Where =
  | { before: string }
  | { end: string } /* the list holding this item */
  | { child: string }
  | { top: string | null }
  | { row: string | null };
function move(text: string, what: string, where: Where): string | 'refused' | null {
  const m = model(text);
  const u = named(m, text, what);
  let slot: Slot;
  if ('before' in where) {
    const s = named(m, text, where.before);
    slot =
      s.scope === 'row'
        ? { scope: 'row', table: s.container!, before: s.id }
        : { scope: 'item', list: s.container!, before: s.id };
  } else if ('end' in where)
    slot = { scope: 'item', list: named(m, text, where.end).container!, before: null };
  else if ('child' in where) slot = { scope: 'child', of: named(m, text, where.child).id };
  else if ('top' in where)
    slot = {
      scope: 'top',
      before:
        where.top === null
          ? null
          : m.units.find((x) => x.scope === 'top' && x.from === named(m, text, where.top!).from)!
              .id,
    };
  else
    slot = {
      scope: 'row',
      table: u.container!,
      before: where.row === null ? null : named(m, text, where.row).id,
    };
  const r = moveBlock(text, m, u, slot);
  if (!r) return null;
  if ('refused' in r) return 'refused';
  const out = applyChanges(text, r.changes);
  expect(out.slice(r.at)).toMatch(/^[ \t]*(?:[-*+]|\d+[.)]|\|)/);
  return out;
}

describe('moving list items (M4 §3)', () => {
  it('reorders items in their list', () => {
    expect(move('- a\n- b\n- c\n', '- c', { before: '- a' })).toBe('- c\n- a\n- b\n');
  });

  it('renumbers an ordered list it moves within', () => {
    expect(move('1. a\n2. b\n3. c\n', '3. c', { before: '1. a' })).toBe('1. c\n2. a\n3. b\n');
  });

  it('keeps a list numbered with the same number that way', () => {
    expect(move('1. a\n1. b\n1. c\n', '1. c', { before: '1. a' })).toBe('1. c\n1. a\n1. b\n');
  });

  it('nests under an item by its marker width; a new nested ordered list starts at 1 (M2b rule)', () => {
    expect(move('- a\n- b\n', '- b', { child: '- a' })).toBe('- a\n  - b\n');
    expect(move('1. a\n2. b\n3. c\n', '3. c', { child: '1. a' })).toBe('1. a\n   1. c\n2. b\n');
  });

  it('moves out of a nested list to a shallower level', () => {
    expect(move('- a\n  - a1\n  - a2\n- b\n', '  - a1', { before: '- b' })).toBe(
      '- a\n  - a2\n- a1\n- b\n',
    );
  });

  it('takes its nested items along, re-indented', () => {
    expect(move('- a\n  - a1\n- b\n', '- a', { child: '- b' })).toBe('- b\n  - a\n    - a1\n');
  });

  it('takes the marker of the list it joins; checkboxes stay', () => {
    expect(move('- a\n- [x] b\n\n1. x\n2. y\n', '- [x] b', { before: '2. y' })).toBe(
      '- a\n\n1. x\n2. [x] b\n3. y\n',
    );
    expect(move('- [ ] a\n- [x] b\n', '- [x] b', { before: '- [ ] a' })).toBe('- [x] b\n- [ ] a\n');
  });

  it('dropped among top-level blocks, an item becomes a one-item list', () => {
    expect(move('- a\n- b\n\nP\n', '- b', { top: null })).toBe('- a\n\nP\n\n- b\n');
  });

  it('a list left empty disappears with its blank lines', () => {
    expect(move('- a\n\nP\n\n* x\n', '- a', { before: '* x' })).toBe('P\n\n* a\n* x\n');
  });

  it('a loose list keeps its blank lines', () => {
    expect(move('- a\n\n- b\n\n- c\n', '- c', { before: '- a' })).toBe('- c\n\n- a\n\n- b\n');
  });

  it('renumbering past 9 keeps nested items nested', () => {
    const items = 'abcdefghi'.split('').map((c, k) => `${k + 1}. ${c}`);
    const text = `${items.join('\n')}\n   - child\n10. j\n`;
    const out = move(text, '10. j', { before: '1. a' }) as string;
    expect(out.startsWith('1. j\n2. a\n')).toBe(true);
    expect(out).toContain('10. i\n    - child\n');
    expect(parsePage(out).tree.children).toHaveLength(1);
  });

  it('keeps CRLF', () => {
    expect(move('- a\r\n- b\r\n', '- b', { before: '- a' })).toBe('- b\r\n- a\r\n');
  });
});

describe('moving table rows (M4 §3)', () => {
  const table = '| h |\n|---|\n| 1 |\n| 2 |\n| 3 |\n';
  it('reorders body rows; the header row is never a unit', () => {
    expect(move(table, '| 3 |', { row: '| 1 |' })).toBe('| h |\n|---|\n| 3 |\n| 1 |\n| 2 |\n');
    expect(move(table, '| 1 |', { row: null })).toBe('| h |\n|---|\n| 2 |\n| 3 |\n| 1 |\n');
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown/blockMoves.lists.test.ts`
Expected: FAIL — `Tests  13 failed (13)` (`moveBlock` gives `null` for items and rows: `expected null to be '- c\n- a\n- b\n'`).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/markdown/blockMoves.ts` (apply this change):

````diff
@@ -2,6 +2,7 @@
 // refuses any move whose result wouldn't hold the same blocks.
 import type { Node, Parent, RootContent } from 'mdast';
 import {
+  ITEM_LINE,
   kindOf,
   slotsFor,
   sameSlot,
@@ -63,57 +64,342 @@ function blankBefore(text: string, pos: number, contentStart: number): boolean {
   return pos <= contentStart || /\n[ \t]*\r?\n$/.test(text.slice(Math.max(0, pos - 256), pos));
 }
 
-/** A top-level block (or section) moved before `before`, or to the end. */
-function topMove(
-  text: string,
-  model: BlockModel,
-  unit: Unit,
-  before: Unit | null,
-  lineOnly: boolean,
-): Move {
+/** Taking the top-level span [from, to) out: the blank lines around it go
+ *  too, and its neighbours keep one blank line between them. Anything that
+ *  isn't a block next to it (a %% comment) stays: only the span's own lines
+ *  go then. */
+function topDeletion(text: string, model: BlockModel, from: number, to: number): TextChange {
   const eol = eolOf(text);
-  const [from, to] = spanOf(unit, lineOnly);
   const tops = topUnits(model);
   const prev = [...tops].reverse().find((u) => u.to <= from && u.from < from);
   const next = tops.find((u) => u.from >= to && u.from > from);
-  const chunk = text.slice(from, to);
-
-  // Take it out: the blank lines around it go too, and its neighbours keep
-  // one blank line between them. Anything that isn't a block next to it (a
-  // %% comment) stays: only the block's own lines go then.
   const gapBefore = text.slice(prev ? prev.to : model.contentStart, from);
   const gapAfter = text.slice(to, next ? next.from : text.length);
-  let del: TextChange;
   if (/\S/.test(gapBefore) || /\S/.test(gapAfter)) {
     const end = text.startsWith('\r\n', to) ? to + 2 : text[to] === '\n' ? to + 1 : to;
-    del = { from, to: end, insert: '' };
-  } else if (prev && next) {
-    del = { from: prev.to, to: next.from, insert: eol + eol };
-  } else if (next) {
-    del = { from, to: next.from, insert: '' };
-  } else if (prev) {
-    del = { from: prev.to, to, insert: '' };
-  } else {
-    del = { from, to, insert: '' };
+    return { from, to: end, insert: '' };
   }
+  if (prev && next) return { from: prev.to, to: next.from, insert: eol + eol };
+  if (next) return { from, to: next.from, insert: '' };
+  if (prev) return { from: prev.to, to, insert: '' };
+  return { from, to, insert: '' };
+}
 
-  // Put it in, with a blank line on each side.
-  let ins: TextChange;
-  let lead: number;
+/** Putting `chunk` among the top-level blocks, before `before` or at the
+ *  end, with a blank line on each side; `lead` is what comes before it. */
+function topInsertion(
+  text: string,
+  model: BlockModel,
+  before: Unit | null,
+  chunk: string,
+): { change: TextChange; lead: number } {
+  const eol = eolOf(text);
   if (before) {
     const prefix = blankBefore(text, before.from, model.contentStart) ? '' : eol;
-    lead = prefix.length;
-    ins = { from: before.from, to: before.from, insert: prefix + chunk + eol + eol };
-  } else {
-    const endsEol = /\n$/.test(text);
-    const prefix = endsEol ? eol : eol + eol;
-    lead = prefix.length;
-    ins = { from: text.length, to: text.length, insert: prefix + chunk + (endsEol ? eol : '') };
+    return {
+      change: { from: before.from, to: before.from, insert: prefix + chunk + eol + eol },
+      lead: prefix.length,
+    };
   }
-  const changes = ins.from <= del.from ? [ins, del] : [del, ins];
+  const endsEol = /\n$/.test(text);
+  const prefix = endsEol ? eol : eol + eol;
+  return {
+    change: { from: text.length, to: text.length, insert: prefix + chunk + (endsEol ? eol : '') },
+    lead: prefix.length,
+  };
+}
+
+/** Insertions before replacements at the same place. */
+const sorted = (changes: TextChange[]) =>
+  [...changes].sort((a, b) => a.from - b.from || a.to - a.from - (b.to - b.from));
+
+/** A top-level block (or section) moved before `before`, or to the end. */
+function topMove(
+  text: string,
+  model: BlockModel,
+  unit: Unit,
+  before: Unit | null,
+  lineOnly: boolean,
+): Move {
+  const [from, to] = spanOf(unit, lineOnly);
+  const del = topDeletion(text, model, from, to);
+  const { change: ins, lead } = topInsertion(text, model, before, text.slice(from, to));
+  const changes = sorted([ins, del]);
   return { changes, at: mapPos(changes, ins.from, -1) + lead };
 }
 
+// ---- list items and table rows (line by line inside their top-level block) --
+
+/** Leading whitespace in columns (a tab to the next multiple of 4). */
+function leadCols(line: string): number {
+  let c = 0;
+  for (const ch of line) {
+    if (ch === ' ') c++;
+    else if (ch === '\t') c += 4 - (c % 4);
+    else break;
+  }
+  return c;
+}
+
+/** `line` without its first `n` columns of leading whitespace. */
+function stripCols(line: string, n: number): string {
+  let c = 0;
+  let i = 0;
+  while (i < line.length && c < n && (line[i] === ' ' || line[i] === '\t')) {
+    c = line[i] === '\t' ? c + 4 - (c % 4) : c + 1;
+    i++;
+  }
+  return ' '.repeat(Math.max(0, c - n)) + line.slice(i);
+}
+
+/** Where an item's content starts — and where its children must start
+ *  (CommonMark; M2b I2): `- ` → 2, `1. ` → 3, `10. ` → 4. */
+function contentCol(line: string): number {
+  const m = ITEM_LINE.exec(line)!;
+  const gap = m[5].length;
+  return leadCols(m[1]) + m[2].length + (gap >= 1 && gap <= 4 ? gap : 1);
+}
+
+/** Gives the item at lines [s, e] the marker `marker`; when the marker's
+ *  width changes, its other lines (nested items included) shift with it. */
+function setMarker(lines: string[], s: number, e: number, marker: string) {
+  const m = ITEM_LINE.exec(lines[s]);
+  if (!m || m[2] === marker) return;
+  const before = contentCol(lines[s]);
+  lines[s] = m[1] + marker + lines[s].slice(m[1].length + m[2].length);
+  const d = contentCol(lines[s]) - before;
+  if (!d) return;
+  for (let k = s + 1; k <= e; k++) {
+    if (!lines[k].trim()) continue;
+    lines[k] = d > 0 ? ' '.repeat(d) + lines[k] : stripCols(lines[k], -d);
+  }
+}
+
+/** Where line `k` of `lines` starts once they're joined with `eol`. */
+const offsetOf = (lines: string[], k: number, eol: string) =>
+  lines.slice(0, k).reduce((n, l) => n + l.length + eol.length, 0);
+
+/** The lines of a top-level block with `removed` taken out and `ins` put
+ *  before original line `insertAt`; `map` gives each kept line's new index. */
+function rebuild(
+  lines: string[],
+  removed: [number, number] | null,
+  insertAt: number | null,
+  ins: string[],
+) {
+  const out: string[] = [];
+  const map: number[] = [];
+  let insAt = -1;
+  for (let i = 0; i <= lines.length; i++) {
+    if (i === insertAt) {
+      insAt = out.length;
+      out.push(...ins);
+    }
+    if (i === lines.length) break;
+    if (removed && i >= removed[0] && i <= removed[1]) {
+      map[i] = -1;
+      continue;
+    }
+    map[i] = out.length;
+    out.push(lines[i]);
+  }
+  return { out, map, insAt };
+}
+
+/** The numbers an ordered list's items get after a move, given its numbers
+ *  before (`original`) and each item's own number in the new order
+ *  (`current`): a sequential list stays sequential, an all-the-same list
+ *  stays the same, any other keeps every item's own number. */
+function numbersFor(original: number[], current: number[]): number[] {
+  const start = original.length ? original[0] : 1;
+  if (original.every((n, k) => n === start + k)) return current.map((_, k) => start + k);
+  if (original.every((n) => n === start)) return current.map(() => start);
+  return current;
+}
+
+/** A list item moved to `slot` (M4 §3). */
+function itemMove(
+  text: string,
+  model: BlockModel,
+  unit: Unit,
+  slot: Slot,
+): { move: Move; topDelta: number } | null {
+  const eol = eolOf(text);
+  const list = model.lists[unit.container!];
+  const srcTop = model.units[list.top];
+  const alone = list.depth === 0 && list.items.length === 1;
+  if (alone && slot.scope === 'top') {
+    return {
+      move: topMove(
+        text,
+        model,
+        srcTop,
+        slot.before === null ? null : model.units[slot.before],
+        false,
+      ),
+      topDelta: 0,
+    };
+  }
+  const linesOf = (u: Unit) => text.slice(u.from, u.to).split(/\r?\n/);
+  const lineIn = (region: Unit, pos: number) => text.slice(region.from, pos).split('\n').length - 1;
+  const spanIn = (region: Unit, id: number): [number, number] => [
+    lineIn(region, model.units[id].from),
+    lineIn(region, model.units[id].to),
+  ];
+  const lineText = (pos: number) =>
+    text
+      .slice(pos, text.indexOf('\n', pos) < 0 ? text.length : text.indexOf('\n', pos))
+      .replace(/\r$/, '');
+  const numberOf = (id: number) => Number(ITEM_LINE.exec(lineText(model.units[id].from))?.[3] ?? 1);
+
+  // The item's lines, and what goes with taking them out.
+  const srcLines = linesOf(srcTop);
+  const [s, e] = spanIn(srcTop, unit.id);
+  const idx = list.items.indexOf(unit.id);
+  let removed: [number, number];
+  if (idx < list.items.length - 1) removed = [s, spanIn(srcTop, list.items[idx + 1])[0] - 1];
+  else if (idx > 0) removed = [spanIn(srcTop, list.items[idx - 1])[1] + 1, e];
+  else {
+    let k = s;
+    while (k > 0 && !srcLines[k - 1].trim()) k--;
+    removed = [k, e];
+  }
+
+  // Where it goes, how indented, with which marker.
+  const own = ITEM_LINE.exec(srcLines[s])!;
+  let target: Unit | null = null;
+  let insertAt = 0;
+  let indent = '';
+  let marker = own[2];
+  let into: number | null = null; // the list it joins
+  let loose = false;
+  const looseList = (l: number) =>
+    model.lists[l].items.some((id, k) => {
+      if (k === 0) return false;
+      const at = model.units[id].from;
+      return /\n[ \t]*\r?\n$/.test(text.slice(Math.max(0, at - 64), at));
+    });
+  if (slot.scope === 'item') {
+    const l = model.lists[slot.list];
+    target = model.units[l.top];
+    into = slot.list;
+    loose = looseList(slot.list);
+    const ref = slot.before ?? l.items.filter((id) => id !== unit.id).at(-1)!;
+    indent = /^[ \t]*/.exec(lineText(model.units[ref].from))![0];
+    insertAt = slot.before !== null ? spanIn(target, slot.before)[0] : spanIn(target, ref)[1] + 1;
+    marker = l.ordered ? `1${l.marker}` : l.marker;
+  } else if (slot.scope === 'child') {
+    const p = model.units[slot.of];
+    target = model.units[model.lists[p.container!].top];
+    indent = ' '.repeat(contentCol(lineText(p.from)));
+    insertAt = spanIn(target, p.id)[1] + 1;
+    if (own[3]) marker = `1${own[4]}`;
+  }
+  const chunk = srcLines
+    .slice(s, e + 1)
+    .map((l) => (l.trim() ? indent + stripCols(l, leadCols(srcLines[s])) : ''));
+  setMarker(chunk, 0, chunk.length - 1, marker);
+  const ins =
+    slot.scope === 'item' && loose
+      ? slot.before !== null
+        ? [...chunk, '']
+        : ['', ...chunk]
+      : chunk;
+
+  // Renumbers an ordered list in the rebuilt lines.
+  const renumber = (
+    out: string[],
+    map: number[],
+    region: Unit,
+    l: number,
+    insAt: number | null,
+  ) => {
+    const info = model.lists[l];
+    if (!info.ordered) return;
+    const items = info.items
+      .filter((id) => id !== unit.id)
+      .map((id) => ({
+        span: spanIn(region, id).map((i) => map[i]) as [number, number],
+        own: numberOf(id),
+      }));
+    if (insAt !== null && l === into) {
+      const first = insAt + (ins[0] === '' ? 1 : 0);
+      items.push({ span: [first, first + chunk.length - 1], own: own[3] ? Number(own[3]) : NaN });
+    }
+    items.sort((a, b) => a.span[0] - b.span[0]);
+    const original = info.items.map(numberOf);
+    const nums = numbersFor(
+      original,
+      items.map((it, k) =>
+        Number.isNaN(it.own) ? (items[k - 1]?.own ?? original[0] ?? 0) + 1 : it.own,
+      ),
+    );
+    items.forEach((it, k) => setMarker(out, it.span[0], it.span[1], `${nums[k]}${info.marker}`));
+  };
+
+  const first = (insAt: number) => insAt + (ins[0] === '' ? 1 : 0);
+  if (target && target.id === srcTop.id) {
+    // Within one top-level list: one edit.
+    const { out, map, insAt } = rebuild(srcLines, removed, insertAt, ins);
+    if (into !== null) renumber(out, map, srcTop, into, insAt);
+    if (list.ordered && unit.container !== into) renumber(out, map, srcTop, unit.container!, null);
+    return {
+      move: {
+        changes: [{ from: srcTop.from, to: srcTop.to, insert: out.join(eol) }],
+        at: srcTop.from + offsetOf(out, first(insAt), eol),
+      },
+      topDelta: 0,
+    };
+  }
+  // Out of its list (the list goes with its last item)…
+  const changes: TextChange[] = [];
+  let topDelta = 0;
+  if (alone) {
+    changes.push(topDeletion(text, model, srcTop.from, srcTop.to));
+    topDelta = -1;
+  } else {
+    const { out, map } = rebuild(srcLines, removed, null, []);
+    if (list.ordered) renumber(out, map, srcTop, unit.container!, null);
+    changes.push({ from: srcTop.from, to: srcTop.to, insert: out.join(eol) });
+  }
+  // …into another top-level list…
+  if (target) {
+    const { out, map, insAt } = rebuild(linesOf(target), null, insertAt, ins);
+    if (into !== null) renumber(out, map, target, into, insAt);
+    changes.push({ from: target.from, to: target.to, insert: out.join(eol) });
+    const ordered = sorted(changes);
+    const at = mapPos(ordered, target.from, -1) + offsetOf(out, first(insAt), eol);
+    return { move: { changes: ordered, at }, topDelta };
+  }
+  // …or among the top-level blocks, as a list of its own.
+  const before = slot.scope === 'top' && slot.before !== null ? model.units[slot.before] : null;
+  const { change, lead } = topInsertion(text, model, before, chunk.join(eol));
+  changes.push(change);
+  const ordered = sorted(changes);
+  return {
+    move: { changes: ordered, at: mapPos(ordered, change.from, -1) + lead },
+    topDelta: topDelta + 1,
+  };
+}
+
+/** A table body row moved within its table. */
+function rowMove(text: string, model: BlockModel, unit: Unit, slot: Slot & { scope: 'row' }): Move {
+  const eol = eolOf(text);
+  const table = model.tables[unit.container!];
+  const region = model.units[table.unit];
+  const lines = text.slice(region.from, region.to).split(/\r?\n/);
+  const lineIn = (pos: number) => text.slice(region.from, pos).split('\n').length - 1;
+  const s = lineIn(unit.from);
+  const last = model.units[table.rows[table.rows.length - 1]];
+  const insertAt =
+    slot.before === null ? lineIn(last.to) + 1 : lineIn(model.units[slot.before].from);
+  const { out, insAt } = rebuild(lines, [s, s], insertAt, [lines[s]]);
+  return {
+    changes: [{ from: region.from, to: region.to, insert: out.join(eol) }],
+    at: region.from + offsetOf(out, insAt, eol),
+  };
+}
+
 /** Moves `unit` to `slot` (M4 §3). */
 export function moveBlock(
   text: string,
@@ -125,7 +411,8 @@ export function moveBlock(
   const lineOnly = !!options.lineOnly;
   if (!slotsFor(model, unit, lineOnly).some((s) => sameSlot(s, slot))) return null;
   let move: Move | null = null;
-  if (slot.scope === 'top' && unit.scope === 'top') {
+  let topDelta = 0;
+  if (unit.scope === 'top' && slot.scope === 'top') {
     move = topMove(
       text,
       model,
@@ -133,9 +420,14 @@ export function moveBlock(
       slot.before === null ? null : model.units[slot.before],
       lineOnly,
     );
+  } else if (unit.scope === 'item') {
+    const r = itemMove(text, model, unit, slot);
+    if (r) ({ move, topDelta } = r);
+  } else if (unit.scope === 'row' && slot.scope === 'row') {
+    move = rowMove(text, model, unit, slot);
   }
   if (!move) return null;
-  return holdsTheSameBlocks(text, model, move.changes) ? move : { refused: true };
+  return holdsTheSameBlocks(text, model, move.changes, topDelta) ? move : { refused: true };
 }
 
 // ---- the guard ------------------------------------------------------------
@@ -231,10 +523,17 @@ function windows(text: string, model: BlockModel, changes: TextChange[]): [numbe
 
 /** The move keeps every block (M4 §3, the re-parse guard). Only the windows
  *  around the edits are parsed, so a 200 KB note stays fast (amendment). */
-function holdsTheSameBlocks(text: string, model: BlockModel, changes: TextChange[]): boolean {
+function holdsTheSameBlocks(
+  text: string,
+  model: BlockModel,
+  changes: TextChange[],
+  topLists = 0,
+): boolean {
   const next = applyChanges(text, changes);
-  const before: string[] = [];
-  const after: string[] = [];
+  // A list item dropped among the top-level blocks makes a new list; the
+  // last item leaving a list takes the list away.
+  const before: string[] = Array.from({ length: Math.max(0, topLists) }, () => 'top:list');
+  const after: string[] = Array.from({ length: Math.max(0, -topLists) }, () => 'top:list');
   for (const [a, b] of windows(text, model, changes)) {
     before.push(...signature(text.slice(a, b)));
     after.push(...signature(next.slice(mapPos(changes, a, -1), mapPos(changes, b, 1))));
````

Note: A one-item list and its item share a range: the tests take the item.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown`
Expected: PASS — `Tests  159 passed (159)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/blockMoves.lists.test.ts apps/desktop/src/markdown/blockMoves.ts
git commit -F - <<'MSG'
feat(markdown): move list items between levels and lists, and table rows within their table (M4 §3)

Items take the marker of the list they join (checkboxes stay), are
re-indented by the parent's marker width, renumber ordered lists that
were sequential, become a one-item list among top-level blocks, and take
an emptied list with them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 4: The sweep: every unit to every slot keeps the blocks and undoes cleanly

Spec §7 (amendment 1).

**Files:**
- Create: `apps/desktop/src/markdown/blockMoves.sweep.test.ts`
- Modify: `apps/desktop/src/markdown/blockMoves.test.ts`
- Modify: `apps/desktop/src/markdown/blockMoves.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `blockMoves.sweep.test.ts`; the guard's windows that don't start the note get a leading blank line.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/markdown/blockMoves.sweep.test.ts`:

````ts
// The sweep (M4 §7): every unit of a few representative notes to every slot.
// A move either is refused or keeps every block's text (indentation, `>`
// and list markers aside, by a full parse — independent of the guard's
// windows), and undoing it gives the original back.
import { ChangeSet, Text } from '@codemirror/state';
import type { Node, Parent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { movableBlocks, slotsFor } from './blockModel';
import { applyChanges, moveBlock } from './blockMoves';
import { parsePage } from './parse';

const LEAVES = new Set([
  'paragraph',
  'heading',
  'code',
  'html',
  'thematicBreak',
  'tableRow',
  'yaml',
  'calloutTitle',
]);

/** Every leaf block's text, normalised, sorted; plus `%%` comments. */
function blockTexts(text: string): string[] {
  const page = parsePage(text);
  const out = page.comments.map(([s, e]) => text.slice(s, e));
  const walk = (n: Node) => {
    if (LEAVES.has(n.type)) {
      out.push(
        `${n.type}:${text
          .slice(n.position!.start.offset!, n.position!.end.offset!)
          .split(/\r?\n/)
          .map((l) => l.replace(/^[ \t>]*/, '').trimEnd())
          .join('\n')}`,
      );
      return;
    }
    for (const c of ((n as Parent).children as Node[]) ?? []) walk(c);
  };
  walk(page.tree);
  return out.sort();
}

const NOTES: Record<string, string> = {
  everything: [
    '---',
    'title: x',
    '---',
    '# Title',
    '',
    'Intro *para*.',
    '',
    '## A',
    '',
    'A text.',
    '',
    '- a1',
    '- a2',
    '  - a2x',
    '- [ ] a3',
    '',
    '## B',
    '',
    '1. one',
    '2. two',
    '3. three',
    '',
    '> quote',
    '',
    '| h | i |',
    '|---|---|',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '![[img.png]]',
    '',
    '<div>html</div>',
    '',
    '---',
    '',
    'End.',
    '',
  ].join('\n'),
  tight: '# H\nPara\n- l1\n- l2\nTail %%c%%\n\n%% block comment %%\n\nLast\n',
  containers:
    '> [!note] Title\n> body\n\n::::columns\n:::column\nleft\n:::\n:::column\nright\n:::\n::::\n\nAfter\n\n- x\n\n* y\n',
  lists:
    '- a\n\n- b\n  1. b1\n  2. b2\n\n- c\n\nPara\n\n1. one\n2. two\n3. three\n4. four\n5. five\n6. six\n7. seven\n8. eight\n9. nine\n   - nested\n10. ten\n',
};
NOTES.crlf = NOTES.everything.replace(/\n/g, '\r\n');
// Moves the guard must refuse: an indented code block after a list item
// becomes part of it; taking `Para` away merges the two lists.
NOTES.hazards = '- a\n\nPara\n\n- b\n\nP2\n\n    indented code\n\nTail\n';

describe('the sweep (M4 §7)', () => {
  for (const [name, text] of Object.entries(NOTES)) {
    it(`${name}: every unit to every slot keeps the blocks, and undo restores the note`, () => {
      const model = movableBlocks(text, parsePage(text));
      const original = blockTexts(text);
      let tried = 0;
      let refused = 0;
      for (const unit of model.units) {
        for (const lineOnly of unit.kind === 'heading' ? [false, true] : [false]) {
          for (const slot of slotsFor(model, unit, lineOnly)) {
            tried++;
            const r = moveBlock(text, model, unit, slot, { lineOnly });
            expect(r, `${name} ${unit.id} ${JSON.stringify(slot)}`).not.toBeNull();
            if (!r || 'refused' in r) {
              refused++;
              continue;
            }
            const next = applyChanges(text, r.changes);
            const where = `${name}: unit ${unit.id} (${unit.kind}) → ${JSON.stringify(slot)}${lineOnly ? ' line only' : ''}\n${next}`;
            expect(blockTexts(next), where).toEqual(original);
            // The moved block starts where the move says.
            const first = text
              .slice(unit.from, unit.to)
              .split(/\r?\n/)[0]
              .replace(/^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*/, '');
            expect(next.slice(r.at).split(/\r?\n/)[0], where).toContain(first);
            // A valid change set whose inverse gives the note back. (The
            // editor holds LF text; a CRLF file gets its CRLF back on save.)
            if (text.includes('\r')) continue;
            const doc = Text.of(text.split('\n'));
            const set = ChangeSet.of(r.changes, text.length);
            expect(set.apply(doc).toString(), where).toBe(next);
            expect(set.invert(doc).apply(set.apply(doc)).toString(), where).toBe(text);
          }
        }
      }
      expect(tried).toBeGreaterThan(10);
      // Refusals are the exception (merging lists, swallowed blocks).
      if (name === 'hazards') expect(refused).toBeGreaterThan(0);
      else expect(refused).toBe(0);
    });
  }
});
````

Modify `apps/desktop/src/markdown/blockMoves.test.ts` (apply this change):

````diff
@@ -78,6 +78,13 @@ describe('moving top-level blocks (M4 §3)', () => {
     expect(move('- a\n\nPara\n\n- b\n', 'Para', null)).toBe('refused');
   });
 
+  it('a move next to a horizontal rule is not refused (found by the sweep)', () => {
+    // The guard's window around the drop starts at `---`: a rule there, not
+    // the start of front matter.
+    const text = 'P0\n\n> quote\n\nP1\n\nP2\n\nP3\n\n---\n\nEnd.\n';
+    expect(move(text, '> quote', 'End.')).toBe('P0\n\nP1\n\nP2\n\nP3\n\n---\n\n> quote\n\nEnd.\n');
+  });
+
   it('a slot that leaves the block where it is gives nothing', () => {
     expect(move('P1\n\nP2\n', 'P1', 'P2')).toBeNull();
     expect(move('P1\n\nP2\n', 'P2', null)).toBeNull();
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown/blockMoves.test.ts src/markdown/blockMoves.sweep.test.ts`
Expected: FAIL — without the leading blank line: `a move next to a horizontal rule is not refused` → `expected 'refused' to be 'P0\n\nP1…'` (and 22 of 380 sweep moves were refused near `---`). With the guard switched off (`holdsTheSameBlocks` → true) the `hazards` note fails: `hazards: unit 0 (list) → {"scope":"top","before":6}` — the sweep catches corrupting moves.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/markdown/blockMoves.ts` (apply this change):

````diff
@@ -535,8 +535,11 @@ function holdsTheSameBlocks(
   const before: string[] = Array.from({ length: Math.max(0, topLists) }, () => 'top:list');
   const after: string[] = Array.from({ length: Math.max(0, -topLists) }, () => 'top:list');
   for (const [a, b] of windows(text, model, changes)) {
-    before.push(...signature(text.slice(a, b)));
-    after.push(...signature(next.slice(mapPos(changes, a, -1), mapPos(changes, b, 1))));
+    // A window that doesn't start the note must not read as one: a `---`
+    // there is a rule, not the start of front matter.
+    const lead = a > 0 ? '\n' : '';
+    before.push(...signature(lead + text.slice(a, b)));
+    after.push(...signature(lead + next.slice(mapPos(changes, a, -1), mapPos(changes, b, 1))));
   }
   return before.sort().join('\u0000') === after.sort().join('\u0000');
 }
````

Note: The CodeMirror change-set check runs on LF notes only: the editor holds LF text and CRLF comes back on save.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown`
Expected: PASS — `Tests  166 passed (166)`; counts per note: everything 380 moves (0 refused), tight 22, containers 36, lists 528, crlf 380, hazards (some refused, as it must).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/markdown/blockMoves.sweep.test.ts apps/desktop/src/markdown/blockMoves.test.ts apps/desktop/src/markdown/blockMoves.ts
git commit -F - <<'MSG'
test(markdown): the block-move sweep — every unit to every slot keeps the blocks and undoes cleanly (M4 §7)

The sweep found the guard refusing moves whose window started at a
horizontal rule (parsed as the start of front matter): a window that
doesn't start the note now reads as a continuation.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 5: Moves in the editor: one undo step; Alt+↑/↓ for headings, list items, table rows

Spec §5 (amendment 4).

**Files:**
- Modify: `apps/desktop/src/features/editor/Editor.test.tsx`
- Create: `apps/desktop/src/features/editor/blockCommands.test.ts`
- Create: `apps/desktop/src/features/editor/blockCommands.ts`
- Modify: `apps/desktop/src/features/editor/format.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: Tasks 1–3, `reparse` (incremental), `isolateHistory`, the toast store.
- Produces: `features/editor/blockCommands.ts`: `modelFor(state) → { text, page, model }` (cached per document), `applyMove(view, unit, slot, options) → "moved" | "refused" | "none"` (selection at the moved block, `userEvent: "move.block"`), `moveBlockAtCursor(dir): Command`, `blockKeymap` (in `editorKeymap` before CodeMirror's defaults); i18n `editor.blocks.refused`.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/features/editor/Editor.test.tsx` (apply this change):

````diff
@@ -302,3 +302,26 @@ describe('the keyboard back in the editor (M3a final review I4)', () => {
     button.remove();
   });
 });
+
+describe('block moves from the keyboard (M4 §5)', () => {
+  it('Alt+↓ moves a list item in Live Preview too, as one undo step', async () => {
+    // With a nested item, so it can't pass as CodeMirror's line move.
+    disk = fakeDisk({ 'L.md': '- a\n  - a1\n- b\n' });
+    const doc = await load('L.md');
+    render(<Editor doc={doc} mode="livePreview" label="L" />);
+    act(() => viewOf().dispatch({ selection: { anchor: 1 } }));
+    act(() => {
+      viewOf().contentDOM.dispatchEvent(
+        new KeyboardEvent('keydown', {
+          key: 'ArrowDown',
+          altKey: true,
+          bubbles: true,
+          cancelable: true,
+        }),
+      );
+    });
+    expect(viewOf().state.doc.toString()).toBe('- b\n- a\n  - a1\n');
+    act(() => undo(viewOf()));
+    expect(viewOf().state.doc.toString()).toBe('- a\n  - a1\n- b\n');
+  });
+});
````

Create `apps/desktop/src/features/editor/blockCommands.test.ts`:

````ts
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../../stores/toastStore';
import { applyMove, modelFor } from './blockCommands';
import { editorKeymap } from './format';

let view: EditorView | null = null;
function editor(doc: string, cursor: number): EditorView {
  view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [history(), keymap.of(editorKeymap)],
    }),
  });
  return view;
}
const press = (v: EditorView, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    v.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });
const text = (v: EditorView) => v.state.doc.toString();

afterEach(() => {
  view?.destroy();
  view = null;
  useToastStore.getState().clear();
  document.body.innerHTML = '';
});

describe('moving blocks from the editor (M4 §5)', () => {
  it('Alt+↓ on a list item moves it below the next one; one undo puts it back', async () => {
    const v = editor('- a\n  - a1\n- b\n- c\n', 1);
    await press(v, 'ArrowDown', { altKey: true });
    // The item with its nested one: not a line move.
    expect(text(v)).toBe('- b\n- a\n  - a1\n- c\n');
    // The cursor stays in the moved item.
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe('- a');
    undo(v);
    expect(text(v)).toBe('- a\n  - a1\n- b\n- c\n');
  });

  it('Alt+↑ on a heading moves its section; right after typing, undo first takes back only the move', async () => {
    const v = editor('## A\n\na\n\n## B\n\nb\n', 0);
    act(() => v.dispatch({ selection: { anchor: v.state.doc.length } }));
    act(() =>
      v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' }, userEvent: 'input.type' }),
    );
    act(() => v.dispatch({ selection: { anchor: '## A\n\na\n\n## '.length } }));
    await press(v, 'ArrowUp', { altKey: true });
    expect(text(v)).toBe('## B\n\nb\nx\n\n## A\n\na');
    undo(v);
    expect(text(v)).toBe('## A\n\na\n\n## B\n\nb\nx');
  });

  it('Alt+↑ / ↓ moves table rows', async () => {
    const v = editor('| h |\n|---|\n| 1 |\n| 2 |\n', '| h |\n|---|\n| 1'.length);
    await press(v, 'ArrowDown', { altKey: true });
    expect(text(v)).toBe('| h |\n|---|\n| 2 |\n| 1 |\n');
  });

  it('in a paragraph Alt+↑ stays CodeMirror’s line move', async () => {
    const v = editor('one\ntwo\n', 5);
    await press(v, 'ArrowUp', { altKey: true });
    expect(text(v)).toBe('two\none\n');
  });

  it('a refused move changes nothing and says so', () => {
    const v = editor('- a\n\nPara\n\n- b\n', 0);
    const { model } = modelFor(v.state);
    const para = model.units.find((u) => u.kind === 'paragraph')!;
    expect(applyMove(v, para, { scope: 'top', before: null })).toBe('refused');
    expect(text(v)).toBe('- a\n\nPara\n\n- b\n');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('This block can’t be moved here.');
  });

  it('the model is reused for an unchanged document', () => {
    const v = editor('P1\n\nP2\n', 0);
    expect(modelFor(v.state)).toBe(modelFor(v.state));
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/blockCommands.test.ts`
Expected: FAIL — `Failed to resolve import "./blockCommands"`. (Without `...blockKeymap` in `editorKeymap`, three tests fail: the item tests use a nested item so a line move can't pass for a block move.)

- [ ] **Step 3: Implement**

Create `apps/desktop/src/features/editor/blockCommands.ts`:

````ts
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
````

Modify `apps/desktop/src/features/editor/format.ts` (apply this change):

````diff
@@ -11,6 +11,7 @@ import {
   type StateCommand,
 } from '@codemirror/state';
 import type { KeyBinding } from '@codemirror/view';
+import { blockKeymap } from './blockCommands';
 import { openLinkPicker } from './linkPickerOpen';
 
 export type InlineFormat = 'bold' | 'italic' | 'strike' | 'highlight' | 'code';
@@ -458,5 +459,7 @@ export const formatKeymap: readonly KeyBinding[] = [
  *  ⌘[ / ⌘] (they go back and forward along the link trail, M2b §3). */
 export const editorKeymap: readonly KeyBinding[] = [
   ...formatKeymap,
+  // Alt+↑ / Alt+↓ move a heading's section, a list item or a table row (M4 §5).
+  ...blockKeymap,
   ...defaultKeymap.filter((b) => b.key !== 'Mod-[' && b.key !== 'Mod-]'),
 ];
````

Modify `apps/desktop/src/i18n/locales/en.json` (apply this change):

````diff
@@ -120,7 +120,10 @@
     "saveStatus": "Save status",
     "unsavedBlocks": "Unsaved changes in “{name}” couldn’t be written, so the vault stays open.",
     "unsavedKeepsWindow": "Unsaved changes in “{name}” couldn’t be written, so the window stays open. Close it again to quit without them.",
-    "copying": "Copying files…"
+    "copying": "Copying files…",
+    "blocks": {
+      "refused": "This block can’t be moved here."
+    }
   },
   "preview": {
     "remoteBlocked": "Remote image blocked (privacy)",
````

Modify `apps/desktop/src/i18n/locales/es.json` (apply this change):

````diff
@@ -120,7 +120,10 @@
     "saveStatus": "Estado de guardado",
     "unsavedBlocks": "Los cambios sin guardar en «{name}» no se pudieron escribir, así que la bóveda sigue abierta.",
     "unsavedKeepsWindow": "Los cambios sin guardar en «{name}» no se pudieron escribir, así que la ventana sigue abierta. Ciérrala otra vez para salir sin ellos.",
-    "copying": "Copiando archivos…"
+    "copying": "Copiando archivos…",
+    "blocks": {
+      "refused": "Este bloque no se puede mover aquí."
+    }
   },
   "preview": {
     "remoteBlocked": "Imagen remota bloqueada (privacidad)",
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor src/i18n && pnpm check:i18n`
Expected: PASS — editor tests all green (`blockCommands.test.ts` 6, `Editor.test.tsx` incl. "Alt+↓ moves a list item in Live Preview too"); `i18n OK: 2 locales in parity.`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/editor/Editor.test.tsx apps/desktop/src/features/editor/blockCommands.test.ts apps/desktop/src/features/editor/blockCommands.ts apps/desktop/src/features/editor/format.ts apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json
git commit -F - <<'MSG'
feat(editor): block moves as one undo step; Alt+↑/↓ moves a heading's section, a list item or a table row (M4 §5)

Anywhere else Alt+↑/↓ stays CodeMirror's line move; a refused move
changes nothing and says "This block can't be moved here."

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 6: The Split pane's block gutter: grip, buttons, keyboard moves, pick-up

Spec §4, §5 (amendment 5).

**Files:**
- Create: `apps/desktop/src/features/editor/BlockGutter.module.css`
- Create: `apps/desktop/src/features/editor/BlockGutter.test.tsx`
- Create: `apps/desktop/src/features/editor/BlockGutter.tsx`
- Modify: `apps/desktop/src/features/editor/Editor.module.css`
- Modify: `apps/desktop/src/features/editor/Editor.tsx`
- Modify: `apps/desktop/src/features/editor/livePreview.ts`
- Modify: `apps/desktop/src/features/preview/Preview.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/markdown/sanitize.test.ts`
- Modify: `apps/desktop/src/markdown/sanitize.ts`

**Interfaces:**
- Consumes: Task 5 (`applyMove`, `modelFor`), Task 1 (`slotsFor`, `neighbourSlot`, `indentSlot`, `slotAt`).
- Produces: `BlockGutter({ view, pane, shown })`, `Shown { text, page }`, `summaryOf(text, unit, t)`; `Preview` prop `onRendered(text, page)`; NoteEmbed `data-note-embed`; HTML blocks in `div[data-liber="html"]` with their source range; the pane is `position: relative`; i18n `editor.blocks.{grip,moveUp,moveDown,indent,outdent,help,moved,picked,cancelled,slot.*,kinds.*}`.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/features/editor/BlockGutter.test.tsx`:

````tsx
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const source = () => viewOf().state.doc.toString();

/** The page in Split mode, once the pane shows it. */
async function split(text: string) {
  fakeDisk({ 'B.md': text });
  const res = await PageDoc.load('B.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(<Editor doc={res.value} mode="split" label="B" />);
  const pane = await screen.findByRole('region', { name: 'Preview' });
  await vi.waitFor(() => expect(pane.querySelector('[data-source-start]')).not.toBeNull());
  return pane;
}
/** The rendered block whose text is `text` (deepest match). */
const block = (pane: HTMLElement, text: string) =>
  [...pane.querySelectorAll<HTMLElement>('[data-source-start]')]
    .reverse()
    .find((el) => el.textContent?.trim().startsWith(text))!;
const hover = (el: Element) => act(() => fireEvent.mouseOver(el));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => fireEvent.keyDown(el, { key: k, ...init }));
/** Shows a gutter's buttons (they open when it's hovered). */
const opened = (name: string) => {
  const group = screen.getByRole('group', { name });
  fireEvent.mouseEnter(group);
  return group;
};
const grip = (name: string) => screen.getByRole('button', { name: `Drag to reorder: ${name}` });
const status = () => document.querySelector('[data-block-status]')!.textContent;

afterEach(() => clearMocks());

describe('the block gutter in the Split pane (M4 §4)', () => {
  it('hovering a block shows its gutter: the deepest block only; a list shows its own from its margin', async () => {
    const pane = await split('P1\n\nP2\n\n- a\n  - a1\n');
    await hover(block(pane, 'P2'));
    const group = opened('P2');
    expect(within(group).getByRole('button', { name: 'Drag to reorder: P2' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Move up' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Move down' })).toBeInTheDocument();
    await hover(block(pane, 'a1'));
    const item = opened('a1');
    expect(within(item).getByRole('button', { name: 'Outdent' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'a' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'List: a' })).not.toBeInTheDocument();
    // The list itself, outside any of its items (its left margin).
    await hover(pane.querySelector('ul')!);
    expect(screen.getByRole('group', { name: 'List: a' })).toBeInTheDocument();
  });

  it('Move up moves the block in the source and says so', async () => {
    const pane = await split('P1\n\nP2\n');
    await hover(block(pane, 'P2'));
    const up = within(opened('P2')).getByRole('button', { name: 'Move up' });
    await act(() => up.click());
    expect(source()).toBe('P2\n\nP1\n');
    expect(status()).toBe('Moved P2.');
  });

  it('Indent and Outdent move a list item between levels', async () => {
    const pane = await split('- a\n- b\n');
    await hover(block(pane, 'b'));
    const indent = within(opened('b')).getByRole('button', { name: 'Indent' });
    await act(() => indent.click());
    expect(source()).toBe('- a\n  - b\n');
  });

  it('keyboard: one tab stop, ↑/↓ go from block to block, Alt+↑ moves it and its grip keeps the keyboard', async () => {
    await split('P1\n\nP2\n\nP3\n');
    const first = grip('P1');
    expect(first.tabIndex).toBe(0);
    act(() => first.focus());
    await key(first, 'ArrowDown');
    expect(grip('P2')).toHaveFocus();
    await key(grip('P2'), 'ArrowUp', { altKey: true });
    expect(source()).toBe('P2\n\nP1\n\nP3\n');
    await vi.waitFor(() => expect(grip('P2')).toHaveFocus());
    expect(status()).toBe('Moved P2.');
  });

  it('Enter picks a block up: arrows choose a place, Enter drops it; Escape cancels', async () => {
    await split('P1\n\nP2\n\nP3\n');
    act(() => grip('P1').focus());
    await key(grip('P1'), 'Enter');
    expect(status()).toBe(
      'P1 picked up. Arrow keys choose where, Enter drops it, Escape cancels. Before P3',
    );
    await key(grip('P1'), 'ArrowDown');
    expect(status()).toBe('At the end of the page');
    await key(grip('P1'), 'Escape');
    expect(status()).toBe('Move cancelled.');
    expect(source()).toBe('P1\n\nP2\n\nP3\n');
    await key(grip('P1'), 'Enter');
    await key(grip('P1'), 'ArrowDown');
    await key(grip('P1'), 'Enter');
    expect(source()).toBe('P2\n\nP3\n\nP1\n');
  });

  it('NFR-10: no axe violations with a gutter showing', async () => {
    const pane = await split('# T\n\nP1\n\n- a\n- b\n');
    await hover(block(pane, 'b'));
    const violations = await axe
      .run(pane, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
````

Modify `apps/desktop/src/markdown/sanitize.test.ts` (apply this change):

````diff
@@ -139,6 +139,18 @@ describe('extension nodes become marked elements', () => {
     expect(h.properties.id).toBe('title');
   });
 
+  it('M4: an HTML block sits in a wrapper that carries its source range (the drag gutter needs one)', () => {
+    const src = 'Before\n\n<div class="x">raw <b>html</b></div>\n\n<!-- note -->\n\nAfter\n';
+    const wrappers = elements(render(src)).filter((e) => e.properties.dataLiber === 'html');
+    expect(
+      wrappers.map((w) =>
+        src.slice(Number(w.properties.dataSourceStart), Number(w.properties.dataSourceEnd)),
+      ),
+    ).toEqual(['<div class="x">raw <b>html</b></div>', '<!-- note -->']);
+    // The HTML itself still renders inside it.
+    expect(JSON.stringify(wrappers[0])).toContain('"tagName":"b"');
+  });
+
   it('frontmatter is not rendered', () => {
     expect(html('---\nsubtitle: S\n---\nBody\n')).not.toContain('subtitle');
   });
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/BlockGutter.test.tsx src/markdown/sanitize.test.ts`
Expected: FAIL — `BlockGutter.test.tsx`: 5 failed (no gutter; axe passes vacuously); `sanitize.test.ts`: `expected [] to deeply equal [ …(2) ]` (no HTML wrapper).

- [ ] **Step 3: Implement**

Create `apps/desktop/src/features/editor/BlockGutter.module.css`:

````css
/* The Split pane's block gutter (M4 §4): drawn over the pane's content, in
   its scroll coordinates (the pane is `position: relative`). */
.layer {
  position: absolute;
  inset: 0 auto auto 0;
  width: 0;
  height: 0;
  z-index: 2;
}

.gutter {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 22px;
}

/* The block with the keyboard keeps a gutter for its tab stop, shown only
   while it has the keyboard. */
.idle {
  opacity: 0;
}

.idle:focus-within {
  opacity: 1;
}

.extra {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  box-shadow: var(--shadow-card);
}

.grip,
.button {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font: 600 12px var(--font-body);
  cursor: pointer;
}

.grip {
  cursor: grab;
}

.grip:hover,
.button:hover {
  background: var(--color-surface-subtle);
  color: var(--color-text-strong);
}

.grip:focus {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

.grip:focus:not(:focus-visible) {
  outline: none;
}

.drop {
  position: absolute;
  height: 2px;
  background: var(--color-accent);
  border-radius: 1px;
  pointer-events: none;
}

.drop::before {
  content: '';
  position: absolute;
  left: -4px;
  top: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent);
}

.flash {
  position: absolute;
  border-radius: var(--radius-sm);
  outline: 2px solid var(--color-accent);
  background: var(--color-accent-soft);
  opacity: 0.45;
  pointer-events: none;
}

.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
````

Create `apps/desktop/src/features/editor/BlockGutter.tsx`:

````tsx
// The block gutter of the Split pane (M4 §4, §5): next to the block under the
// pointer (and the one with the keyboard) a grip, Move up / Move down, and
// for list items Indent / Outdent. One tab stop; ↑/↓ go from block to block,
// Alt+arrows move, Enter picks a block up to choose where it goes.
import type { EditorView } from '@codemirror/view';
import type { TFunction } from 'i18next';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  indentSlot,
  movableBlocks,
  neighbourSlot,
  slotAt,
  slotsFor,
  type BlockModel,
  type Slot,
  type Unit,
} from '../../markdown/blockModel';
import type { ParsedPage } from '../../markdown/types';
import { applyMove, modelFor } from './blockCommands';
import styles from './BlockGutter.module.css';

export interface Shown {
  text: string;
  page: ParsedPage;
}

const TAGS: Record<Unit['kind'], RegExp> = {
  heading: /^H[1-6]$/,
  paragraph: /^P$/,
  embed: /^(DIV|P)$/,
  list: /^(UL|OL)$/,
  listItem: /^LI$/,
  quote: /^BLOCKQUOTE$/,
  callout: /^DIV$/,
  code: /^PRE$/,
  table: /^TABLE$/,
  tableRow: /^TR$/,
  html: /^DIV$/,
  columns: /^DIV$/,
  rule: /^HR$/,
  other: /./,
};

/** Each unit's rendered element: the outermost element of its kind starting
 *  on its first line (blocks of embedded notes aside). */
function anchorsOf(pane: HTMLElement, model: BlockModel, text: string): Map<number, HTMLElement> {
  const els = [...pane.querySelectorAll<HTMLElement>('[data-source-start]')].filter(
    (el) => !el.closest('[data-note-embed]'),
  );
  const out = new Map<number, HTMLElement>();
  for (const u of model.units) {
    const first = u.from + (/^[ \t]*/.exec(text.slice(u.from, u.to))?.[0].length ?? 0);
    const el = els.find((e) => {
      const at = Number(e.dataset.sourceStart);
      return at >= u.from && at <= first && TAGS[u.kind].test(e.tagName);
    });
    if (el) out.set(u.id, el);
  }
  return out;
}

const KIND_LABEL: Partial<Record<Unit['kind'], string>> = {
  code: 'code',
  table: 'table',
  rule: 'rule',
  embed: 'embed',
  html: 'html',
  columns: 'columns',
  list: 'list',
};

/** A short name for a block: its first line's text, or its kind. */
export function summaryOf(text: string, unit: Unit, t: TFunction): string {
  const line = text.slice(unit.from, unit.to).split(/\r?\n/)[0];
  const words = line
    .replace(/^[ \t>]*/, '')
    .replace(/^(#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/, '')
    .replace(/\[!(\w+)\][+-]?/, '$1')
    .replace(/[*_`~=[\]|#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const short = words.length > 40 ? `${words.slice(0, 39)}…` : words;
  const kind = KIND_LABEL[unit.kind];
  if (unit.kind === 'list') return `${t('editor.blocks.kinds.list')}: ${short}`;
  if (kind && unit.kind !== 'embed') return t(`editor.blocks.kinds.${kind}`);
  return short || t(`editor.blocks.kinds.${kind ?? 'other'}`);
}

/** Where a slot is drawn, in the pane's content coordinates. */
function slotLine(
  pane: HTMLElement,
  model: BlockModel,
  slot: Slot,
  anchors: Map<number, HTMLElement>,
): { top: number; left: number; width: number } | null {
  const box = (id: number) => {
    const el = anchors.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return {
      top: r.top - p.top + pane.scrollTop,
      left: r.left - p.left + pane.scrollLeft,
      width: r.width,
      height: r.height,
    };
  };
  const before = (id: number) => {
    const b = box(id);
    return b && { top: b.top - 3, left: b.left, width: b.width };
  };
  const after = (id: number, indent = 0) => {
    const b = box(id);
    return b && { top: b.top + b.height + 1, left: b.left + indent, width: b.width - indent };
  };
  switch (slot.scope) {
    case 'top': {
      if (slot.before !== null) return before(slot.before);
      const tops = model.units.filter((u) => u.scope === 'top');
      return tops.length ? after(tops[tops.length - 1].id) : null;
    }
    case 'item': {
      if (slot.before !== null) return before(slot.before);
      return after(model.lists[slot.list].items.at(-1)!);
    }
    case 'child':
      return after(slot.of, 24);
    case 'row': {
      if (slot.before !== null) return before(slot.before);
      return after(model.tables[slot.table].rows.at(-1)!);
    }
  }
}

interface Picking {
  unit: number;
  slots: Slot[];
  index: number;
  lineOnly: boolean;
}

export function BlockGutter({
  view,
  pane,
  shown,
}: {
  view: EditorView;
  pane: RefObject<HTMLDivElement | null>;
  shown: Shown | null;
}) {
  const { t } = useTranslation();
  const model = useMemo(() => (shown ? movableBlocks(shown.text, shown.page) : null), [shown]);
  const [anchors, setAnchors] = useState<Map<number, HTMLElement>>(new Map());
  const [hover, setHover] = useState<number[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [status, setStatus] = useState('');
  const [flash, setFlash] = useState<number | null>(null);
  /** The gutter showing its buttons (hovered, or holding the keyboard). */
  const [opened, setOpened] = useState<number | null>(null);
  const [, relayout] = useState(0);
  const layer = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  /** After a move: the offset the moved block starts at in the new text. */
  const movedAt = useRef<number | null>(null);

  // The rendered elements of the version shown (the pane commits first).
  useLayoutEffect(() => {
    if (!pane.current || !model || !shown) return setAnchors(new Map());
    setAnchors(anchorsOf(pane.current, model, shown.text));
  }, [pane, model, shown]);

  const order = useMemo(
    () => (model ? model.units.filter((u) => anchors.has(u.id)).map((u) => u.id) : []),
    [model, anchors],
  );
  const tabStop = current !== null && anchors.has(current) ? current : (order[0] ?? null);
  const name = useCallback(
    (id: number) => (model && shown ? summaryOf(shown.text, model.units[id], t) : ''),
    [model, shown, t],
  );

  // A moved block keeps the keyboard and flashes once the pane shows it.
  useEffect(() => {
    if (!model || movedAt.current === null) return;
    const at = movedAt.current;
    const moved = model.units
      .filter((u) => u.from === at && anchors.has(u.id))
      .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
    if (!moved) return;
    movedAt.current = null;
    setCurrent(moved.id);
    setFlash(moved.id);
    focusNext.current = true;
    const timer = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(timer);
  }, [model, anchors]);

  // The grip with the keyboard follows `current`.
  useEffect(() => {
    if (!focusNext.current || tabStop === null) return;
    focusNext.current = false;
    layer.current?.querySelector<HTMLElement>(`[data-grip="${tabStop}"]`)?.focus();
  }, [tabStop, anchors]);

  // Hover: the blocks under the pointer, outermost first.
  useEffect(() => {
    const p = pane.current;
    if (!p) return;
    const over = (e: Event) => {
      const target = e.target as Element;
      if (layer.current?.contains(target)) return;
      // The deepest block under the pointer: a list item, not its list (a
      // list shows its own gutter from its margin, outside its items).
      const deepest = [...anchors.entries()]
        .filter(([, el]) => el.contains(target))
        .sort(([, a], [, b]) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0))[0];
      setHover(deepest ? [deepest[0]] : []);
    };
    const leave = () => setHover([]);
    const moved = () => relayout((n) => n + 1);
    p.addEventListener('mouseover', over);
    p.addEventListener('mouseleave', leave);
    p.addEventListener('scroll', moved);
    window.addEventListener('resize', moved);
    return () => {
      p.removeEventListener('mouseover', over);
      p.removeEventListener('mouseleave', leave);
      p.removeEventListener('scroll', moved);
      window.removeEventListener('resize', moved);
    };
  }, [pane, anchors]);

  /** Moves a block of the version shown; nothing when the editor has moved
   *  on (the pane catches up within its render delay). */
  const move = (id: number, slot: Slot | null, lineOnly = false) => {
    if (!slot || !shown || view.state.doc.toString() !== shown.text) return;
    const fresh = modelFor(view.state).model;
    const label = name(id);
    if (applyMove(view, fresh.units[id], slot, { lineOnly }) !== 'moved') return;
    movedAt.current = view.state.selection.main.head;
    setStatus(t('editor.blocks.moved', { block: label }));
  };

  const describe = (slot: Slot): string => {
    switch (slot.scope) {
      case 'top':
        return slot.before === null
          ? t('editor.blocks.slot.end')
          : t('editor.blocks.slot.before', { block: name(slot.before) });
      case 'item':
        return slot.before === null
          ? t('editor.blocks.slot.endOfList')
          : t('editor.blocks.slot.before', { block: name(slot.before) });
      case 'child':
        return t('editor.blocks.slot.inside', { block: name(slot.of) });
      case 'row':
        return slot.before === null
          ? t('editor.blocks.slot.endOfTable')
          : t('editor.blocks.slot.before', { block: name(slot.before) });
    }
  };

  const onKey = (e: KeyboardEvent, id: number) => {
    if (!model) return;
    const unit = model.units[id];
    if (picking) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const index = Math.max(
          0,
          Math.min(picking.slots.length - 1, picking.index + (e.key === 'ArrowDown' ? 1 : -1)),
        );
        setPicking({ ...picking, index });
        setStatus(describe(picking.slots[index]));
      } else if (e.key === 'Enter' || e.key === ' ') {
        setPicking(null);
        move(picking.unit, picking.slots[picking.index], picking.lineOnly);
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        setPicking(null);
        setStatus(t('editor.blocks.cancelled'));
        if (e.key === 'Tab') return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const plain = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
    if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const k = order.indexOf(id) + (e.key === 'ArrowDown' ? 1 : -1);
      if (k >= 0 && k < order.length) {
        focusNext.current = true;
        setCurrent(order[k]);
      }
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      move(id, neighbourSlot(model, unit, e.key === 'ArrowUp' ? -1 : 1, e.shiftKey), e.shiftKey);
    } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      move(id, indentSlot(model, unit, e.key === 'ArrowRight' ? 1 : -1));
    } else if (plain && (e.key === 'Enter' || e.key === ' ')) {
      const slots = slotsFor(model, unit, false);
      if (!slots.length) return;
      const after = slots.findIndex((s) => slotAt(model, s) > unit.from);
      const index = after < 0 ? slots.length - 1 : after;
      setPicking({ unit: id, slots, index, lineOnly: false });
      setStatus(`${t('editor.blocks.picked', { block: name(id) })} ${describe(slots[index])}`);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (!model || !shown || !pane.current) {
    return <div ref={layer} className={styles.layer} />;
  }
  const p = pane.current;
  const pr = p.getBoundingClientRect();
  const placeOf = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top - pr.top + p.scrollTop,
      left: r.left - pr.left + p.scrollLeft,
      width: r.width,
      height: r.height,
    };
  };
  const visible = [
    ...new Set([
      ...hover,
      ...(tabStop !== null ? [tabStop] : []),
      ...(picking ? [picking.unit] : []),
    ]),
  ];
  const drop = picking ? slotLine(p, model, picking.slots[picking.index], anchors) : null;

  return (
    <div ref={layer} className={styles.layer}>
      <div className={styles.srOnly} role="status" data-block-status="">
        {status}
      </div>
      <p id="block-gutter-help" className={styles.srOnly}>
        {t('editor.blocks.help')}
      </p>
      {flash !== null && anchors.get(flash) && (
        <div className={styles.flash} style={placeOf(anchors.get(flash)!)} aria-hidden="true" />
      )}
      {drop && <div className={styles.drop} style={drop} aria-hidden="true" />}
      {visible.map((id) => {
        const el = anchors.get(id);
        if (!el) return null;
        const at = placeOf(el);
        const unit = model.units[id];
        const label = name(id);
        const shownNow = hover.includes(id) || picking?.unit === id;
        const button = (key: string, onClick: () => void, glyph: string) => (
          <button
            type="button"
            tabIndex={-1}
            className={styles.button}
            aria-label={t(`editor.blocks.${key}`)}
            title={t(`editor.blocks.${key}`)}
            // The editor keeps the keyboard when these are clicked.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
          >
            <span aria-hidden="true">{glyph}</span>
          </button>
        );
        return (
          <div
            key={id}
            role="group"
            aria-label={label}
            className={
              shownNow || opened === id ? styles.gutter : `${styles.gutter} ${styles.idle}`
            }
            onMouseEnter={() => setOpened(id)}
            onMouseLeave={(e) => {
              if (!e.currentTarget.contains(document.activeElement)) setOpened(null);
            }}
            onFocus={() => setOpened(id)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpened(null);
            }}
            style={{ top: at.top, left: at.left - (unit.scope === 'item' ? 40 : 26) }}
          >
            <button
              type="button"
              data-grip={id}
              className={styles.grip}
              tabIndex={id === tabStop ? 0 : -1}
              aria-label={t('editor.blocks.grip', { block: label })}
              aria-describedby="block-gutter-help"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Enter"
              onFocus={() => setCurrent(id)}
              onKeyDown={(e) => onKey(e, id)}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="9" cy="6" r="1.8" />
                <circle cx="15" cy="6" r="1.8" />
                <circle cx="9" cy="12" r="1.8" />
                <circle cx="15" cy="12" r="1.8" />
                <circle cx="9" cy="18" r="1.8" />
                <circle cx="15" cy="18" r="1.8" />
              </svg>
            </button>
            {/* Shown while the gutter is hovered or has the keyboard. */}
            {opened === id && (
              <div className={styles.extra}>
                {button('moveUp', () => move(id, neighbourSlot(model, unit, -1)), '↑')}
                {button('moveDown', () => move(id, neighbourSlot(model, unit, 1)), '↓')}
                {unit.scope === 'item' &&
                  button('indent', () => move(id, indentSlot(model, unit, 1)), '→')}
                {unit.scope === 'item' &&
                  button('outdent', () => move(id, indentSlot(model, unit, -1)), '←')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
````

Modify `apps/desktop/src/features/editor/Editor.module.css` (apply this change):

````diff
@@ -47,6 +47,8 @@
 }
 
 .pane {
+  /* The block gutter (M4 §4) is placed in the pane's scroll coordinates. */
+  position: relative;
   overflow: auto;
   padding: 20px 28px;
 }
````

Modify `apps/desktop/src/features/editor/Editor.tsx` (apply this change):

````diff
@@ -15,6 +15,7 @@ import { Preview } from '../preview/Preview';
 import styles from './Editor.module.css';
 import { followLinkAtCursor, livePreview, pagePath } from './livePreview';
 import { attachmentHandlers } from './attachments';
+import { BlockGutter, type Shown } from './BlockGutter';
 import { activeFormats, editorKeymap, type ActiveFormat } from './format';
 import { linkCompletion } from './linkComplete';
 import { LinkPicker } from './LinkPicker';
@@ -354,6 +355,13 @@ export function Editor({ doc, mode, label }: EditorProps) {
     if (view.current) toggleTaskIn(view.current, at);
   }, []);
 
+  // What the Split pane shows, for its block gutter (M4 §4).
+  const [shown, setShown] = useState<Shown | null>(null);
+  const onRendered = useCallback(
+    (text: string, page: Shown['page']) => setShown({ text, page }),
+    [],
+  );
+
   return (
     <div className={styles.frame}>
       {showToolbar && toolbarView && <Toolbar view={toolbarView} active={active} />}
@@ -362,7 +370,13 @@ export function Editor({ doc, mode, label }: EditorProps) {
         <div ref={host} className={mode === 'livePreview' ? styles.live : styles.source} />
         {split && (
           <div ref={pane} className={styles.pane} role="region" aria-label={t('editor.preview')}>
-            <Preview text={text} path={doc.path} onToggleTask={toggleTask} />
+            {toolbarView && <BlockGutter view={toolbarView} pane={pane} shown={shown} />}
+            <Preview
+              text={text}
+              path={doc.path}
+              onToggleTask={toggleTask}
+              onRendered={onRendered}
+            />
           </div>
         )}
       </div>
````

Modify `apps/desktop/src/features/editor/livePreview.ts` (apply this change):

````diff
@@ -74,8 +74,15 @@ const emptyHtml = new Map<string, boolean>();
 function rendersEmpty(source: string): boolean {
   let empty = emptyHtml.get(source);
   if (empty === undefined) {
-    const visible = (n: { type: string; value?: unknown; children?: unknown[] }): boolean =>
-      n.type === 'element' ||
+    const visible = (n: {
+      type: string;
+      value?: unknown;
+      children?: unknown[];
+      properties?: Record<string, unknown>;
+    }): boolean =>
+      // The wrapper every HTML block gets (M4: the gutter's anchor) shows
+      // only what's inside it.
+      (n.type === 'element' && n.properties?.dataLiber !== 'html') ||
       (n.type === 'text' && typeof n.value === 'string' && n.value.trim() !== '') ||
       (n.children ?? []).some((c) => visible(c as never));
     empty = !visible(toSafeHast(parsePage(source), { sourcePath: '' }) as never);
````

Modify `apps/desktop/src/features/preview/Preview.tsx` (apply this change):

````diff
@@ -4,6 +4,7 @@ import { useTranslation } from 'react-i18next';
 import { pageRead } from '../../ipc';
 import { sameHeading } from '../../markdown/headings';
 import { parsePage } from '../../markdown/parse';
+import type { ParsedPage } from '../../markdown/types';
 import { toSafeHast } from '../../markdown/sanitize';
 import { sectionOf } from '../../markdown/section';
 import { openPage } from '../../stores/navigate';
@@ -32,6 +33,9 @@ export interface PreviewProps {
   /** Makes task checkboxes clickable: toggles the task whose list item starts
    *  at the source offset (relative to `text`). */
   onToggleTask?: (at: number) => void;
+  /** Called with the text and model each time the pane shows a new version
+   *  (the Split pane's block gutter, M4 §4, maps blocks by their offsets). */
+  onRendered?: (text: string, page: ParsedPage) => void;
 }
 
 /** The rendered pane (M2a §4): sanitized Markdown with resolved links and
@@ -52,6 +56,7 @@ function PreviewBody({
   chain = [],
   embedded = false,
   onToggleTask,
+  onRendered,
 }: PreviewProps) {
   const { t } = useTranslation();
   const shown = useDebounced(text, RENDER_DEBOUNCE_MS);
@@ -63,6 +68,7 @@ function PreviewBody({
     return toSafeHast(part, { sourcePath: path });
   }, [page, path, heading]);
   const resolve = useResolved(path, tree);
+  useEffect(() => onRendered?.(shown, page), [onRendered, shown, page]);
   const anchor = usePageStore((s) => (depth === 0 && !embedded ? s.anchor : null));
   const box = useRef<HTMLDivElement>(null);
 
@@ -148,7 +154,7 @@ function NoteEmbed({
   const title = heading ? `${name} › ${heading}` : name;
   const missing = text === null || (text && heading && !sectionOf(parsePage(text).tree, heading));
   return (
-    <section ref={ref} className={styles.noteEmbed} aria-label={title}>
+    <section ref={ref} className={styles.noteEmbed} aria-label={title} data-note-embed="">
       <header className={styles.noteHeader}>
         <span className={styles.noteTitle}>{title}</span>
         <button
````

Modify `apps/desktop/src/i18n/locales/en.json` (apply this change):

````diff
@@ -122,7 +122,33 @@
     "unsavedKeepsWindow": "Unsaved changes in “{name}” couldn’t be written, so the window stays open. Close it again to quit without them.",
     "copying": "Copying files…",
     "blocks": {
-      "refused": "This block can’t be moved here."
+      "refused": "This block can’t be moved here.",
+      "grip": "Drag to reorder: {block}",
+      "moveUp": "Move up",
+      "moveDown": "Move down",
+      "indent": "Indent",
+      "outdent": "Outdent",
+      "help": "Up and Down go from block to block. Alt+Up or Alt+Down moves the block, Alt+Right or Alt+Left indents or outdents a list item, and Alt+Shift moves a heading without its section. Enter picks the block up to choose where it goes.",
+      "moved": "Moved {block}.",
+      "picked": "{block} picked up. Arrow keys choose where, Enter drops it, Escape cancels.",
+      "cancelled": "Move cancelled.",
+      "slot": {
+        "before": "Before {block}",
+        "end": "At the end of the page",
+        "endOfList": "At the end of the list",
+        "inside": "Inside {block}",
+        "endOfTable": "At the end of the table"
+      },
+      "kinds": {
+        "list": "List",
+        "code": "Code block",
+        "table": "Table",
+        "rule": "Divider",
+        "embed": "Embed",
+        "html": "HTML block",
+        "columns": "Columns",
+        "other": "Block"
+      }
     }
   },
   "preview": {
````

Modify `apps/desktop/src/i18n/locales/es.json` (apply this change):

````diff
@@ -122,7 +122,33 @@
     "unsavedKeepsWindow": "Los cambios sin guardar en «{name}» no se pudieron escribir, así que la ventana sigue abierta. Ciérrala otra vez para salir sin ellos.",
     "copying": "Copiando archivos…",
     "blocks": {
-      "refused": "Este bloque no se puede mover aquí."
+      "refused": "Este bloque no se puede mover aquí.",
+      "grip": "Arrastrar para reordenar: {block}",
+      "moveUp": "Subir",
+      "moveDown": "Bajar",
+      "indent": "Sangrar",
+      "outdent": "Quitar sangría",
+      "help": "Arriba y Abajo van de un bloque a otro. Alt+Arriba o Alt+Abajo mueven el bloque, Alt+Derecha o Alt+Izquierda sangran o quitan la sangría de un elemento de lista, y Alt+Mayús mueve un encabezado sin su sección. Intro toma el bloque para elegir dónde va.",
+      "moved": "Se movió {block}.",
+      "picked": "Tomaste {block}. Las flechas eligen dónde, Intro lo suelta y Escape cancela.",
+      "cancelled": "Movimiento cancelado.",
+      "slot": {
+        "before": "Antes de {block}",
+        "end": "Al final de la página",
+        "endOfList": "Al final de la lista",
+        "inside": "Dentro de {block}",
+        "endOfTable": "Al final de la tabla"
+      },
+      "kinds": {
+        "list": "Lista",
+        "code": "Bloque de código",
+        "table": "Tabla",
+        "rule": "Separador",
+        "embed": "Incrustación",
+        "html": "Bloque HTML",
+        "columns": "Columnas",
+        "other": "Bloque"
+      }
     }
   },
   "preview": {
````

Modify `apps/desktop/src/markdown/sanitize.ts` (apply this change):

````diff
@@ -317,9 +317,28 @@ function addHeadingIds(tree: Root) {
   walk(tree);
 }
 
+/** HTML blocks (raw at the top level) in a `div` carrying their source
+ *  range: the HTML parsed from them has no position, and the block gutter
+ *  (M4 §4) needs an element to sit next to. */
+function wrapHtmlBlocks(root: Root) {
+  root.children = root.children.map((c) => {
+    if (c.type !== 'raw' || !c.position) return c;
+    return el(
+      'div',
+      {
+        dataLiber: 'html',
+        dataSourceStart: c.position.start.offset,
+        dataSourceEnd: c.position.end.offset,
+      },
+      [c as unknown as ElementContent],
+    );
+  });
+}
+
 /** The page as a sanitized hast tree, ready for React rendering. */
 export function toSafeHast(page: ParsedPage, ctx: RenderContext): Root {
   const hast = toHast(page.tree, { allowDangerousHtml: true, handlers }) as Root;
+  wrapHtmlBlocks(hast);
   markSourceRanges(hast);
   const parsed = raw(hast) as Root;
   const clean = sanitize(parsed, schema) as Root;
````

Note: The M2c Live Preview check "an HTML block that renders nothing keeps its source" looks through the new wrapper (it failed until then). Checked in Chromium: the grip sits in the pane margin; an item's grip left of its bullet.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm lint && pnpm typecheck && pnpm check:i18n`
Expected: PASS — `Test Files  83 passed (83)`, `Tests  821 passed (821)`; lint, types and i18n clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/editor/BlockGutter.module.css apps/desktop/src/features/editor/BlockGutter.test.tsx apps/desktop/src/features/editor/BlockGutter.tsx apps/desktop/src/features/editor/Editor.module.css apps/desktop/src/features/editor/Editor.tsx apps/desktop/src/features/editor/livePreview.ts apps/desktop/src/features/preview/Preview.tsx apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json apps/desktop/src/markdown/sanitize.test.ts apps/desktop/src/markdown/sanitize.ts
git commit -F - <<'MSG'
feat(editor): the Split pane's block gutter — grip, Move up/down, Indent/Outdent, keyboard moves and pick-up (M4 §4, §5)

The deepest block under the pointer shows a grip (its buttons open on
hover or focus); a list shows its own from its margin. One tab stop:
Up/Down go from block to block, Alt+arrows move, Enter picks a block up
to choose its place. Moves are announced; the moved block keeps the
keyboard and flashes. HTML blocks get a wrapper carrying their source
range so they have a gutter too.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 7: Dragging a block by its grip: drop line, list level by pointer, auto-scroll, Escape, Alt

Spec §4 (amendment 7).

**Files:**
- Modify: `apps/desktop/src/features/editor/BlockGutter.module.css`
- Modify: `apps/desktop/src/features/editor/BlockGutter.test.tsx`
- Modify: `apps/desktop/src/features/editor/BlockGutter.tsx`

**Interfaces:**
- Consumes: Task 6.
- Produces: grip `onPointerDown` drag (pointer events, 4 px threshold, window listeners), `data-drop-line`, a ghost label, auto-scroll within 40 px of the pane edges.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/features/editor/BlockGutter.test.tsx` (apply this change):

````diff
@@ -116,3 +116,105 @@ describe('the block gutter in the Split pane (M4 §4)', () => {
     expect(violations).toEqual([]);
   });
 });
+
+/** jsdom has no layout: blocks 20 px tall, 30 px apart, items 24 px in. */
+function layout(pane: HTMLElement) {
+  pane.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
+  let y = 0;
+  for (const el of pane.querySelectorAll<HTMLElement>('[data-source-start]')) {
+    if (el.tagName === 'P' && el.closest('li')) continue;
+    const top = y;
+    const left = el.tagName === 'LI' ? 40 : 16;
+    el.getBoundingClientRect = () => new DOMRect(left, top, 500, 20);
+    y += 30;
+  }
+}
+const pointer = (
+  target: EventTarget,
+  type: string,
+  x: number,
+  y: number,
+  init: PointerEventInit = {},
+) =>
+  act(() => {
+    target.dispatchEvent(
+      new PointerEvent(type, {
+        bubbles: true,
+        cancelable: true,
+        clientX: x,
+        clientY: y,
+        button: 0,
+        ...init,
+      }),
+    );
+  });
+
+describe('dragging a block (M4 §4)', () => {
+  it('acceptance: drag P3 above P1, and the source follows', async () => {
+    const pane = await split('P1\n\nP2\n\nP3\n');
+    layout(pane);
+    await hover(block(pane, 'P3'));
+    const g = grip('P3');
+    await pointer(g, 'pointerdown', 4, 61);
+    await pointer(window, 'pointermove', 4, 30);
+    await pointer(window, 'pointermove', 4, 2);
+    expect(document.querySelector('[data-drop-line]')).not.toBeNull();
+    await pointer(window, 'pointerup', 4, 2);
+    expect(source()).toBe('P3\n\nP1\n\nP2\n');
+    expect(status()).toBe('Moved P3.');
+    expect(document.querySelector('[data-drop-line]')).toBeNull();
+  });
+
+  it('Escape cancels a drag; a click without a drag moves nothing', async () => {
+    const pane = await split('P1\n\nP2\n\nP3\n');
+    layout(pane);
+    await hover(block(pane, 'P3'));
+    await pointer(grip('P3'), 'pointerdown', 4, 61);
+    await pointer(window, 'pointermove', 4, 2);
+    await act(() => fireEvent.keyDown(window, { key: 'Escape' }));
+    expect(document.querySelector('[data-drop-line]')).toBeNull();
+    await pointer(window, 'pointerup', 4, 2);
+    expect(source()).toBe('P1\n\nP2\n\nP3\n');
+    expect(status()).toBe('Move cancelled.');
+    await pointer(grip('P3'), 'pointerdown', 4, 61);
+    await pointer(window, 'pointerup', 5, 62);
+    expect(source()).toBe('P1\n\nP2\n\nP3\n');
+  });
+
+  it('a list item goes to the level under the pointer', async () => {
+    const pane = await split('- a\n- b\n- c\n');
+    layout(pane);
+    await hover(block(pane, 'c'));
+    await pointer(grip('c'), 'pointerdown', 20, 91);
+    // Just under `a`, right of its text column: nested under it.
+    await pointer(window, 'pointermove', 70, 52);
+    await pointer(window, 'pointerup', 70, 52);
+    expect(source()).toBe('- a\n  - c\n- b\n');
+  });
+
+  it('dragging near the bottom edge scrolls the pane', async () => {
+    const pane = await split('P1\n\nP2\n\nP3\n');
+    layout(pane);
+    let top = 0;
+    Object.defineProperty(pane, 'scrollTop', {
+      configurable: true,
+      get: () => top,
+      set: (v: number) => (top = v),
+    });
+    await hover(block(pane, 'P1'));
+    await pointer(grip('P1'), 'pointerdown', 4, 1);
+    await pointer(window, 'pointermove', 4, 395);
+    await vi.waitFor(() => expect(top).toBeGreaterThan(20));
+    await pointer(window, 'pointerup', 4, 395);
+  });
+
+  it('Alt held at the drop moves a heading without its section', async () => {
+    const pane = await split('# A\n\npa\n\n# B\n\npb\n');
+    layout(pane);
+    await hover(block(pane, 'A'));
+    await pointer(grip('A'), 'pointerdown', 4, 1);
+    await pointer(window, 'pointermove', 4, 115, { altKey: true });
+    await pointer(window, 'pointerup', 4, 115, { altKey: true });
+    expect(source()).toBe('pa\n\n# B\n\npb\n\n# A\n');
+  });
+});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/BlockGutter.test.tsx`
Expected: FAIL — the 4 drag tests (no drop line; source unchanged). The auto-scroll test fails with the scroll switched off.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/editor/BlockGutter.module.css` (apply this change):

````diff
@@ -108,3 +108,21 @@
   clip-path: inset(50%);
   white-space: nowrap;
 }
+
+/* The block being dragged, following the pointer. */
+.ghost {
+  position: fixed;
+  z-index: 20;
+  max-width: 240px;
+  padding: 4px 10px;
+  border: 1px solid var(--color-border);
+  border-radius: var(--radius-sm);
+  background: var(--color-surface);
+  box-shadow: var(--shadow-card);
+  color: var(--color-text-strong);
+  font: 500 13px var(--font-body);
+  white-space: nowrap;
+  overflow: hidden;
+  text-overflow: ellipsis;
+  pointer-events: none;
+}
````

Modify `apps/desktop/src/features/editor/BlockGutter.tsx` (apply this change):

````diff
@@ -11,7 +11,8 @@ import {
   useMemo,
   useRef,
   useState,
-  type KeyboardEvent,
+  type KeyboardEvent as ReactKeyboardEvent,
+  type PointerEvent as ReactPointerEvent,
   type RefObject,
 } from 'react';
 import { useTranslation } from 'react-i18next';
@@ -173,6 +174,19 @@ export function BlockGutter({
   const focusNext = useRef(false);
   /** After a move: the offset the moved block starts at in the new text. */
   const movedAt = useRef<number | null>(null);
+  /** A pointer drag in progress (M4 §4): which block, and where it would land. */
+  const [dragging, setDragging] = useState<{
+    id: number;
+    slot: Slot | null;
+    x: number;
+    y: number;
+  } | null>(null);
+  // What the window listeners of a drag read.
+  const live = useRef<{
+    model: BlockModel | null;
+    anchors: Map<number, HTMLElement>;
+    move: (id: number, slot: Slot | null, lineOnly?: boolean) => void;
+  }>({ model, anchors, move: () => undefined });
 
   // The rendered elements of the version shown (the pane commits first).
   useLayoutEffect(() => {
@@ -252,6 +266,93 @@ export function BlockGutter({
     setStatus(t('editor.blocks.moved', { block: label }));
   };
 
+  live.current = { model, anchors, move };
+
+  /** The slot nearest to the pointer: by height, and for list levels also by
+   *  how far right the pointer is. */
+  const nearest = (id: number, lineOnly: boolean, x: number, y: number): Slot | null => {
+    const { model: m, anchors: a } = live.current;
+    const p = pane.current;
+    if (!m || !p) return null;
+    const pr = p.getBoundingClientRect();
+    const cx = x - pr.left + p.scrollLeft;
+    const cy = y - pr.top + p.scrollTop;
+    let best: { slot: Slot; d: number } | null = null;
+    for (const slot of slotsFor(m, m.units[id], lineOnly)) {
+      const line = slotLine(p, m, slot, a);
+      if (!line) continue;
+      const nested = slot.scope === 'item' || slot.scope === 'child';
+      const d = Math.abs(cy - line.top) + (nested ? 0.3 * Math.abs(cx - line.left) : 0);
+      if (!best || d < best.d) best = { slot, d };
+    }
+    return best?.slot ?? null;
+  };
+
+  /** Pressing a grip: past 4 px it's a drag; Escape cancels; the drop moves
+   *  the block (Alt held: a heading without its section). */
+  const startDrag = (e: ReactPointerEvent, id: number) => {
+    if (e.button !== 0 || !live.current.model) return;
+    const unit = live.current.model.units[id];
+    const from = { x: e.clientX, y: e.clientY };
+    let started = false;
+    let last: { slot: Slot | null; lineOnly: boolean } = { slot: null, lineOnly: false };
+    let frame = 0;
+    let lastY = e.clientY;
+    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
+    const scroll = () => {
+      const p = pane.current;
+      frame = 0;
+      if (!p || !started) return;
+      const r = p.getBoundingClientRect();
+      const edge = 40;
+      const speed =
+        lastY < r.top + edge
+          ? -(r.top + edge - lastY) / 3
+          : lastY > r.bottom - edge
+            ? (lastY - (r.bottom - edge)) / 3
+            : 0;
+      if (speed) {
+        p.scrollTop += speed;
+        frame = requestAnimationFrame(scroll);
+      }
+    };
+    const onMove = (ev: PointerEvent) => {
+      if (!started && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 4) return;
+      started = true;
+      lastY = ev.clientY;
+      const lineOnly = ev.altKey && unit.kind === 'heading';
+      last = { slot: nearest(id, lineOnly, ev.clientX, ev.clientY), lineOnly };
+      setDragging({ id, slot: last.slot, x: ev.clientX, y: ev.clientY });
+      if (!frame) frame = requestAnimationFrame(scroll);
+    };
+    const stop = () => {
+      window.removeEventListener('pointermove', onMove);
+      window.removeEventListener('pointerup', onUp);
+      window.removeEventListener('keydown', onEscape);
+      if (frame) cancelAnimationFrame(frame);
+      setDragging(null);
+    };
+    const onUp = (ev: PointerEvent) => {
+      stop();
+      if (!started) return;
+      const lineOnly = ev.altKey && unit.kind === 'heading';
+      const slot =
+        lineOnly === last.lineOnly ? last.slot : nearest(id, lineOnly, ev.clientX, ev.clientY);
+      live.current.move(id, slot, lineOnly);
+    };
+    const onEscape = (ev: KeyboardEvent) => {
+      if (ev.key !== 'Escape') return;
+      ev.preventDefault();
+      started = false;
+      stop();
+      // The release that follows drops nothing: its listener is gone.
+      setStatus(t('editor.blocks.cancelled'));
+    };
+    window.addEventListener('pointermove', onMove);
+    window.addEventListener('pointerup', onUp);
+    window.addEventListener('keydown', onEscape);
+  };
+
   const describe = (slot: Slot): string => {
     switch (slot.scope) {
       case 'top':
@@ -271,7 +372,7 @@ export function BlockGutter({
     }
   };
 
-  const onKey = (e: KeyboardEvent, id: number) => {
+  const onKey = (e: ReactKeyboardEvent, id: number) => {
     if (!model) return;
     const unit = model.units[id];
     if (picking) {
@@ -338,7 +439,8 @@ export function BlockGutter({
       ...(picking ? [picking.unit] : []),
     ]),
   ];
-  const drop = picking ? slotLine(p, model, picking.slots[picking.index], anchors) : null;
+  const dropSlot = picking ? picking.slots[picking.index] : (dragging?.slot ?? null);
+  const drop = dropSlot ? slotLine(p, model, dropSlot, anchors) : null;
 
   return (
     <div ref={layer} className={styles.layer}>
@@ -351,7 +453,16 @@ export function BlockGutter({
       {flash !== null && anchors.get(flash) && (
         <div className={styles.flash} style={placeOf(anchors.get(flash)!)} aria-hidden="true" />
       )}
-      {drop && <div className={styles.drop} style={drop} aria-hidden="true" />}
+      {drop && <div className={styles.drop} style={drop} aria-hidden="true" data-drop-line="" />}
+      {dragging && (
+        <div
+          className={styles.ghost}
+          style={{ left: dragging.x + 12, top: dragging.y + 8 }}
+          aria-hidden="true"
+        >
+          {name(dragging.id)}
+        </div>
+      )}
       {visible.map((id) => {
         const el = anchors.get(id);
         if (!el) return null;
@@ -401,6 +512,7 @@ export function BlockGutter({
               aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Enter"
               onFocus={() => setCurrent(id)}
               onKeyDown={(e) => onKey(e, id)}
+              onPointerDown={(e) => startDrag(e, id)}
             >
               <svg
                 width="12"
````

Note: jsdom has no layout: the tests give each block a 20 px box, 30 px apart.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor && pnpm lint && pnpm typecheck`
Expected: PASS — `Tests  133 passed (133)` (then 134 with the auto-scroll test).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/editor/BlockGutter.module.css apps/desktop/src/features/editor/BlockGutter.test.tsx apps/desktop/src/features/editor/BlockGutter.tsx
git commit -F - <<'MSG'
feat(editor): drag a block by its grip — drop line, list level by pointer position, auto-scroll, Escape, Alt for a heading's line (M4 §4)

Pointer events, not HTML5 drag and drop (Tauri's native drag handling
takes those).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 8: A one-time hint above the Split panes

Spec §4 (amendment 8).

**Files:**
- Modify: `apps/desktop/src/features/editor/BlockGutter.module.css`
- Modify: `apps/desktop/src/features/editor/Editor.tsx`
- Create: `apps/desktop/src/features/editor/SplitHint.test.tsx`
- Create: `apps/desktop/src/features/editor/SplitHint.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

**Interfaces:**
- Consumes: `CloseIcon`.
- Produces: `SplitHint`, `HINT_KEY = "liber.blockHintDismissed"`; i18n `editor.blocks.{hint,dismissHint}`.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/src/features/editor/SplitHint.test.tsx`:

````tsx
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';
import { HINT_KEY } from './SplitHint';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
async function editor(mode: 'split' | 'source') {
  fakeDisk({ 'H.md': 'text\n' });
  const res = await PageDoc.load('H.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  return render(<Editor doc={res.value} mode={mode} label="H" />);
}
const HINT = 'Drag blocks in the preview to reorder them; the Markdown on the left follows.';

beforeEach(() => localStorage.clear());
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe('the Split hint (M4 §4)', () => {
  it('shows once in Split, until dismissed', async () => {
    const view = await editor('split');
    expect(screen.getByText(HINT)).toBeInTheDocument();
    await act(() => screen.getByRole('button', { name: 'Dismiss the hint' }).click());
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(localStorage.getItem(HINT_KEY)).toBe('1');
    view.unmount();
    await editor('split');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('is not shown in Source', async () => {
    await editor('source');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('works without storage (a blocked localStorage)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await editor('split');
    expect(screen.getByText(HINT)).toBeInTheDocument();
    await act(() => screen.getByRole('button', { name: 'Dismiss the hint' }).click());
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/SplitHint.test.tsx`
Expected: FAIL — `Failed to resolve import "./SplitHint"`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/editor/BlockGutter.module.css` (apply this change):

````diff
@@ -126,3 +126,36 @@
   text-overflow: ellipsis;
   pointer-events: none;
 }
+
+/* The one-time hint above the Split panes (from the prototype). */
+.hint {
+  display: flex;
+  align-items: center;
+  gap: 10px;
+  padding: 6px 12px 6px 20px;
+  border-bottom: 1px solid var(--color-border);
+  background: var(--color-surface-subtle);
+  color: var(--color-text-muted);
+  font: 500 13px var(--font-body);
+}
+
+.hint > span {
+  flex: 1;
+}
+
+.hintClose {
+  display: inline-grid;
+  place-items: center;
+  width: 28px;
+  height: 28px;
+  border: 0;
+  border-radius: var(--radius-sm);
+  background: transparent;
+  color: var(--color-text-muted);
+  cursor: pointer;
+}
+
+.hintClose:hover {
+  background: var(--color-surface);
+  color: var(--color-text-strong);
+}
````

Modify `apps/desktop/src/features/editor/Editor.tsx` (apply this change):

````diff
@@ -16,6 +16,7 @@ import styles from './Editor.module.css';
 import { followLinkAtCursor, livePreview, pagePath } from './livePreview';
 import { attachmentHandlers } from './attachments';
 import { BlockGutter, type Shown } from './BlockGutter';
+import { SplitHint } from './SplitHint';
 import { activeFormats, editorKeymap, type ActiveFormat } from './format';
 import { linkCompletion } from './linkComplete';
 import { LinkPicker } from './LinkPicker';
@@ -366,6 +367,7 @@ export function Editor({ doc, mode, label }: EditorProps) {
     <div className={styles.frame}>
       {showToolbar && toolbarView && <Toolbar view={toolbarView} active={active} />}
       {picker && toolbarView && <LinkPicker view={toolbarView} onClose={() => setPicker(false)} />}
+      {split && <SplitHint />}
       <div className={split ? styles.split : styles.single}>
         <div ref={host} className={mode === 'livePreview' ? styles.live : styles.source} />
         {split && (
````

Create `apps/desktop/src/features/editor/SplitHint.tsx`:

````tsx
// A one-time hint above the Split panes (M4 §4, from the prototype): blocks
// in the preview can be dragged. Dismissing it is remembered in this
// browser's storage — a hint seen again after storage is cleared costs
// nothing, so it isn't a setting.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '../../app/icons';
import styles from './BlockGutter.module.css';

export const HINT_KEY = 'liber.blockHintDismissed';

function dismissed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function SplitHint() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(dismissed);
  if (hidden) return null;
  return (
    <div className={styles.hint}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="9" cy="6" r="1.8" />
        <circle cx="15" cy="6" r="1.8" />
        <circle cx="9" cy="12" r="1.8" />
        <circle cx="15" cy="12" r="1.8" />
        <circle cx="9" cy="18" r="1.8" />
        <circle cx="15" cy="18" r="1.8" />
      </svg>
      <span>{t('editor.blocks.hint')}</span>
      <button
        type="button"
        className={styles.hintClose}
        aria-label={t('editor.blocks.dismissHint')}
        title={t('editor.blocks.dismissHint')}
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(HINT_KEY, '1');
          } catch {
            // Shown again next time; nothing else depends on it.
          }
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
````

Modify `apps/desktop/src/i18n/locales/en.json` (apply this change):

````diff
@@ -148,7 +148,9 @@
         "html": "HTML block",
         "columns": "Columns",
         "other": "Block"
-      }
+      },
+      "hint": "Drag blocks in the preview to reorder them; the Markdown on the left follows.",
+      "dismissHint": "Dismiss the hint"
     }
   },
   "preview": {
````

Modify `apps/desktop/src/i18n/locales/es.json` (apply this change):

````diff
@@ -148,7 +148,9 @@
         "html": "Bloque HTML",
         "columns": "Columnas",
         "other": "Bloque"
-      }
+      },
+      "hint": "Arrastra los bloques en la vista previa para reordenarlos; el Markdown de la izquierda los sigue.",
+      "dismissHint": "Cerrar la sugerencia"
     }
   },
   "preview": {
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 && pnpm lint && pnpm typecheck && pnpm check:i18n`
Expected: PASS — `Test Files  84 passed (84)`, `Tests  829 passed (829)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/editor/BlockGutter.module.css apps/desktop/src/features/editor/Editor.tsx apps/desktop/src/features/editor/SplitHint.test.tsx apps/desktop/src/features/editor/SplitHint.tsx apps/desktop/src/i18n/locales/en.json apps/desktop/src/i18n/locales/es.json
git commit -F - <<'MSG'
feat(editor): a one-time hint above the Split panes — blocks in the preview can be dragged (M4 §4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 9: After a move the pane shows it at once; gutter keys wait while it lags

Spec §4 (amendment 6).

**Files:**
- Modify: `apps/desktop/src/features/editor/BlockGutter.test.tsx`
- Modify: `apps/desktop/src/features/editor/BlockGutter.tsx`
- Modify: `apps/desktop/src/features/editor/Editor.tsx`
- Modify: `apps/desktop/src/features/preview/Preview.tsx`

**Interfaces:**
- Consumes: Tasks 6–7.
- Produces: `Preview` prop `delay` (0 after a block move); the Editor tells the pane when a transaction is a `move.block`; the gutter ignores keys while `shown.text` differs from the editor and cancels a pick-up on changed blocks.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/features/editor/BlockGutter.test.tsx` (apply this change):

````diff
@@ -89,6 +89,24 @@ describe('the block gutter in the Split pane (M4 §4)', () => {
     expect(status()).toBe('Moved P2.');
   });
 
+  it('after a move the pane shows it at once; a key while the pane lags the editor does nothing', async () => {
+    const pane = await split('P1\n\nP2\n\nP3\n');
+    act(() => grip('P1').focus());
+    await key(grip('P1'), 'ArrowDown');
+    await key(grip('P2'), 'ArrowUp', { altKey: true });
+    // Well within the 150 ms render delay for typing.
+    await act(() => new Promise((r) => setTimeout(r, 30)));
+    expect(pane.querySelector('[data-source-start]')!.textContent).toBe('P2');
+    await vi.waitFor(() => expect(grip('P2')).toHaveFocus());
+    // Typing reaches the pane only after its delay: meanwhile a gutter key
+    // would act on blocks that have changed, so it does nothing.
+    act(() => viewOf().dispatch({ changes: { from: viewOf().state.doc.length, insert: 'x' } }));
+    await key(grip('P2'), 'ArrowDown', { altKey: true });
+    await key(grip('P2'), 'Enter');
+    expect(source()).toBe('P2\n\nP1\n\nP3\nx');
+    expect(status()).toBe('Moved P2.');
+  });
+
   it('Enter picks a block up: arrows choose a place, Enter drops it; Escape cancels', async () => {
     await split('P1\n\nP2\n\nP3\n');
     act(() => grip('P1').focus());
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/BlockGutter.test.tsx`
Expected: FAIL — without the immediate render: `expected 'P1' to be 'P2'`; without the key guard: `expected 'P2 picked up. Arrow keys choose where…' to be 'Moved P2.'`. (Found by the e2e of Task 10: keys right after a move acted on the old blocks, so a pick-up dropped nothing.)

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/editor/BlockGutter.tsx` (apply this change):

````diff
@@ -220,6 +220,16 @@ export function BlockGutter({
     return () => clearTimeout(timer);
   }, [model, anchors]);
 
+  // A pick-up made on blocks that have since changed is off.
+  const pickedOn = useRef<BlockModel | null>(null);
+  useEffect(() => {
+    if (picking && pickedOn.current && pickedOn.current !== model) {
+      setPicking(null);
+      setStatus(t('editor.blocks.cancelled'));
+    }
+    pickedOn.current = model;
+  }, [model, picking, t]);
+
   // The grip with the keyboard follows `current`.
   useEffect(() => {
     if (!focusNext.current || tabStop === null) return;
@@ -373,7 +383,13 @@ export function BlockGutter({
   };
 
   const onKey = (e: ReactKeyboardEvent, id: number) => {
-    if (!model) return;
+    if (!model || !shown) return;
+    // Until the pane shows the editor's text (a move a moment ago), a key
+    // would act on blocks that have moved: it waits.
+    if (view.state.doc.toString() !== shown.text) {
+      if (e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === ' ') e.preventDefault();
+      return;
+    }
     const unit = model.units[id];
     if (picking) {
       if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
@@ -447,9 +463,9 @@ export function BlockGutter({
       <div className={styles.srOnly} role="status" data-block-status="">
         {status}
       </div>
-      <p id="block-gutter-help" className={styles.srOnly}>
+      <span id="block-gutter-help" className={styles.srOnly}>
         {t('editor.blocks.help')}
-      </p>
+      </span>
       {flash !== null && anchors.get(flash) && (
         <div className={styles.flash} style={placeOf(anchors.get(flash)!)} aria-hidden="true" />
       )}
````

Modify `apps/desktop/src/features/editor/Editor.tsx` (apply this change):

````diff
@@ -28,7 +28,7 @@ import { hideView, pageDocOf, showView, storedState, storeState } from './views'
 import { toggleTaskIn } from './widgets';
 
 /** The Split pane of the component currently showing each view. */
-const paneOf = new WeakMap<EditorView, (text: string) => void>();
+const paneOf = new WeakMap<EditorView, (text: string, now: boolean) => void>();
 /** The toolbar's pressed state of the component currently showing each view. */
 const toolbarOf = new WeakMap<EditorView, (state: EditorState) => void>();
 const modeSlot = new Compartment();
@@ -210,7 +210,12 @@ function createState(d: PageDoc, mode: EditorMode, label: string, numbers: boole
         if (!u.docChanged) return;
         const next = u.state.doc.toString();
         u.state.facet(pageDocOf)?.edit(next);
-        paneOf.get(u.view)?.(next);
+        // A block move shows in the pane at once (its gutter acts on what
+        // the pane shows, M4 §4); typing waits for the render delay.
+        paneOf.get(u.view)?.(
+          next,
+          u.transactions.some((tr) => tr.isUserEvent('move.block')),
+        );
       }),
     ],
   });
@@ -233,6 +238,11 @@ export function Editor({ doc, mode, label }: EditorProps) {
   const split = mode === 'split';
   // The text for the Split pane (cheap to track: the pane renders only in Split).
   const [text, setText] = useState(doc.text);
+  const [renderNow, setRenderNow] = useState(false);
+  const toPane = useCallback((next: string, now: boolean) => {
+    setText(next);
+    setRenderNow(now);
+  }, []);
   const showToolbar = useSettingsStore((s) => s.settings.toolbar);
   const showNumbers = useSettingsStore((s) => s.settings.lineNumbers);
   const [toolbarView, setToolbarView] = useState<EditorView | null>(null);
@@ -251,7 +261,7 @@ export function Editor({ doc, mode, label }: EditorProps) {
     const v = new EditorView({ parent: host.current!, state: stateFor(current.current) });
     view.current = v;
     showView(current.current, v);
-    paneOf.set(v, setText);
+    paneOf.set(v, toPane);
     toolbarOf.set(v, showFormats);
     setToolbarView(v);
     setLinkPickerOpener(v, () => setPicker(true));
@@ -378,6 +388,7 @@ export function Editor({ doc, mode, label }: EditorProps) {
               path={doc.path}
               onToggleTask={toggleTask}
               onRendered={onRendered}
+              delay={renderNow ? 0 : undefined}
             />
           </div>
         )}
````

Modify `apps/desktop/src/features/preview/Preview.tsx` (apply this change):

````diff
@@ -36,6 +36,9 @@ export interface PreviewProps {
   /** Called with the text and model each time the pane shows a new version
    *  (the Split pane's block gutter, M4 §4, maps blocks by their offsets). */
   onRendered?: (text: string, page: ParsedPage) => void;
+  /** Render delay after a change (default RENDER_DEBOUNCE_MS; 0 after a
+   *  block move). */
+  delay?: number;
 }
 
 /** The rendered pane (M2a §4): sanitized Markdown with resolved links and
@@ -57,9 +60,10 @@ function PreviewBody({
   embedded = false,
   onToggleTask,
   onRendered,
+  delay = RENDER_DEBOUNCE_MS,
 }: PreviewProps) {
   const { t } = useTranslation();
-  const shown = useDebounced(text, RENDER_DEBOUNCE_MS);
+  const shown = useDebounced(text, delay);
   const page = useParsed(shown);
   const tree = useMemo(() => {
     const part = heading
````

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/BlockGutter.test.tsx`
Expected: PASS — `Tests  12 passed (12)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/editor/BlockGutter.test.tsx apps/desktop/src/features/editor/BlockGutter.tsx apps/desktop/src/features/editor/Editor.tsx apps/desktop/src/features/preview/Preview.tsx
git commit -F - <<'MSG'
fix(editor): after a block move the pane shows it at once; gutter keys wait while the pane lags the editor (M4 §4)

Found by the end-to-end test: keys pressed right after a move acted on
the blocks the pane still showed (its render delay is 150 ms), so a
pick-up dropped nothing. A move now renders the pane immediately, a key
arriving before it does nothing, and a pick-up made on blocks that have
since changed is cancelled.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 10: End to end in Chromium and WebKit; zero network

Spec §7.

**Files:**
- Create: `apps/desktop/e2e/m4.spec.ts`
- Modify: `apps/desktop/e2e/zero-network.spec.ts`
- Modify: `apps/desktop/playwright.config.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `e2e/m4.spec.ts`; a zero-network case for moving blocks in Split; WebKit runs `m4` too.

- [ ] **Step 1: Write the failing test(s)**

Create `apps/desktop/e2e/m4.spec.ts`:

````ts
// M4 in the built UI, in Chromium and WebKit (≈ WKWebView): dragging blocks
// in the Split pane, keyboard moves, undo, and axe with a gutter showing.
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

async function open(page: Page, text: string, settings: Record<string, unknown> = {}) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(installIpcMock, {
    pages: { 'M.md': text },
    editorMode: 'split',
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name: 'M' }).click();
  const pane = page.getByRole('region', { name: 'Preview' });
  await expect(pane.locator('[data-source-start]').first()).toBeVisible();
  return pane;
}

/** The source as the editor shows it (the Split's left side). */
const source = (page: Page) =>
  page.locator('.cm-content').evaluate((el) =>
    [...el.querySelectorAll('.cm-line')]
      .map((l) => l.textContent)
      .join('\n')
      .trimEnd(),
  );

/** Drags the grip of the block `from` to the point (x, y) of the page. */
async function drag(page: Page, from: Locator, name: string, x: number, y: number) {
  await from.hover();
  const grip = page.getByRole('button', { name: `Drag to reorder: ${name}` });
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await expect(page.locator('[data-drop-line]')).toBeVisible();
  await page.mouse.up();
}

test('acceptance: P3 dragged above P1 reads P3, P1, P2; one undo restores the order', async ({
  page,
}) => {
  const pane = await open(page, 'P1 *one*\n\nP2\n\nP3 **three**\n');
  const p1 = (await pane.getByText('P1').boundingBox())!;
  await drag(page, pane.getByText('P3'), 'P3 three', p1.x + 40, p1.y + 2);
  await expect.poll(() => source(page)).toBe('P3 **three**\n\nP1 *one*\n\nP2');
  await expect(page.getByRole('status').filter({ hasText: 'Moved P3 three.' })).toBeAttached();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => source(page)).toBe('P1 *one*\n\nP2\n\nP3 **three**');
});

test('acceptance: a heading dragged below the next section takes its paragraphs along', async ({
  page,
}) => {
  const pane = await open(page, '## A\n\nA1\n\nA2\n\n## B\n\nB1\n');
  const b1 = (await pane.getByText('B1').boundingBox())!;
  await drag(page, pane.getByRole('heading', { name: 'A' }), 'A', b1.x + 40, b1.y + b1.height + 6);
  await expect.poll(() => source(page)).toBe('## B\n\nB1\n\n## A\n\nA1\n\nA2');
});

test('a list item dropped right of an item’s text nests under it', async ({ page }) => {
  const pane = await open(page, '- a\n- b\n- c\n');
  const a = (await pane.locator('li', { hasText: 'a' }).first().boundingBox())!;
  await drag(page, pane.locator('li', { hasText: 'c' }), 'c', a.x + 60, a.y + a.height - 1);
  await expect.poll(() => source(page)).toBe('- a\n  - c\n- b');
});

test('keyboard only: ↓ to the next block, Alt+↑ moves it, Enter picks a block up and drops it', async ({
  page,
}) => {
  const pane = await open(page, 'P1\n\nP2\n\nP3\n');
  await page.getByRole('button', { name: 'Drag to reorder: P1' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Drag to reorder: P2' })).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => source(page)).toBe('P2\n\nP1\n\nP3');
  // The pane shows the move (keys wait for it), and P2's grip keeps the keyboard.
  await expect(pane.locator('[data-source-start]').first()).toHaveText('P2');
  await expect(page.getByRole('button', { name: 'Drag to reorder: P2' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => source(page)).toBe('P1\n\nP3\n\nP2');
});

for (const theme of ['light', 'dark']) {
  test(`axe-clean with a block gutter open (${theme})`, async ({ page }) => {
    const pane = await open(page, '# T\n\nP1\n\n- a\n- b\n', { theme });
    await pane.locator('li', { hasText: 'b' }).hover();
    await page.getByRole('group', { name: 'b' }).hover();
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () => {
      const { axe } = window as unknown as {
        axe: {
          run: (
            el: Element,
            o: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      };
      const region = document.querySelector('[role="region"][aria-label="Preview"]')!;
      const res = await axe.run(region, { resultTypes: ['violations'] });
      return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
    });
    expect(violations).toEqual([]);
  });
}
````

Modify `apps/desktop/e2e/zero-network.spec.ts` (apply this change):

````diff
@@ -175,3 +175,21 @@ test('zero network requests: relationships in the Global View', async ({ page })
   expect(csp).toEqual([]);
   expect(outside).toEqual([]);
 });
+
+// M4: moving blocks in the Split pane loads nothing from outside either.
+test('zero network requests: moving blocks in Split', async ({ page }) => {
+  const { outside, problems } = await openRemotePage(page, 'split');
+  const pane = page.getByRole('region', { name: 'Preview' });
+  await expect(pane.locator('[data-source-start]').first()).toBeVisible();
+  const first = page.getByRole('button', { name: /^Drag to reorder:/ }).first();
+  await first.focus();
+  await page.keyboard.press('Alt+ArrowDown');
+  await page.waitForLoadState('networkidle');
+  await page.waitForTimeout(300);
+  const csp = await page.evaluate(
+    () => (window as unknown as { __liberCspViolations: string[] }).__liberCspViolations,
+  );
+  expect(problems).toEqual([]);
+  expect(csp).toEqual([]);
+  expect(outside).toEqual([]);
+});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vite build && PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test e2e/m4.spec.ts`
Expected: FAIL before Task 9 — the keyboard test in both engines (the pick-up dropped nothing: the source stayed `P2, P1, P3`).

- [ ] **Step 3: Implement**

Modify `apps/desktop/playwright.config.ts` (apply this change):

````diff
@@ -13,7 +13,7 @@ export default defineConfig({
     {
       name: 'webkit',
       use: { ...devices['Desktop Safari'], browserName: 'webkit' },
-      testMatch: /\/(checklist|m2b|m2c|m3a|m3a-a11y|m3a-perf|m3b)\.spec\.ts$/,
+      testMatch: /\/(checklist|m2b|m2c|m3a|m3a-a11y|m3a-perf|m3b|m4)\.spec\.ts$/,
     },
   ],
   webServer: {
````

Note: The keyboard test waits for the pane to show the move before the next keys, as a person would.

- [ ] **Step 4: Run them to see them pass**

Run: `PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test e2e/m4.spec.ts --repeat-each=3 && PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test e2e/zero-network.spec.ts`
Expected: PASS — `36 passed` (6 tests × 2 engines × 3); the zero-network cases pass. Full gate (`check.sh all`): vitest 830 (84 files), e2e 110, cargo/clippy/fmt/deny clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/m4.spec.ts apps/desktop/e2e/zero-network.spec.ts apps/desktop/playwright.config.ts
git commit -F - <<'MSG'
test(e2e): M4 in Chromium and WebKit — drag P3 above P1 and undo, a heading's section, a list level, keyboard only, axe, zero network

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 11: No Array.prototype.at in M4 code (Safari 15.0–15.3)

Spec Global Constraints (amendment 11).

**Files:**
- Modify: `apps/desktop/src/features/editor/BlockGutter.tsx`
- Modify: `apps/desktop/src/markdown/blockMoves.ts`

**Interfaces:**
- Consumes: Tasks 3 and 6.
- Produces: index access instead of `.at(-1)` in `blockMoves.ts` and `BlockGutter.tsx`.

- [ ] **Step 1: Run them to see them fail**

Run: `git diff afc11b9 -- apps/desktop/src | grep -n '^+.*\.at(' | grep -v 'test\.'`
Expected: three lines (two in `BlockGutter.tsx`, one in `blockMoves.ts`).

- [ ] **Step 2: Implement**

Modify `apps/desktop/src/features/editor/BlockGutter.tsx` (apply this change):

````diff
@@ -132,13 +132,15 @@ function slotLine(
     }
     case 'item': {
       if (slot.before !== null) return before(slot.before);
-      return after(model.lists[slot.list].items.at(-1)!);
+      const items = model.lists[slot.list].items;
+      return after(items[items.length - 1]);
     }
     case 'child':
       return after(slot.of, 24);
     case 'row': {
       if (slot.before !== null) return before(slot.before);
-      return after(model.tables[slot.table].rows.at(-1)!);
+      const rows = model.tables[slot.table].rows;
+      return after(rows[rows.length - 1]);
     }
   }
 }
````

Modify `apps/desktop/src/markdown/blockMoves.ts` (apply this change):

````diff
@@ -284,7 +284,8 @@ function itemMove(
     target = model.units[l.top];
     into = slot.list;
     loose = looseList(slot.list);
-    const ref = slot.before ?? l.items.filter((id) => id !== unit.id).at(-1)!;
+    const others = l.items.filter((id) => id !== unit.id);
+    const ref = slot.before ?? others[others.length - 1];
     indent = /^[ \t]*/.exec(lineText(model.units[ref].from))![0];
     insertAt = slot.before !== null ? spanIn(target, slot.before)[0] : spanIn(target, ref)[1] + 1;
     marker = l.ordered ? `1${l.marker}` : l.marker;
````

- [ ] **Step 3: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown src/features/editor`
Expected: PASS — `Tests  305 passed (305)`; the grep lists only a test file. Bundle scan: no new regex lookbehind, `color-mix(` or `structuredClone`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/features/editor/BlockGutter.tsx apps/desktop/src/markdown/blockMoves.ts
git commit -F - <<'MSG'
fix(editor): M4 code avoids Array.prototype.at (Safari 15.0–15.3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 12: Review focus: a later move in a 200 KB note — slots in linear time

Spec §6 (amendment 9).

**Files:**
- Modify: `apps/desktop/src/features/editor/blockCommands.test.ts`
- Modify: `apps/desktop/src/markdown/blockModel.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `slotsFor` takes the neighbour of a top-level slot from the ordered list (it searched back through every block, O(n²)).

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/features/editor/blockCommands.test.ts` (apply this change):

````diff
@@ -85,3 +85,19 @@ describe('moving blocks from the editor (M4 §5)', () => {
     expect(modelFor(v.state)).toBe(modelFor(v.state));
   });
 });
+
+describe('a large note (review focus)', () => {
+  it('after the first, Alt+↑ in a 200 KB note takes well under 100 ms (the model re-parses incrementally)', async () => {
+    let note = '';
+    for (let i = 0; note.length < 200_000; i++) {
+      note += `## Section ${i}\n\nParagraph ${i} with **bold** and [[link]].\n\n`;
+    }
+    note += '- a\n- b\n- c\n';
+    const v = editor(note, note.length - 2);
+    await press(v, 'ArrowUp', { altKey: true }); // the first move parses the note
+    const t = performance.now();
+    await press(v, 'ArrowUp', { altKey: true });
+    expect(performance.now() - t).toBeLessThan(100);
+    expect(text(v).endsWith('- c\n- a\n- b\n')).toBe(true);
+  }, 30_000);
+});
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/blockCommands.test.ts`
Expected: FAIL — `after the first, Alt+↑ in a 200 KB note takes well under 100 ms` → `expected 145.9 to be less than 100`.

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/markdown/blockModel.ts` (apply this change):

````diff
@@ -276,12 +276,11 @@ export function slotsFor(model: BlockModel, unit: Unit, lineOnly = false): Slot[
         : null;
   const all = topUnits(model);
   const nextAfter = all.find((u) => u.from > spanTo && !skip.has(u.id));
-  const prevOf = (pos: number) => [...tops].reverse().find((u) => u.to <= pos);
-  const topSlot = (before: Unit | null) => {
+  // `tops` is in order, so the block before a slot is the one before it.
+  const topSlot = (before: Unit | null, prev: Unit | undefined) => {
     if (unit.scope === 'top' && (before?.id ?? null) === (nextAfter?.id ?? null)) return;
     if (unit.scope === 'top' && before?.id === unit.id) return;
     if (ownKind) {
-      const prev = prevOf(before ? before.from : Number.MAX_SAFE_INTEGER);
       if (
         topListKind(model, prev) === ownKind ||
         topListKind(model, before ?? undefined) === ownKind
@@ -290,8 +289,8 @@ export function slotsFor(model: BlockModel, unit: Unit, lineOnly = false): Slot[
     }
     out.push({ scope: 'top', before: before?.id ?? null });
   };
-  for (const u of tops) topSlot(u);
-  topSlot(null);
+  tops.forEach((u, k) => topSlot(u, tops[k - 1]));
+  topSlot(null, tops[tops.length - 1]);
 
   if (unit.scope !== 'item') return out;
````

Note: The first move in a large note opened in Source still pays a full parse (~1.5 s in jsdom at 200 KB): a known gap.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown src/features/editor/blockCommands.test.ts`
Expected: PASS — `Tests  175 passed (175)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/editor/blockCommands.test.ts apps/desktop/src/markdown/blockModel.ts
git commit -F - <<'MSG'
perf(markdown): drop slots in linear time — a later move in a 200 KB note stays well under 100 ms (M4 review focus)

Each top-level slot looked back through every block for its neighbour
(O(n²): ~110 ms for a list item in a 200 KB note).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 13: Review focus: embedded notes get no inner gutters; a refused move from the gutter; block names

Spec §4.

**Files:**
- Modify: `apps/desktop/src/features/editor/BlockGutter.test.tsx`
- Modify: `apps/desktop/src/features/editor/BlockGutter.tsx`
- Modify: `apps/desktop/src/test/fakeDisk.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces: `summaryOf` reads `[[target|alias]]` / `![[embed]]` / `[text](url)` as their text; the test disk resolves wiki targets to pages it holds.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/src/features/editor/BlockGutter.test.tsx` (apply this change):

````diff
@@ -3,6 +3,7 @@ import { act, fireEvent, render, screen, within } from '@testing-library/react';
 import axe from 'axe-core';
 import { afterEach, describe, expect, it, vi } from 'vitest';
 import { clearMocks } from '../../ipc/testing';
+import { useToastStore } from '../../stores/toastStore';
 import { fakeDisk } from '../../test/fakeDisk';
 import { Editor } from './Editor';
 import { PageDoc } from './pageDoc';
@@ -125,6 +126,36 @@ describe('the block gutter in the Split pane (M4 §4)', () => {
     expect(source()).toBe('P2\n\nP3\n\nP1\n');
   });
 
+  it('review focus: blocks of an embedded note get no gutter; the embed itself does', async () => {
+    // The embedded note's paragraph starts at offset 12, like this page's P2:
+    // its offsets must never be taken for the page's.
+    fakeDisk({
+      'B.md': '![[Other]]\n\nP2\n',
+      'Other.md': '# Other no\n\nInside the other note.\n',
+    });
+    const res = await PageDoc.load('B.md', hooks);
+    if (!res.ok) throw new Error(res.error.message);
+    render(<Editor doc={res.value} mode="split" label="B" />);
+    const pane = await screen.findByRole('region', { name: 'Preview' });
+    const inner = await within(pane).findByText('Inside the other note.');
+    // The gutter maps blocks again once the embed has loaded (any change).
+    act(() => viewOf().dispatch({ changes: { from: viewOf().state.doc.length, insert: '\n' } }));
+    await act(() => new Promise((r) => setTimeout(r, 200)));
+    await hover(inner);
+    expect(screen.queryByRole('group', { name: 'Inside the other note.' })).not.toBeInTheDocument();
+    expect(screen.queryByRole('group', { name: 'P2' })).not.toBeInTheDocument();
+    expect(screen.getByRole('group', { name: 'Other' })).toBeInTheDocument();
+  });
+
+  it('review focus: a move the guard refuses changes nothing and says why', async () => {
+    const pane = await split('- a\n\nPara\n\n- b\n');
+    await hover(block(pane, 'Para'));
+    const down = within(opened('Para')).getByRole('button', { name: 'Move down' });
+    await act(() => down.click());
+    expect(source()).toBe('- a\n\nPara\n\n- b\n');
+    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('This block can’t be moved here.');
+  });
+
   it('NFR-10: no axe violations with a gutter showing', async () => {
     const pane = await split('# T\n\nP1\n\n- a\n- b\n');
     await hover(block(pane, 'b'));
````

Modify `apps/desktop/src/test/fakeDisk.ts` (apply this change):

````diff
@@ -113,7 +113,17 @@ export function fakeDisk(initial: Record<string, string>, extra: Extra = {}): Fa
         case 'vault_tree':
           return [...files.keys()].map((path) => ({ path, kind: 'page' }));
         case 'links_resolve':
-          return (raw as { targets: unknown[] }).targets.map(() => null);
+          // A wiki target names a page on the disk by its name (enough for
+          // embeds in tests); anything else resolves to nothing.
+          return (raw as { targets: { kind: string; target: string }[] }).targets.map(
+            ({ kind, target }) => {
+              if (kind !== 'wiki' && kind !== 'embed') return null;
+              const name = `${target.replace(/#.*$/, '')}.md`.toLowerCase();
+              return (
+                [...files.keys()].find((f) => f.split('/').pop()!.toLowerCase() === name) ?? null
+              );
+            },
+          );
         case 'settings_set':
           return { version: 1, ...(raw as { patch: object }).patch };
         default:
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/features/editor/BlockGutter.test.tsx`
Expected: FAIL — the embed's group was named "! Other" (`Unable to find … group "Other"`); with the `[data-note-embed]` filter removed the embedded-note pin fails (`expect(element).not.toBeInTheDocument()` — the other note's paragraph at offset 12 was taken for this page's P2).

- [ ] **Step 3: Implement**

Modify `apps/desktop/src/features/editor/BlockGutter.tsx` (apply this change):

````diff
@@ -87,6 +87,9 @@ export function summaryOf(text: string, unit: Unit, t: TFunction): string {
     .replace(/^[ \t>]*/, '')
     .replace(/^(#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/, '')
     .replace(/\[!(\w+)\][+-]?/, '$1')
+    // [[target|alias]] and ![[embed]] read as their alias or target; [text](url) as its text.
+    .replace(/!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
+    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
     .replace(/[*_`~=[\]|#]/g, ' ')
     .replace(/\s+/g, ' ')
     .trim();
````

Note: The pin types once after the embed loads: the gutter maps blocks again on the next render.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2`
Expected: PASS — `Test Files  84 passed (84)`, `Tests  834 passed (834)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/features/editor/BlockGutter.test.tsx apps/desktop/src/features/editor/BlockGutter.tsx apps/desktop/src/test/fakeDisk.ts
git commit -F - <<'MSG'
fix(editor): block names read links and embeds as their text; review focus pins for embedded notes and refused moves (M4 §4)

The gutter never takes an embedded note's blocks for the page's (their
offsets are the other note's). The test disk resolves wiki targets to
the pages it holds.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

### Task 14: Review focus: setext headings and ")"/0-based lists in the sweep; a drag in a scrolled pane

Spec §7.

**Files:**
- Modify: `apps/desktop/e2e/m4.spec.ts`
- Modify: `apps/desktop/src/markdown/blockMoves.sweep.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 10.
- Produces: the `variants` sweep note; the scrolled-drag e2e.

- [ ] **Step 1: Write the failing test(s)**

Modify `apps/desktop/e2e/m4.spec.ts` (apply this change):

````diff
@@ -31,6 +31,14 @@ const source = (page: Page) =>
       .trimEnd(),
   );
 
+/** The last text autosaved (the editor renders only the lines in view, so a
+ *  long note is read from what was written). */
+const saved = (page: Page) =>
+  page.evaluate(() => {
+    const writes = (window as unknown as { __liberWrites?: { text: string }[] }).__liberWrites ?? [];
+    return writes.length ? writes[writes.length - 1].text : null;
+  });
+
 /** Drags the grip of the block `from` to the point (x, y) of the page. */
 async function drag(page: Page, from: Locator, name: string, x: number, y: number) {
   await from.hover();
@@ -72,6 +80,29 @@ test('a list item dropped right of an item’s text nests under it', async ({ pa
   await expect.poll(() => source(page)).toBe('- a\n  - c\n- b');
 });
 
+test('review focus: in a scrolled pane, a drag near the top edge scrolls up and drops where the line shows', async ({
+  page,
+}) => {
+  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`);
+  const pane = await open(page, `${paras.join('\n\n')}\n`);
+  await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
+  const last = pane.getByText('Paragraph 40.');
+  await last.hover();
+  const grip = page.getByRole('button', { name: 'Drag to reorder: Paragraph 40.' });
+  const g = (await grip.boundingBox())!;
+  const box = (await pane.boundingBox())!;
+  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
+  await page.mouse.down();
+  await page.mouse.move(g.x + 40, box.y + 8, { steps: 6 });
+  // Held near the top edge, the pane scrolls up.
+  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeLessThan(200);
+  await page.mouse.up();
+  await expect.poll(() => saved(page)).not.toBeNull();
+  const lines = (await saved(page))!.trimEnd().split('\n\n');
+  expect(lines.indexOf('Paragraph 40.')).toBeLessThan(30);
+  expect([...lines].sort()).toEqual([...paras].sort());
+});
+
 test('keyboard only: ↓ to the next block, Alt+↑ moves it, Enter picks a block up and drops it', async ({
   page,
 }) => {
````

Modify `apps/desktop/src/markdown/blockMoves.sweep.test.ts` (apply this change):

````diff
@@ -92,6 +92,9 @@ const NOTES: Record<string, string> = {
     '- a\n\n- b\n  1. b1\n  2. b2\n\n- c\n\nPara\n\n1. one\n2. two\n3. three\n4. four\n5. five\n6. six\n7. seven\n8. eight\n9. nine\n   - nested\n10. ten\n',
 };
 NOTES.crlf = NOTES.everything.replace(/\n/g, '\r\n');
+// Review focus: setext headings, `)` and 0-based ordered lists, a task list.
+NOTES.variants =
+  'Title\n=====\n\nIntro.\n\nSub\n---\n\n0) zero\n1) one\n2) two\n\n- [ ] todo\n- [x] done\n\nEnd.\n';
 // Moves the guard must refuse: an indented code block after a list item
 // becomes part of it; taking `Para` away merges the two lists.
 NOTES.hazards = '- a\n\nPara\n\n- b\n\nP2\n\n    indented code\n\nTail\n';
````

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @liber/desktop exec vitest run --maxWorkers=2 src/markdown/blockMoves.sweep.test.ts && PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test e2e/m4.spec.ts -g scrolled`
Expected: PASS for the sweep (pins of working behaviour). The e2e first failed on its own helper: CodeMirror renders only the lines in view, so a long note is read from the last autosave instead.

- [ ] **Step 3: Run them to see them pass**

Run: `PLAYWRIGHT_BROWSERS_PATH=<browsers> pnpm --filter @liber/desktop exec playwright test e2e/m4.spec.ts --repeat-each=2`
Expected: PASS — `28 passed`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/m4.spec.ts apps/desktop/src/markdown/blockMoves.sweep.test.ts
git commit -F - <<'MSG'
test: M4 review focus — setext headings and ')'/0-based lists in the sweep; a drag in a scrolled pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
```

---

## Self-review

- **Spec coverage:** §1 acceptance → Tasks 2 (P3 above P1, sections, Alt), 5 (one undo), 10 (e2e); §2 → Task 1; §3 → Tasks 2–4 (+ guard, CRLF); §4 → Tasks 6–9 and 13; §5 → Tasks 5–6; §6 → Tasks 2, 9 and 12; §7 → every task's tests, the sweep (Task 4) and the e2e (Task 10). Deviations are in spec §10.
- **Placeholders:** none; every code step is the committed code.
- **Type consistency:** `Unit`, `Slot`, `BlockModel`, `Move`/`MoveResult`, `applyMove`, `modelFor`, `Shown` are used with the same names across tasks.
