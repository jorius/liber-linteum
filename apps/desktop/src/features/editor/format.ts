// Formatting commands (M2b §6): pure CodeMirror commands over the Markdown
// text — one transaction (one undo step) for every selection — plus the keys
// that run them with or without the toolbar.
import { defaultKeymap } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';
import { blockKeymap } from './blockCommands';
import { openLinkPicker } from './linkPickerOpen';

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'highlight' | 'code';
export type BlockFormat = 'bullet' | 'numbered' | 'task' | 'quote';
/** What the toolbar can show as pressed. */
export type ActiveFormat = InlineFormat | BlockFormat | `h${1 | 2 | 3 | 4 | 5 | 6}`;

export const MARKERS: Record<InlineFormat, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  highlight: '==',
  code: '`',
};

/** Marker characters each format accepts: Obsidian (CommonMark) also takes
 *  `_x_` / `__x__` for italic / bold. */
const CHARS: Record<InlineFormat, string> = {
  bold: '*_',
  italic: '*_',
  strike: '~',
  highlight: '=',
  code: '`',
};
/** Characters of the markers that can nest around a text (`**_x_**`). */
const NESTING = '*_~=';

/** Runs of one marker character that wrap a text on both sides, from the
 *  inside out (`before` ends at the text, `after` starts at it): character,
 *  run lengths and their distance from the text on each side. */
function markerPairs(before: string, after: string) {
  const out: { ch: string; a: number; b: number; da: number; db: number }[] = [];
  let i = before.length;
  let j = 0;
  while (i > 0 && j < after.length) {
    const ch = before[i - 1];
    if (!NESTING.includes(ch) || after[j] !== ch) break;
    let a = 0;
    while (a < i && before[i - 1 - a] === ch) a++;
    let b = 0;
    while (j + b < after.length && after[j + b] === ch) b++;
    out.push({ ch, a, b, da: before.length - i, db: j });
    i -= a;
    j += b;
  }
  return out;
}

/** Whether runs of `before`/`after` marker characters wrap the text in this
 *  format: italic is an odd run (`*x*`, `***x***`), the others need their
 *  whole marker (`**x**` is bold, never italic). */
function wrapped(kind: InlineFormat, before: number, after: number): boolean {
  const len = MARKERS[kind].length;
  if (kind === 'italic') return before % 2 === 1 && after % 2 === 1;
  return before >= len && after >= len;
}

/** The pair of marker runs that makes `before`·text·`after` this format. */
const wrapping = (kind: InlineFormat, before: string, after: string) =>
  markerPairs(before, after).find((p) => CHARS[kind].includes(p.ch) && wrapped(kind, p.a, p.b));

/** Wraps each selection (or the word at an empty cursor) in the format's
 *  markers, or unwraps it when it is already formatted. */
export function toggleInline(kind: InlineFormat): StateCommand {
  const m = MARKERS[kind];
  const k = m.length;
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      let { from, to } = range;
      if (range.empty) {
        const word = state.wordAt(range.head);
        if (!word) {
          return {
            changes: { from, insert: m + m },
            range: EditorSelection.cursor(from + k),
          };
        }
        ({ from, to } = word);
        // `_` is a word character: underscore markers are not part of the word.
        const text = state.sliceDoc(from, to);
        const lead = text.length - text.replace(/^_+/, '').length;
        const trail = text.length - text.replace(/_+$/, '').length;
        if (lead + trail < text.length) {
          from += lead;
          to -= trail;
        }
      }
      const text = state.sliceDoc(from, to);
      const keep = (a: number, b: number) =>
        range.empty ? EditorSelection.cursor(range.head + a) : EditorSelection.range(from + a, b);
      const outside = wrapping(
        kind,
        state.sliceDoc(Math.max(0, from - 12), from),
        state.sliceDoc(to, to + 12),
      );
      if (outside) {
        return {
          changes: [
            { from: from - outside.da - k, to: from - outside.da },
            { from: to + outside.db, to: to + outside.db + k },
          ],
          range: keep(-k, to - k),
        };
      }
      const lead = text.length - text.replace(new RegExp(`^[${NESTING}]+`), '').length;
      const trail = text.length - text.replace(new RegExp(`[${NESTING}]+$`), '').length;
      const inside =
        lead + trail < text.length &&
        wrapping(kind, text.slice(0, lead), text.slice(-trail || text.length));
      if (inside) {
        const start = from + lead - inside.da - k;
        const end = to - trail + inside.db;
        return {
          changes: [
            { from: start, to: start + k },
            { from: end, to: end + k },
          ],
          range: EditorSelection.range(from, to - 2 * k),
        };
      }
      return {
        changes: [
          { from, insert: m },
          { from: to, insert: m },
        ],
        range: keep(k, to + k),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/** Line numbers touched by the selections, in order, once each. A selection
 *  that ends at a line start (triple-click, ⇧↓) does not touch that line —
 *  as CodeMirror's own `selectedLineBlocks`. */
function selectedLines(state: EditorState): number[] {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const endsAtLineStart = !r.empty && state.doc.lineAt(r.to).from === r.to;
    const last = state.doc.lineAt(endsAtLineStart ? r.to - 1 : r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Applies per-line edits as one transaction; selections map through them. */
function editLines(
  state: EditorState,
  dispatch: (tr: ReturnType<EditorState['update']>) => void,
  edit: (text: string, index: number, lines: string[]) => string,
): boolean {
  const numbers = selectedLines(state);
  const texts = numbers.map((n) => state.doc.line(n).text);
  const changes: ChangeSpec[] = [];
  numbers.forEach((n, i) => {
    const line = state.doc.line(n);
    const next = edit(line.text, i, texts);
    if (next !== line.text) changes.push(...lineChange(line.from, line.text, next));
  });
  const set = state.changes(changes);
  // A selection that starts at a line start keeps covering the whole line
  // (prefix included); cursors stay after the text they were on.
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      const atStart = !r.empty && state.doc.lineAt(r.from).from === r.from;
      const from = set.mapPos(r.from, atStart ? -1 : 1);
      const to = set.mapPos(r.to, 1);
      return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    }),
    state.selection.mainIndex,
  );
  dispatch(
    state.update({ changes: set, selection, scrollIntoView: true, userEvent: 'input.format' }),
  );
  return true;
}

/** The smallest change turning `before` into `after` at `from` (only the
 *  prefix differs in practice), so cursors after it keep their place. */
function lineChange(from: number, before: string, after: string): ChangeSpec[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return [
    {
      from: from + head,
      to: from + before.length - tail,
      insert: after.slice(head, after.length - tail),
    },
  ];
}

const HEADING = /^(#{1,6})[ \t]+/;

/** Sets every selected line to heading `level` (0 = paragraph). */
export function setHeading(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): StateCommand {
  return ({ state, dispatch }) =>
    editLines(state, dispatch, (text) => {
      const body = text.replace(HEADING, '');
      return level === 0 ? body : `${'#'.repeat(level)} ${body}`;
    });
}

/** indent, list marker (`- `, `1. `, `- [ ] `), rest. */
const LIST = /^(\s*)((?:[-*+][ \t]+\[[ xX]\](?:[ \t]+|$))|(?:[-*+][ \t]+)|(?:\d+[.)][ \t]+))?(.*)$/;
const kindOf = (marker: string | undefined): BlockFormat | null =>
  !marker ? null : /\[[ xX]\]/.test(marker) ? 'task' : /^\d/.test(marker) ? 'numbered' : 'bullet';

/** Toggles a list kind or the quote on every selected line: removes it when
 *  every (non-blank) line already has it, otherwise sets it — replacing
 *  another list kind, renumbering numbered lists, keeping indentation. */
export function toggleBlock(kind: BlockFormat): StateCommand {
  return ({ state, dispatch }) => {
    const lines = selectedLines(state).map((n) => state.doc.line(n).text);
    const single = lines.length === 1;
    const counted = lines.filter((l) => single || l.trim() !== '');
    if (kind === 'quote') {
      const all = counted.every((l) => /^>/.test(l));
      return editLines(state, dispatch, (text) => {
        if (!single && text.trim() === '') return text;
        return all ? text.replace(/^> ?/, '') : `> ${text}`;
      });
    }
    const all = counted.every((l) => kindOf(LIST.exec(l)?.[2]) === kind);
    let number = 0;
    return editLines(state, dispatch, (text) => {
      if (!single && text.trim() === '') return text;
      const [, indent, , rest] = LIST.exec(text)!;
      if (all) return indent + rest;
      number += 1;
      const marker = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${number}. `;
      return indent + marker + rest;
    });
  };
}

/** A thematic break on its own line, with a blank line above it so the
 *  paragraph before never becomes a setext heading. */
export const insertDivider: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  let from: number;
  let insert: string;
  if (line.text.trim() !== '') {
    from = line.to;
    insert = '\n\n---\n';
  } else {
    const above = line.number > 1 ? state.doc.line(line.number - 1).text : '';
    from = line.from;
    insert = above.trim() !== '' ? '\n---\n' : '---\n';
  }
  dispatch(
    state.update({
      changes: { from, to: line.text.trim() === '' ? line.to : from, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/** `[selection](url)` with "url" selected to type over; empty → `[]()`. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range: SelectionRange) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: '[]()' },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    const urlFrom = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](url)` },
      range: EditorSelection.range(urlFrom, urlFrom + 3),
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

/** Leading whitespace, list marker (number + delimiter) and the gap after it. */
const ITEM = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+|$)/;
const columns = (ws: string) => {
  let c = 0;
  for (const ch of ws) c = ch === '\t' ? c + 4 - (c % 4) : c + 1;
  return c;
};
const indentOf = (text: string) => columns(/^[ \t]*/.exec(text)![0]);

/** The column an item's content starts at — where a child item must start to
 *  nest under it (CommonMark): `- ` → 2, `1. ` → 3, `10. ` → 4; five or more
 *  spaces after the marker count as one. */
function contentColumn(m: RegExpExecArray): number {
  const gap = m[5].length;
  return columns(m[1]) + m[2].length + (gap >= 1 && gap <= 4 ? gap : 1);
}

/** The indent line `n` (a list item) gets from Tab — the content column of
 *  the item above at its level — or ⇧Tab — the indent of its parent; null
 *  when there is nothing to nest under / nothing to outdent. */
function nestedIndent(textOf: (n: number) => string, n: number, dir: 1 | -1): number | null {
  const own = indentOf(textOf(n));
  if (dir === -1 && own === 0) return null;
  for (let k = n - 1; k >= 1; k--) {
    const text = textOf(k);
    if (text.trim() === '') continue;
    const indent = indentOf(text);
    if (dir === 1) {
      if (indent > own) continue;
      const item = ITEM.exec(text);
      return indent === own && item ? contentColumn(item) : null;
    }
    if (indent < own) return indent;
  }
  return dir === 1 ? null : 0;
}

/** The number of the ordered item just above line `n` in the same list at
 *  `indent`, if there is one. */
function previousNumber(textOf: (n: number) => string, n: number, indent: number): number | null {
  for (let k = n - 1; k >= 1; k--) {
    const text = textOf(k);
    if (text.trim() === '') continue;
    const at = indentOf(text);
    if (at > indent) continue;
    const item = ITEM.exec(text);
    return at === indent && item?.[3] ? Number(item[3]) : null;
  }
  return null;
}

/** Tab / Shift-Tab: nest list items under the item above, or un-nest them,
 *  by that item's marker width (spaces; `1. ` needs three), so the result is
 *  a nested list in CommonMark. A numbered item continues the numbering of
 *  its new list, and a newly nested one starts at 1 — an ordered list starting
 *  at any other number cannot interrupt the paragraph above, and the item
 *  would stay a line of its parent's text. Outside lists — and when nothing
 *  would change, e.g. ⇧Tab on a top-level item or Tab on a first item — the
 *  key is left to the browser, so Tab / ⇧Tab keep moving focus. */
export function listIndent(dir: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    const numbers = selectedLines(state);
    if (!numbers.every((n) => ITEM.test(state.doc.line(n).text))) return false;
    // Lines already moved, so later selected items follow them.
    const moved = new Map<number, string>();
    const textOf = (n: number) => moved.get(n) ?? state.doc.line(n).text;
    const changes: ChangeSpec[] = [];
    for (const n of numbers) {
      const target = nestedIndent(textOf, n, dir);
      if (target === null) continue;
      const line = state.doc.line(n);
      const m = ITEM.exec(line.text)!;
      const indent = ' '.repeat(target);
      let marker = m[2];
      if (m[3]) {
        const previous = previousNumber(textOf, n, target);
        if (previous !== null) marker = `${previous + 1}${m[4]}`;
        else if (dir === 1) marker = `1${m[4]}`;
      }
      if (indent === m[1] && marker === m[2]) continue;
      moved.set(n, indent + marker + line.text.slice(m[1].length + m[2].length));
      if (indent !== m[1]) changes.push(...lineChange(line.from, m[1], indent));
      if (marker !== m[2]) {
        const at = line.from + m[1].length;
        changes.push({ from: at, to: at + m[2].length, insert: marker });
      }
    }
    if (!changes.length) return false;
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.indent' }));
    return true;
  };
}

const HEADINGS = {
  ATXHeading1: 'h1',
  ATXHeading2: 'h2',
  ATXHeading3: 'h3',
  ATXHeading4: 'h4',
  ATXHeading5: 'h5',
  ATXHeading6: 'h6',
  SetextHeading1: 'h1',
  SetextHeading2: 'h2',
} as const;
const INLINE_NODES: Record<string, ActiveFormat> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
  Blockquote: 'quote',
};

/** The formats at the main cursor, from the editor's (incremental) syntax
 *  tree; `==highlight==` has no node there, so it is found on the line. */
export function activeFormats(state: EditorState): Set<ActiveFormat> {
  const out = new Set<ActiveFormat>();
  const pos = state.selection.main.head;
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent!) {
    const name = node.name;
    if (name in INLINE_NODES) out.add(INLINE_NODES[name]);
    else if (name in HEADINGS) out.add(HEADINGS[name as keyof typeof HEADINGS]);
    else if (name === 'ListItem') {
      const list = node.parent?.name;
      const task = node.getChild('Task');
      if (!out.has('bullet') && !out.has('numbered') && !out.has('task')) {
        out.add(task ? 'task' : list === 'OrderedList' ? 'numbered' : 'bullet');
      }
    }
    if (!node.parent) break;
  }
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const after = line.text.slice(pos - line.from);
  if ((before.split('==').length - 1) % 2 === 1 && after.includes('==')) out.add('highlight');
  return out;
}

/** Formatting shortcuts (active with the toolbar hidden too). */
export const formatKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: toggleInline('bold') },
  { key: 'Mod-i', run: toggleInline('italic') },
  { key: 'Mod-Shift-x', run: toggleInline('strike') },
  { key: 'Mod-Shift-h', run: toggleInline('highlight') },
  { key: 'Mod-e', run: toggleInline('code') },
  // The Link picker when the editor has one (M2c §6.3), else `[text](url)`.
  { key: 'Mod-k', run: (view) => openLinkPicker(view) || insertLink(view) },
  ...([0, 1, 2, 3, 4, 5, 6] as const).map((n) => ({ key: `Mod-Alt-${n}`, run: setHeading(n) })),
  { key: 'Mod-Shift-7', run: toggleBlock('numbered') },
  { key: 'Mod-Shift-8', run: toggleBlock('bullet') },
  { key: 'Mod-Shift-9', run: toggleBlock('task') },
  { key: 'Mod-Shift-.', run: toggleBlock('quote') },
  { key: 'Tab', run: listIndent(1) },
  { key: 'Shift-Tab', run: listIndent(-1) },
];

/** The editor's keys: formatting first, then CodeMirror's defaults without
 *  ⌘[ / ⌘] (they go back and forward along the link trail, M2b §3). */
export const editorKeymap: readonly KeyBinding[] = [
  ...formatKeymap,
  // Alt+↑ / Alt+↓ move a heading's section, a list item or a table row (M4 §5).
  ...blockKeymap,
  ...defaultKeymap.filter((b) => b.key !== 'Mod-[' && b.key !== 'Mod-]'),
];
