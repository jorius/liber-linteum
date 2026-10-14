import { ChangeSet, Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { movableBlocks, type BlockModel, type Slot, type Unit } from './blockModel';
import { applyChanges, moveBlock, planMove } from './blockMoves';
import type { TextChange } from './frontmatterEdit';
import { parsePage } from './parse';

const model = (text: string): BlockModel => movableBlocks(text, parsePage(text));
/** The deepest unit starting on the line where `start` first appears
 *  (`top:…`: the top-level one). */
const named = (m: BlockModel, text: string, start: string): Unit => {
  const top = start.startsWith('top:');
  const s = top ? start.slice(4) : start;
  // (A byte-order mark is no part of the first line.)
  const line = Math.max(text.lastIndexOf('\n', text.indexOf(s) - 1) + 1, m.contentStart);
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

  it('a move next to a horizontal rule is not refused (found by the sweep)', () => {
    // The guard's window around the drop starts at `---`: a rule there, not
    // the start of front matter.
    const text = 'P0\n\n> quote\n\nP1\n\nP2\n\nP3\n\n---\n\nEnd.\n';
    expect(move(text, '> quote', 'End.')).toBe('P0\n\nP1\n\nP2\n\nP3\n\n---\n\n> quote\n\nEnd.\n');
  });

  it('never leaves a `---` line first: the note would open front matter (final review C1)', () => {
    // Everything up to the next `---` would turn into YAML properties.
    const meeting =
      'Meeting intro\n\n---\n\nFirst point.\n\nSecond point.\n\nThird point.\n\n---\n\n## Actions\n\nCall Ana\n';
    expect(move(meeting, 'Meeting intro', 'First point.')).toBe('refused');
    expect(move(meeting, 'Meeting intro', null)).toBe('refused');
    const props = 'status: draft\n\n---\n\ntags: x\n\nowner: me\n\n---\n\nBody\n';
    expect(move(props, 'status: draft', 'tags: x')).toBe('refused');
    // A rule moved to the top, closed or not further down.
    expect(move('Intro\n\n---\n\nA\n', '---', 'Intro')).toBe('refused');
    expect(move('Intro\n\nA\n\n---\n\nB\n\n---\n\nC\n', '---', 'Intro')).toBe('refused');
    // Alt on a first heading leaves the rule after it first.
    expect(move('# Title\n\n---\n\nA\n\n## B\n\nb\n', '# Title', null, true)).toBe('refused');
    // A first list moved away; a setext underline closing the block.
    expect(move('- a\n- b\n\n---\n\nP\n\nQ\n', 'top:- a', null)).toBe('refused');
    expect(move('Intro\n\n---\n\nA\n\nTitle\n---\n\nE\n', 'Intro', 'E')).toBe('refused');
    // CRLF, and a closer with trailing spaces.
    expect(move('Intro\r\n\r\n---\r\n\r\nA\r\n\r\n---  \r\n\r\nB\r\n', 'Intro', 'B')).toBe(
      'refused',
    );
  });

  it('other rules may go first, and a leading `---` that nothing closes may stay or go', () => {
    expect(move('Intro\n\n***\n\nA\n', '***', 'Intro')).toBe('***\n\nIntro\n\nA\n');
    // A block above an unclosed leading rule, or reordered below it.
    expect(move('---\n\nA\n\nB\n', 'B', '---')).toBe('B\n\n---\n\nA\n');
    expect(move('---\n\nA\n\nB\n', 'B', 'A')).toBe('---\n\nB\n\nA\n');
    expect(move('---\n\nA\n\nB\n', '---', null)).toBe('A\n\nB\n\n---\n');
  });

  it('never changes which text a %% comment hides, across blocks (final review M1)', () => {
    // The heading would land inside `%% *zeta*\n\n…%%`.
    expect(move('delta %%\n\n%%c%% *zeta*\n\n%% delta2\n\n### H\n', '### H', '%% delta2')).toBe(
      'refused',
    );
    // The opener leaving: its closer would pair with the next `%%`.
    const draft =
      'Intro\n\nDraft idea %%\nhidden one\n\nhidden two\n%%\n\nPara B\n\nPara C\n\nPara D\n';
    expect(move(draft, 'Draft idea', null)).toBe('refused');
    // A `%%` that pairs with nothing, moved before a comment, would open one.
    const stray = 'A\n\nB\n\nC\n\nD\n\n%% c %%\n\nE 50%% off\n';
    expect(move(stray, 'E 50%% off', 'A')).toBe('refused');
    // …or a comment moved past one that stays: they'd pair.
    const gap = 'P0\n\nP1 %%c%%\n\nP2\n\nP3\n\nP4 %% stray\n\nP5\n\nP6\n\nP7\n';
    expect(move(gap, 'P1 %%c%%', null)).toBe('refused');
    // …also when a comment, masked, turns an item's text into code.
    const masked =
      '+ %%c1%% [[alpha]]\n+ %%c2%% *zeta*\n+ beta\n\niota 50%% off\n\n> [!note] kappa\n> gamma\n\n> quote\n';
    expect(move(masked, '+ %%c1%%', null)).toBe('refused');
    expect(move(masked, '+ %%c1%%', '> quote')).toBe('refused');
    // Comments that stay as they are don't stop a move.
    expect(move(draft, 'Para D', 'Intro')).toBe(
      'Para D\n\nIntro\n\nDraft idea %%\nhidden one\n\nhidden two\n%%\n\nPara B\n\nPara C\n',
    );
    expect(move(stray, 'A', 'D')).toBe('B\n\nC\n\nA\n\nD\n\n%% c %%\n\nE 50%% off\n');
    // A `%%` in a code block pairs with nothing either way.
    const code = 'P1 %%c%%\n\nP2\n\n```\nx %% y\n```\n\nP3\n';
    expect(move(code, 'P1 %%c%%', null)).toBe('P2\n\n```\nx %% y\n```\n\nP3\n\nP1 %%c%%\n');
  });

  it('a slot that leaves the block where it is gives nothing', () => {
    expect(move('P1\n\nP2\n', 'P1', 'P2')).toBeNull();
    expect(move('P1\n\nP2\n', 'P2', null)).toBeNull();
  });
});

describe('a file starting with a byte-order mark (final review I4)', () => {
  const BOM = '\uFEFF';
  /** The move's text, which CodeMirror's change set must give too. */
  function moved(text: string, what: string, before: string | null) {
    const out = move(text, what, before);
    if (typeof out !== 'string') return out;
    const m = model(text);
    const r = moveBlock(text, m, named(m, text, what), {
      scope: 'top',
      before: before === null ? null : named(m, text, before).id,
    });
    const cm = ChangeSet.of((r as { changes: TextChange[] }).changes, text.length)
      .apply(Text.of(text.split('\n')))
      .toString();
    expect(cm).toBe(out);
    return out;
  }

  it('blocks start after the mark, and moves keep it first', () => {
    const text = `${BOM}Para one\n\nPara two\n\nPara three\n`;
    const m = model(text);
    expect(m.units.map((u) => text.slice(u.from, u.to))).toEqual([
      'Para one',
      'Para two',
      'Para three',
    ]);
    expect(moved(text, 'Para three', 'Para one')).toBe(
      `${BOM}Para three\n\nPara one\n\nPara two\n`,
    );
    expect(moved(text, 'Para one', null)).toBe(`${BOM}Para two\n\nPara three\n\nPara one\n`);
    expect(moved(`${BOM}Title\n---\n\nSecond para\n`, 'Second para', 'Title')).toBe(
      `${BOM}Second para\n\nTitle\n---\n`,
    );
  });

  it('list items and table rows move too', () => {
    const text = `${BOM}- a\n- b\n`;
    const m = model(text);
    const items = m.units.filter((u) => u.scope === 'item');
    const r = moveBlock(text, m, items[1], { scope: 'item', list: 0, before: items[0].id });
    expect(r && 'changes' in r && applyChanges(text, r.changes)).toBe(`${BOM}- b\n- a\n`);
    const table = `${BOM}| h |\n|---|\n| 1 |\n| 2 |\n`;
    const t = model(table);
    const rows = t.units.filter((u) => u.scope === 'row');
    const s = moveBlock(table, t, rows[1], { scope: 'row', table: 0, before: rows[0].id });
    expect(s && 'changes' in s && applyChanges(table, s.changes)).toBe(
      `${BOM}| h |\n|---|\n| 2 |\n| 1 |\n`,
    );
  });

  it('edits that overlap are refused: the guard and CodeMirror would apply them differently', () => {
    // A model whose offsets miss the mark by one (what every BOM file got).
    const text = `${BOM}gamma297\n---\n\n%%c298%% eps299 *iota300*\ngamma301 [[eta302]] #tag303\n`;
    const stale = movableBlocks(text, parsePage(text.slice(1)));
    const last = stale.units[stale.units.length - 1];
    // Planned: delete [13, 68) and insert at 14.
    const planned = planMove(text, stale, last, { scope: 'top', before: 1 })!;
    expect(planned.changes[1].from).toBeLessThan(planned.changes[0].to);
    expect(moveBlock(text, stale, last, { scope: 'top', before: 1 })).toEqual({ refused: true });
  });

  it('front matter after the mark stays first; a rule never becomes it', () => {
    expect(moved(`${BOM}---\na: 1\n---\nP1\n\nP2\n`, 'P2', 'P1')).toBe(
      `${BOM}---\na: 1\n---\nP2\n\nP1\n`,
    );
    expect(move(`${BOM}Intro\n\n---\n\nA\n\n---\n\nB\n`, 'Intro', 'A')).toBe('refused');
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
