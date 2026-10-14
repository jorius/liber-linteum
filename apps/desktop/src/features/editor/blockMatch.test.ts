import type { Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { movableBlocks, type Slot } from '../../markdown/blockModel';
import { parsePage } from '../../markdown/parse';
import { matcher, type Seen } from './blockMatch';

const seen = (text: string): Seen => ({ text, model: movableBlocks(text, parsePage(text)) });
const idOf = (s: Seen, text: string) =>
  s.model.units.findIndex((u) => s.text.slice(u.from, u.to) === text);

describe('finding a block again in another version (final review C2)', () => {
  it('the same version: every block and slot is itself', () => {
    const a = seen('# H\n\nP1\n\n- a\n  - b\n- c\n\n| x |\n|---|\n| 1 |\n| 2 |\n');
    const m = matcher(a, a);
    for (const u of a.model.units) expect(m.unit(u.id)).toBe(u);
    const slots: Slot[] = [
      { scope: 'top', before: 0 },
      { scope: 'top', before: null },
      { scope: 'item', list: 1, before: null },
      { scope: 'child', of: idOf(a, '- c') },
      { scope: 'row', table: 0, before: null },
    ];
    for (const s of slots) expect(m.slot(s)).toEqual(s);
  });

  it('text inserted above: blocks below shift and keep their identity', () => {
    const a = seen('P1\n\nP2\n\nP3\n');
    const b = seen('New\n\nP1\n\nP2\n\nP3\n');
    const m = matcher(a, b);
    expect(m.unit(idOf(a, 'P3'))?.id).toBe(idOf(b, 'P3'));
    expect(m.slot({ scope: 'top', before: idOf(a, 'P1') })).toEqual({
      scope: 'top',
      before: idOf(b, 'P1'),
    });
    expect(m.slot({ scope: 'top', before: null })).toEqual({ scope: 'top', before: null });
  });

  it('an edited block is gone; the blocks around it are found', () => {
    const a = seen('P1\n\nP2\n\nP3\n');
    const m = matcher(a, seen('P1\n\nP2!\n\nP3\n'));
    expect(m.unit(idOf(a, 'P2'))).toBeNull();
    expect(m.unit(idOf(a, 'P1'))?.from).toBe(0);
    expect(m.unit(idOf(a, 'P3'))?.from).toBe(9);
    // Typing at a block's very start or end changes it too.
    expect(matcher(a, seen('xP1\n\nP2\n\nP3\n')).unit(idOf(a, 'P1'))).toBeNull();
    expect(matcher(a, seen('P1\n\nP2\n\nP3x\n')).unit(idOf(a, 'P3'))).toBeNull();
  });

  it('the same text read differently (a lagging re-parse): blocks are matched by kind and range, not by index', () => {
    const text = 'Intro\n\nPara\n\n- a\n- b\n\n> q\n\nEnd\n';
    const right = seen(text);
    // A pane whose re-parse took the list for a paragraph (final review C2,
    // trigger 1): its ids after the list are off by two.
    const tree = parsePage(text).tree;
    const misread: Root = {
      ...tree,
      children: tree.children.map((n) =>
        n.type === 'list' ? { type: 'paragraph', children: [], position: n.position } : n,
      ),
    };
    const pane: Seen = {
      text,
      model: movableBlocks(text, { ...parsePage(text), tree: misread }),
    };
    const m = matcher(pane, right);
    expect(m.unit(idOf(pane, '> q'))?.id).toBe(idOf(right, '> q'));
    expect(m.slot({ scope: 'top', before: idOf(pane, 'Intro') })).toEqual({
      scope: 'top',
      before: idOf(right, 'Intro'),
    });
    // The paragraph the pane shows isn't a block of the text: nothing to move.
    expect(m.unit(idOf(pane, '- a\n- b'))).toBeNull();
    expect(m.slot({ scope: 'top', before: idOf(pane, '- a\n- b') })).toBeNull();
  });

  it('list, child and row slots follow their list, item and table', () => {
    const a = seen('- a\n  - b\n- c\n\n| x |\n|---|\n| 1 |\n| 2 |\n');
    const b = seen(`Top\n\n${a.text}`);
    const m = matcher(a, b);
    const nested = a.model.lists.findIndex((l) => l.depth === 1);
    expect(m.slot({ scope: 'item', list: nested, before: null })).toEqual({
      scope: 'item',
      list: b.model.lists.findIndex((l) => l.depth === 1),
      before: null,
    });
    expect(m.slot({ scope: 'item', list: 0, before: idOf(a, '- c') })).toEqual({
      scope: 'item',
      list: 0,
      before: idOf(b, '- c'),
    });
    expect(m.slot({ scope: 'child', of: idOf(a, '- c') })).toEqual({
      scope: 'child',
      of: idOf(b, '- c'),
    });
    expect(m.slot({ scope: 'row', table: 0, before: idOf(a, '| 2 |') })).toEqual({
      scope: 'row',
      table: 0,
      before: idOf(b, '| 2 |'),
    });
    // A list is found by any of its items that's unchanged.
    const edited = seen(a.text.replace('- a', '- a!'));
    expect(matcher(a, edited).slot({ scope: 'item', list: 0, before: null })).toEqual({
      scope: 'item',
      list: 0,
      before: null,
    });
  });
});
