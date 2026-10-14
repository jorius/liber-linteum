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
