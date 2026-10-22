import { describe, expect, it } from 'vitest';
import { atomsLayout, buildAtoms, ATOM_H, ATOM_W, SECTION_H, type AtomsModel } from './atoms';
import { CARD_H, CARD_W } from './layout';

// A tester's note (M4b part 3): text, a link, then headings far down.
const COMISIONES = [
  '---',
  'tags: [freelance]',
  '---',
  'Los tipos de comisiones que quiero hacer.',
  '',
  'No hago gore',
  '[[Patreon]]',
  '',
  '# WIP (Work In Progress):',
  'Son avances de trabajos.',
  '![[Pasted image 1.png]]',
  '',
  '# Line art o sketches:',
  '![[Pasted image 2.png]]',
  '![[Pasted image 3.png]]',
  '',
  '---',
  '',
  'itsiansu ([insta](https://www.instagram.com/itsiansu/))',
  '',
].join('\n');

const kinds = (m: AtomsModel) => m.atoms.map((a) => a.kind);

describe('atoms of a page (M4b part 3 §6)', () => {
  it('sections run to the next heading; content before the first hangs from the page', () => {
    const m = buildAtoms(COMISIONES);
    expect(m.sections.map((s) => [s.title, s.level, s.parent])).toEqual([
      ['WIP (Work In Progress):', 1, null],
      ['Line art o sketches:', 1, null],
    ]);
    const [wip, art] = m.sections;
    expect(m.atoms.filter((a) => a.section === null).map((a) => a.kind)).toEqual([
      'paragraph',
      'paragraph',
    ]);
    // Frontmatter and the rule are skipped; an embed alone on its line is an
    // image, and a paragraph of embeds is one image per embed.
    expect(m.atoms.filter((a) => a.section === wip.id).map((a) => a.kind)).toEqual(['paragraph']);
    expect(
      m.atoms.filter((a) => a.section === art.id).map((a) => [a.kind, a.media?.target]),
    ).toEqual([
      ['image', 'Pasted image 2.png'],
      ['image', 'Pasted image 3.png'],
      ['paragraph', undefined],
    ]);
    expect(art.blocks).toBe(3);
    // Offsets point at the source: the cursor lands on the block.
    const second = m.atoms.find((a) => a.media?.target === 'Pasted image 3.png')!;
    expect(COMISIONES.slice(second.from, second.to)).toBe('![[Pasted image 3.png]]');
    expect(COMISIONES.slice(wip.at, wip.at + 3)).toBe('WIP');
    expect(COMISIONES.slice(wip.from, wip.to)).toMatch(/^# WIP[\s\S]*\.png\]\]\n\n$/);
  });

  it('a paragraph with text and an embed stays a paragraph that links its targets', () => {
    const m = buildAtoms(COMISIONES);
    const wip = m.atoms.find((a) => a.text.startsWith('Son avances'))!;
    expect(wip.kind).toBe('paragraph');
    expect(wip.links.map((l) => [l.kind, l.target])).toEqual([['embed', 'Pasted image 1.png']]);
    const gore = m.atoms.find((a) => a.text.startsWith('No hago gore'))!;
    expect(gore.links.map((l) => [l.kind, l.target])).toEqual([['wiki', 'Patreon']]);
  });

  it('sections nest by level', () => {
    const m = buildAtoms('# A\n\none\n\n## B\n\ntwo\n\n### C\n\nthree\n\n## D\n\n# E\n');
    expect(
      m.sections.map((s) => [s.title, m.sections.find((p) => p.id === s.parent)?.title]),
    ).toEqual([
      ['A', undefined],
      ['B', 'A'],
      ['C', 'B'],
      ['D', 'A'],
      ['E', undefined],
    ]);
    expect(m.sections.map((s) => s.blocks)).toEqual([1, 1, 1, 0, 0]);
  });

  it('each block kind, with what its card shows', () => {
    const src = [
      '- one',
      '- two',
      '- three',
      '- four',
      '',
      '* [x] done',
      '* [ ] open',
      '',
      '> quoted line',
      '',
      '> [!note] Heads up',
      '> body',
      '',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      'const e = 5;',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '| Name | Role |',
      '| --- | --- |',
      '| Rex | hero |',
      '| Six | ally |',
      '',
      '![[song.mp3]]',
      '',
      '![[brief.pdf]]',
      '',
      '![[Other page]]',
      '',
      '![alt](assets/x.png)',
      '',
      '<div>html</div>',
      '',
    ].join('\n');
    const m = buildAtoms(src);
    expect(kinds(m)).toEqual([
      'list',
      'tasks',
      'quote',
      'callout',
      'code',
      'diagram',
      'math',
      'table',
      'audio',
      'file',
      'note',
      'image',
      'html',
    ]);
    const [list, tasks, quote, callout, code, diagram, math, table] = m.atoms;
    expect(list).toMatchObject({ lines: ['one', 'two', 'three'], count: 4 });
    expect(tasks).toMatchObject({ count: 2, done: 1 });
    expect(quote.text).toBe('quoted line');
    expect(callout.text).toBe('Heads up');
    expect(code).toMatchObject({
      lang: 'ts',
      lines: ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'],
    });
    expect(diagram).toMatchObject({ text: 'flowchart TD', source: 'flowchart TD\n  A --> B' });
    expect(math.text).toBe('x^2');
    expect(table).toMatchObject({ lines: ['Name', 'Role'], count: 2 });
    expect(m.atoms[11].media).toEqual({ kind: 'markdown_image', target: 'assets/x.png' });
  });

  it(`at most ${400} atom cards: the rest of each section becomes "+N more"`, () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`).join('\n\n');
    const m = buildAtoms(`# A\n\n${body(5)}\n\n# B\n\n${body(4)}\n`, 6);
    expect(m.atoms).toHaveLength(6);
    expect(m.more).toEqual([expect.objectContaining({ section: m.sections[1].id, count: 3 })]);
    const src = `# A\n\n${body(5)}\n\n# B\n\n${body(4)}\n`;
    expect(src.slice(m.more[0].from, m.more[0].from + 2)).toBe('p1');
  });
});

describe('atoms layout (M4b part 3 §6)', () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('the page on top; sections as columns below; atoms stacked under, indented; linked pages right', () => {
    const m = buildAtoms('intro\n\n# A\n\none\n\ntwo\n\n## A2\n\nthree\n\n# B\n\nfour\n');
    const { boxes } = atomsLayout('P.md', m, ['L1.md', 'L2.md']);
    const box = (id: string) => boxes.get(id)!;
    expect(box('P.md')).toMatchObject({ w: CARD_W, h: CARD_H });
    const [a, a2, b] = m.sections;
    const intro = m.atoms[0];
    expect(box(intro.id)).toMatchObject({ w: ATOM_W, h: ATOM_H });
    expect(box(a.id).h).toBe(SECTION_H);
    // Below the page, left to right: the intro, A's column, B's column.
    expect(box(intro.id).y).toBeGreaterThan(box('P.md').y + CARD_H);
    expect(box(a.id).y).toBe(box(b.id).y);
    expect(box(a.id).x).toBeGreaterThan(box(intro.id).x);
    expect(box(b.id).x).toBeGreaterThan(box(a.id).x);
    // A's atoms under A, indented; A2 under them, its atom indented again.
    const [one, two, three] = m.atoms.filter((x) => x.section === a.id || x.section === a2.id);
    expect(box(one.id).x).toBeGreaterThan(box(a.id).x);
    expect(box(two.id).y).toBeGreaterThan(box(one.id).y);
    expect(box(a2.id).y).toBeGreaterThan(box(two.id).y);
    expect(box(three.id).x).toBeGreaterThan(box(a2.id).x);
    // Linked pages in a column right of everything.
    const right = Math.max(
      ...[...boxes.values()].filter((v) => v.w !== CARD_W).map((v) => v.x + v.w),
    );
    expect(box('L1.md').x).toBeGreaterThan(right);
    expect(box('L2.md').y).toBeGreaterThan(box('L1.md').y);
    // Nothing overlaps.
    const all = [...boxes.values()];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false);
  });

  it('structure edges: page → sections → sub-sections → atoms', () => {
    const m = buildAtoms('intro\n\n# A\n\none\n\n## A2\n\nthree\n');
    const { tree } = atomsLayout('P.md', m, []);
    const [a, a2] = m.sections;
    expect(tree).toEqual([
      ['P.md', m.atoms[0].id],
      ['P.md', a.id],
      [a.id, m.atoms[1].id],
      [a.id, a2.id],
      [a2.id, m.atoms[2].id],
    ]);
  });
});
