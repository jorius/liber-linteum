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

  it('never makes another list’s items children of a moved list or of a neighbour (final review I3)', () => {
    // `  - x` is a top-level list, indented: after another list it nests.
    const pasted = '* moved\n\nPara\n\n  - x\n- y\n';
    expect(move(pasted, '* moved', { top: '  - x' })).toBe('refused');
    expect(move('* keep\n\nPara\n\n  - x\n- y\n', 'Para', { top: null })).toBe('refused');
    // An item dropped right before it, as a list of its own.
    expect(move('- a\n- b\n\nPara\n\n  * x\n- y\n', '- b', { top: '  * x' })).toBe('refused');
    // Moves that keep it out of reach still go.
    expect(move(pasted, '* moved', { top: null })).toBe('Para\n\n  - x\n- y\n\n* moved\n');
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
