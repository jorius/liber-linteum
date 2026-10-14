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
