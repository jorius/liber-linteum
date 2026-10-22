import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  cellEnd,
  insertTable,
  nextCell,
  nextRow,
  parseTable,
  previousCell,
  renderTable,
  splitRow,
  tableAction,
  tableInfo,
} from './tableEdit';

/** `‹…›` marks a selection, `¦` a cursor. */
function stateOf(marked: string, readOnly = false): EditorState {
  let doc = '';
  let anchor = 0;
  let head = 0;
  for (const ch of marked) {
    if (ch === '‹') anchor = doc.length;
    else if (ch === '›') head = doc.length;
    else if (ch === '¦') anchor = head = doc.length;
    else doc += ch;
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, Math.max(anchor, head)),
    extensions: [
      history(),
      markdown({ base: markdownLanguage }),
      EditorState.readOnly.of(readOnly),
    ],
  });
}

function marked(state: EditorState): string {
  const out = state.doc.toString();
  const r = state.selection.main;
  return r.empty
    ? `${out.slice(0, r.from)}¦${out.slice(r.from)}`
    : `${out.slice(0, r.from)}‹${out.slice(r.from, r.to)}›${out.slice(r.to)}`;
}

function run(cmd: StateCommand, input: string | EditorState): EditorState | null {
  let state = typeof input === 'string' ? stateOf(input) : input;
  const handled = cmd({ state, dispatch: (tr) => (state = tr.state) });
  return handled ? state : null;
}

const apply = (cmd: StateCommand, input: string) => {
  const out = run(cmd, input);
  return out ? marked(out) : null;
};

const TABLE = ['| Name | Moons |', '|---|:-:|', '| Kessari | 2 |', '| Oruk | 0 |'].join('\n');

describe('reading and writing tables', () => {
  it('splits rows on unescaped pipes, with or without the outer ones', () => {
    expect(splitRow('| a | b |').map((c) => c.text)).toEqual(['a', 'b']);
    expect(splitRow('a | b').map((c) => c.text)).toEqual(['a', 'b']);
    expect(splitRow('| a \\| b | `c` |').map((c) => c.text)).toEqual(['a \\| b', '`c`']);
    expect(splitRow('| a |  |').map((c) => c.text)).toEqual(['a', '']);
  });

  it('lines the columns up, keeping alignments; short rows are padded', () => {
    const grid = parseTable(['| Name | Moons | Notes', '|:--|--:|:-:|', '| Kessari | 2 |'])!;
    expect(grid.aligns).toEqual(['left', 'right', 'center']);
    expect(renderTable(grid).text).toBe(
      [
        '| Name    | Moons | Notes |',
        '| :------ | ----: | :---: |',
        '| Kessari |     2 |       |',
      ].join('\n'),
    );
  });

  it('is not a table without a delimiter row', () => {
    expect(parseTable(['| a | b |', '| c | d |'])).toBeNull();
  });

  it('finds where a rendered cell ends in the source (header is row 0)', () => {
    expect(cellEnd(TABLE, 0, 1)).toBe(TABLE.indexOf('Moons') + 5);
    expect(cellEnd(TABLE, 2, 0)).toBe(TABLE.indexOf('Oruk') + 4);
    expect(cellEnd(TABLE, 9, 0)).toBeNull();
  });
});

describe('moving between cells', () => {
  it('Tab selects the next cell, lining the table up', () => {
    expect(apply(nextCell, `| Name¦ | Moons |\n|---|:-:|\n| Kessari | 2 |`)).toBe(
      '| Name    | ‹Moons› |\n| ------- | :---: |\n| Kessari |   2   |',
    );
  });

  it('Tab from the last cell adds a row', () => {
    expect(apply(nextCell, `| a | b |\n|---|---|\n| c | d¦ |`)).toBe(
      '| a   | b   |\n| --- | --- |\n| c   | d   |\n| ¦    |     |',
    );
  });

  it('Shift+Tab goes back, to the row above from a first cell; not before the first', () => {
    expect(apply(previousCell, `| a | b |\n|---|---|\n| ¦c | d |`)).toBe(
      '| a   | ‹b›   |\n| --- | --- |\n| c   | d   |',
    );
    expect(apply(previousCell, `| ¦a | b |\n|---|---|`)).toBeNull();
  });

  it('Enter goes down a row, adding one after the last', () => {
    expect(apply(nextRow, `| a | b¦ |\n|---|---|\n| c | d |`)).toBe(
      '| a   | b   |\n| --- | --- |\n| c   | d¦   |',
    );
    expect(apply(nextRow, `| a | b |\n|---|---|\n| c | d¦ |`)).toBe(
      '| a   | b   |\n| --- | --- |\n| c   | d   |\n|     | ¦    |',
    );
  });

  it('Enter with a cell selected (after Tab) goes down too, keeping the text', () => {
    expect(apply(nextRow, `| a | ‹b› |\n|---|---|\n| c | d |`)).toBe(
      '| a   | b   |\n| --- | --- |\n| c   | d¦   |',
    );
  });

  it('Enter on an empty last row leaves the table, past a blank line', () => {
    expect(apply(nextRow, `| a |\n|---|\n| ¦ |\n\nAfter`)).toBe('| a   |\n| --- |\n\n¦\n\nAfter');
    expect(apply(nextRow, `| a |\n|---|\n| ¦ |`)).toBe('| a   |\n| --- |\n\n¦');
  });

  it('outside a table, in a quoted one or on a read-only page the keys go on', () => {
    expect(apply(nextCell, 'plain ¦text')).toBeNull();
    expect(apply(nextCell, '> | a | b |\n> |---|---|\n> | ¦c | d |')).toBeNull();
    expect(run(nextCell, stateOf(`| ¦a | b |\n|---|---|`, true))).toBeNull();
  });
});

describe('the table menu', () => {
  const at = `${TABLE.replace('Kessari', 'Kes¦sari')}`;

  it('adds rows and columns around the cell', () => {
    expect(apply(tableAction('rowAbove'), at)).toBe(
      [
        '| Name    | Moons |',
        '| ------- | :---: |',
        '| ¦        |       |',
        '| Kessari |   2   |',
        '| Oruk    |   0   |',
      ].join('\n'),
    );
    expect(apply(tableAction('colRight'), at)).toBe(
      [
        '| Name    |     | Moons |',
        '| ------- | --- | :---: |',
        '| Kessari | ¦    |   2   |',
        '| Oruk    |     |   0   |',
      ].join('\n'),
    );
  });

  it('deletes a row or a column; the last column takes the table', () => {
    expect(apply(tableAction('deleteRow'), at)).toBe(
      ['| Name | Moons |', '| ---- | :---: |', '| ¦Oruk |   0   |'].join('\n'),
    );
    expect(apply(tableAction('deleteCol'), `Intro\n\n| ¦a |\n|---|\n| b |\n\nEnd`)).toBe(
      'Intro\n\n¦\nEnd',
    );
  });

  it('aligns the column, header included; the header row cannot be deleted or have a row above', () => {
    expect(apply(tableAction('alignRight'), at)).toBe(
      [
        '|    Name | Moons |',
        '| ------: | :---: |',
        '| Kes¦sari |   2   |',
        '|    Oruk |   0   |',
      ].join('\n'),
    );
    const head = stateOf(TABLE.replace('Name', 'Na¦me'));
    expect(tableInfo(head)!.disabled).toEqual(new Set(['rowAbove', 'deleteRow']));
    expect(run(tableAction('deleteRow'), head)).toBeNull();
    expect(tableInfo(stateOf('no ¦table'))).toBeNull();
  });

  it('every change is one undo step', () => {
    const state = run(tableAction('colLeft'), at)!;
    let back = state;
    undo({ state, dispatch: (tr) => (back = tr.state) });
    expect(back.doc.toString()).toBe(TABLE);
  });
});

describe('inserting a table', () => {
  it('on an empty line, with blank lines around it, cursor in the first cell', () => {
    expect(apply(insertTable(2, 2), 'Intro\n¦\nEnd')).toBe(
      'Intro\n\n| ¦    |     |\n| --- | --- |\n|     |     |\n\nEnd',
    );
  });

  it('after a line of text, below it', () => {
    expect(apply(insertTable(1, 1), 'Some ¦text')).toBe('Some text\n\n| ¦    |\n| --- |');
  });
});
