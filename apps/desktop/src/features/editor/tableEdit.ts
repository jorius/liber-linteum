// Markdown tables edited as a grid: the table at the cursor is read into
// cells, changed (a row, a column, an alignment, the next cell) and written
// back with its columns lined up. The file stays a plain GFM table; every
// change is one transaction, so one undo step.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';

export type Align = 'left' | 'center' | 'right' | null;

/** A table's cells, header row first, and its columns' alignments. */
export interface Grid {
  rows: string[][];
  aligns: Align[];
}

interface Cell {
  text: string;
  /** Where the trimmed text starts in the line. */
  from: number;
  /** The cell's extent in the line, pipes excluded. */
  start: number;
  end: number;
}

/** A row's cells: split on unescaped pipes, without the outer ones. */
export function splitRow(line: string): Cell[] {
  const out: Cell[] = [];
  let i = line.length - line.trimStart().length;
  if (line[i] === '|') i++;
  let start = i;
  for (; i <= line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (i < line.length && line[i] !== '|') continue;
    const raw = line.slice(start, i);
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: raw.trim(), from: start + lead, start, end: i });
    start = i + 1;
  }
  const end = line.trimEnd();
  if (out.length > 1 && !out[out.length - 1].text && end.endsWith('|') && !end.endsWith('\\|')) {
    out.pop();
  }
  return out;
}

const DELIMITER = /^:?-+:?$/;

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** The table's lines as a grid, every row as wide as the widest. */
export function parseTable(lines: string[]): Grid | null {
  if (lines.length < 2) return null;
  const delimiter = splitRow(lines[1]).map((c) => c.text);
  if (!delimiter.length || !delimiter.every((c) => DELIMITER.test(c))) return null;
  const rows = [lines[0], ...lines.slice(2)].map((l) => splitRow(l).map((c) => c.text));
  const cols = Math.max(delimiter.length, ...rows.map((r) => r.length));
  return {
    rows: rows.map((r) => [...r, ...Array<string>(cols - r.length).fill('')]),
    aligns: Array.from({ length: cols }, (_, c) =>
      c < delimiter.length ? alignOf(delimiter[c]) : null,
    ),
  };
}

/** The grid as Markdown with lined-up columns, and where each cell's text
 *  starts in it (row 0 is the header). */
export function renderTable(grid: Grid): {
  text: string;
  cellAt: (row: number, col: number) => number;
} {
  const cols = grid.aligns.length;
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...grid.rows.map((r) => r[c].length)),
  );
  const starts: number[][] = [];
  const lines: string[] = [];
  let offset = 0;
  const row = (cells: string[]) => {
    let line = '|';
    const at: number[] = [];
    cells.forEach((cell, c) => {
      const room = widths[c] - cell.length;
      const align = grid.aligns[c];
      const before = align === 'right' ? room : align === 'center' ? Math.floor(room / 2) : 0;
      at.push(offset + line.length + 1 + before);
      line += ` ${' '.repeat(before)}${cell}${' '.repeat(room - before)} |`;
    });
    starts.push(at);
    lines.push(line);
    offset += line.length + 1;
  };
  row(grid.rows[0]);
  const delimiter =
    '|' +
    grid.aligns
      .map((a, c) => {
        const w = widths[c];
        const dashes =
          a === 'center'
            ? `:${'-'.repeat(w - 2)}:`
            : a === 'left'
              ? `:${'-'.repeat(w - 1)}`
              : a === 'right'
                ? `${'-'.repeat(w - 1)}:`
                : '-'.repeat(w);
        return ` ${dashes} |`;
      })
      .join('');
  lines.push(delimiter);
  offset += delimiter.length + 1;
  grid.rows.slice(1).forEach(row);
  return { text: lines.join('\n'), cellAt: (r, c) => starts[r][c] };
}

/** Where cell (`row`, `col`) ends in a table's source text (row 0 is the
 *  header), so a click on a rendered cell puts the cursor there. */
export function cellEnd(text: string, row: number, col: number): number | null {
  const lines = text.split('\n');
  const index = row === 0 ? 0 : row + 1;
  if (index >= lines.length) return null;
  const cell = splitRow(lines[index])[col];
  if (!cell) return null;
  let at = 0;
  for (let i = 0; i < index; i++) at += lines[i].length + 1;
  return at + cell.from + cell.text.length;
}

/** The table holding `pos`, and the cell it is in. */
export interface TableAt {
  from: number;
  to: number;
  grid: Grid;
  row: number;
  col: number;
  /** The cursor's place in its cell's text. */
  offset: number;
}

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** Tables inside these are left alone: their lines carry `>` or an indent. */
const OUTSIDE = new Set(['Blockquote', 'ListItem']);

export function tableAt(state: EditorState, pos: number): TableAt | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    let table: SyntaxNode | null = null;
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'Table') table = node;
      else if (table && OUTSIDE.has(node.name)) return null;
    }
    if (table) return read(state, table.from, table.to, pos);
  }
  return null;
}

function read(state: EditorState, nodeFrom: number, nodeTo: number, pos: number): TableAt | null {
  const doc = state.doc;
  const first = doc.lineAt(nodeFrom);
  let last = doc.lineAt(nodeTo);
  if (last.from === nodeTo && nodeTo > nodeFrom) last = doc.lineAt(nodeTo - 1);
  const lines: string[] = [];
  for (let n = first.number; n <= last.number; n++) lines.push(doc.line(n).text);
  const grid = parseTable(lines);
  if (!grid) return null;
  const line = doc.lineAt(pos);
  const index = line.number - first.number;
  const row = index <= 1 ? 0 : index - 1;
  const cells = splitRow(lines[index]);
  const at = pos - line.from;
  let col = cells.findIndex((c) => at <= c.end);
  if (col < 0) col = Math.max(0, cells.length - 1);
  const cell = cells[col];
  const offset = index === 1 || !cell ? 0 : Math.max(0, Math.min(cell.text.length, at - cell.from));
  return {
    from: first.from,
    to: last.to,
    grid,
    row,
    col: Math.min(col, grid.aligns.length - 1),
    offset,
  };
}

/** Writes `grid` over the table and puts the cursor in cell (`row`, `col`):
 *  at `offset` in its text, or around all of it (`'all'`). */
function write(
  state: EditorState,
  at: { from: number; to: number },
  grid: Grid,
  row: number,
  col: number,
  offset: number | 'all',
) {
  const { text, cellAt } = renderTable(grid);
  const start = at.from + cellAt(row, col);
  const len = grid.rows[row][col].length;
  const selection =
    offset === 'all'
      ? EditorSelection.range(start, start + len)
      : EditorSelection.cursor(start + Math.min(offset, len));
  return state.update({
    changes: { from: at.from, to: at.to, insert: text },
    selection,
    scrollIntoView: true,
    userEvent: 'input.table',
  });
}

const emptyRow = (cols: number) => Array<string>(cols).fill('');
const copy = (g: Grid): Grid => ({ rows: g.rows.map((r) => [...r]), aligns: [...g.aligns] });

/** The table at a single cursor in an editable page, or null. */
function here(state: EditorState): TableAt | null {
  if (state.readOnly || state.selection.ranges.length > 1) return null;
  return tableAt(state, state.selection.main.head);
}

/** Tab: the next cell, its text selected to type over; past the last cell, a
 *  new row. Outside a table the key goes on (list indent, focus). */
export const nextCell: StateCommand = ({ state, dispatch }) => {
  const t = here(state);
  if (!t) return false;
  const grid = copy(t.grid);
  const cols = grid.aligns.length;
  let row = t.row;
  let col = t.col + 1;
  if (col >= cols) {
    col = 0;
    row += 1;
    if (row >= grid.rows.length) grid.rows.push(emptyRow(cols));
  }
  dispatch(write(state, t, grid, row, col, 'all'));
  return true;
};

/** Shift+Tab: the previous cell; at the first one the key goes on. */
export const previousCell: StateCommand = ({ state, dispatch }) => {
  const t = here(state);
  if (!t || (t.row === 0 && t.col === 0)) return false;
  const cols = t.grid.aligns.length;
  const row = t.col === 0 ? t.row - 1 : t.row;
  const col = t.col === 0 ? cols - 1 : t.col - 1;
  dispatch(write(state, t, copy(t.grid), row, col, 'all'));
  return true;
};

/** Enter: the same column one row down, adding a row after the last — also
 *  with a cell's text selected (after Tab), as a line break would only break
 *  the table. On an empty last row it leaves the table: the row goes, and
 *  the cursor lands on an empty line after it. */
export const nextRow: StateCommand = ({ state, dispatch }) => {
  const t = here(state);
  const { from, to } = state.selection.main;
  if (!t || state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return false;
  const grid = copy(t.grid);
  const last = t.row === grid.rows.length - 1;
  if (last && t.row > 0 && grid.rows[t.row].every((c) => !c)) {
    grid.rows.pop();
    const { text } = renderTable(grid);
    // A line right after a table is one of its rows: a blank line first.
    const end = state.doc.lineAt(t.to).number;
    const next = end < state.doc.lines ? state.doc.line(end + 1).text : null;
    const insert = `${text}\n\n${next !== null && next.trim() !== '' ? '\n' : ''}`;
    dispatch(
      state.update({
        changes: { from: t.from, to: t.to, insert },
        selection: EditorSelection.cursor(t.from + text.length + 2),
        scrollIntoView: true,
        userEvent: 'input.table',
      }),
    );
    return true;
  }
  if (last) grid.rows.push(emptyRow(grid.aligns.length));
  dispatch(write(state, t, grid, t.row + 1, t.col, Infinity));
  return true;
};

export type TableAction =
  | 'rowAbove'
  | 'rowBelow'
  | 'colLeft'
  | 'colRight'
  | 'deleteRow'
  | 'deleteCol'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'deleteTable';

/** What the table menu shows: the cell the cursor is in and what can be
 *  done there (the header row can't be moved below or deleted). */
export interface TableInfo {
  row: number;
  col: number;
  align: Align;
  disabled: Set<TableAction>;
}

export function tableInfo(state: EditorState): TableInfo | null {
  const t = here(state);
  if (!t) return null;
  const disabled = new Set<TableAction>();
  if (t.row === 0) disabled.add('rowAbove').add('deleteRow');
  return { row: t.row, col: t.col, align: t.grid.aligns[t.col], disabled };
}

/** A table menu action at the cursor's cell. */
export function tableAction(action: TableAction): StateCommand {
  return ({ state, dispatch }) => {
    const t = here(state);
    if (!t) return false;
    const grid = copy(t.grid);
    const cols = grid.aligns.length;
    let { row, col } = t;
    let offset: number | 'all' = t.offset;
    switch (action) {
      case 'rowAbove':
        if (row === 0) return false;
        grid.rows.splice(row, 0, emptyRow(cols));
        offset = 0;
        break;
      case 'rowBelow':
        grid.rows.splice(row + 1, 0, emptyRow(cols));
        row += 1;
        offset = 0;
        break;
      case 'colLeft':
      case 'colRight': {
        const at = action === 'colLeft' ? col : col + 1;
        grid.rows.forEach((r) => r.splice(at, 0, ''));
        grid.aligns.splice(at, 0, null);
        col = at;
        offset = 0;
        break;
      }
      case 'deleteRow':
        if (row === 0) return false;
        grid.rows.splice(row, 1);
        row = Math.min(row, grid.rows.length - 1);
        offset = 0;
        break;
      case 'deleteCol':
        if (cols === 1) return tableAction('deleteTable')({ state, dispatch });
        grid.rows.forEach((r) => r.splice(col, 1));
        grid.aligns.splice(col, 1);
        col = Math.min(col, cols - 2);
        offset = 0;
        break;
      case 'alignLeft':
      case 'alignCenter':
      case 'alignRight':
        grid.aligns[col] =
          action === 'alignLeft' ? 'left' : action === 'alignCenter' ? 'center' : 'right';
        break;
      case 'deleteTable': {
        const to = Math.min(state.doc.length, t.to + 1);
        dispatch(
          state.update({
            changes: { from: t.from, to },
            selection: EditorSelection.cursor(t.from),
            scrollIntoView: true,
            userEvent: 'delete.table',
          }),
        );
        return true;
      }
    }
    dispatch(write(state, t, grid, row, col, offset));
    return true;
  };
}

/** A new table, `cols` wide and `rows` tall counting its header, on lines of
 *  its own with a blank line around it; the cursor in its first cell. */
export function insertTable(cols: number, rows: number): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const grid: Grid = {
      rows: Array.from({ length: Math.max(1, rows) }, () => emptyRow(cols)),
      aligns: emptyRow(cols).map(() => null),
    };
    const { text, cellAt } = renderTable(grid);
    const line = state.doc.lineAt(state.selection.main.head);
    const blank = line.text.trim() === '';
    const above = line.number > 1 ? state.doc.line(line.number - 1).text.trim() !== '' : false;
    const below =
      line.number < state.doc.lines && state.doc.line(line.number + 1).text.trim() !== '';
    const from = blank ? line.from : line.to;
    const to = line.to;
    const before = blank ? (above ? '\n' : '') : '\n\n';
    const after = blank ? (below ? '\n' : '') : below ? '\n' : '';
    dispatch(
      state.update({
        changes: { from, to, insert: before + text + after },
        selection: EditorSelection.cursor(from + before.length + cellAt(0, 0)),
        scrollIntoView: true,
        userEvent: 'input.table',
      }),
    );
    return true;
  };
}

/** The keys of a table: Tab / Shift+Tab between cells, Enter down a row. */
export const tableKeymap: readonly KeyBinding[] = [
  { key: 'Tab', run: nextCell },
  { key: 'Shift-Tab', run: previousCell },
  { key: 'Enter', run: nextRow },
];
