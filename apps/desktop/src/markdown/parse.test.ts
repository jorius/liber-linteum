import { describe, expect, it } from 'vitest';
import type { Embed, Tag, WikiLink } from './types';
import { parsePage } from './parse';
import { toSafeHast } from './sanitize';
import { findAll } from './walk';

const slice = (
  src: string,
  n: { position?: { start: { offset?: number }; end: { offset?: number } } },
) => src.slice(n.position!.start.offset!, n.position!.end.offset!);

describe('parsePage — wikilinks and embeds (M2a §2.1)', () => {
  it('parses every wikilink form with exact source positions', () => {
    const src = 'See [[Sparda]], [[Game 1#Plot]], [[rex-draft|Rex]] and [[A#B|C]].\n';
    const p = parsePage(src);
    const links = findAll<WikiLink>(p.tree, 'wikiLink');
    expect(links.map((l) => [l.target, l.heading, l.alias])).toEqual([
      ['Sparda', null, null],
      ['Game 1', 'Plot', null],
      ['rex-draft', null, 'Rex'],
      ['A', 'B', 'C'],
    ]);
    expect(links.map((l) => slice(src, l))).toEqual([
      '[[Sparda]]',
      '[[Game 1#Plot]]',
      '[[rex-draft|Rex]]',
      '[[A#B|C]]',
    ]);
  });

  it('parses embeds with Obsidian size syntax', () => {
    const src = '![[rex.png]] ![[rex.png|300]] ![[rex.png|300x200]] ![[Sparda#Palette]]\n';
    const embeds = findAll<Embed>(parsePage(src).tree, 'embed');
    expect(embeds.map((e) => [e.target, e.heading, e.width, e.height])).toEqual([
      ['rex.png', null, null, null],
      ['rex.png', null, 300, null],
      ['rex.png', null, 300, 200],
      ['Sparda', 'Palette', null, null],
    ]);
    expect(slice(src, embeds[1])).toBe('![[rex.png|300]]');
  });

  it('PG-05 table alias form [[target\\|alias]] works inside a table cell', () => {
    const src = '| a | b |\n|---|---|\n| x | [[A\\|shown]] |\n';
    const [l] = findAll<WikiLink>(parsePage(src).tree, 'wikiLink');
    expect([l.target, l.alias]).toEqual(['A', 'shown']);
  });

  it('ignores escaped \\[[ and anything inside code', () => {
    const src = 'Not \\[[a link]]. `[[code]]`\n\n```\n[[fenced]]\n```\n\n    [[indented]]\n';
    const p = parsePage(src);
    expect(findAll(p.tree, 'wikiLink')).toEqual([]);
    expect(p.links).toEqual([]);
  });

  it('keeps the surrounding text, decoded, around links', () => {
    const p = parsePage('a &amp; b \\* [[X]] c\n');
    const para = p.tree.children[0] as { children: { type: string; value?: string }[] };
    expect(para.children.map((c) => c.type)).toEqual(['text', 'wikiLink', 'text']);
    expect(para.children[0].value).toBe('a & b * ');
    expect(para.children[2].value).toBe(' c');
  });
});

describe('parsePage — links list (spec §2.2, parity with liber-markdown)', () => {
  it('lists wiki, embed, markdown and markdown_image links with decoded targets', () => {
    const src =
      '[[Sparda]] ![[rex.png|300]] [p](DMC/Sparda.md#Palette) [g](</Game Design/Game 1.md>) ' +
      '[e](../Game%20Design/Game%201.md) ![i](assets/a.png) [x](https://example.com) [h](#top)\n';
    const p = parsePage(src);
    expect(p.links.map((l) => [l.kind, l.target, l.heading, l.alias])).toEqual([
      ['wiki', 'Sparda', null, null],
      ['embed', 'rex.png', null, '300'],
      ['markdown', 'DMC/Sparda.md', 'Palette', null],
      ['markdown', '/Game Design/Game 1.md', null, null],
      ['markdown', '../Game Design/Game 1.md', null, null],
      ['markdown_image', 'assets/a.png', null, null],
    ]);
    for (const l of p.links) expect(l.range[0]).toBeLessThan(l.range[1]);
  });
});

describe('parsePage — frontmatter', () => {
  it('parses YAML data and lists related and cover links', () => {
    const src =
      '---\nsubtitle: Hero\ncover: assets/c.png\nrelated:\n  - "[[Sparda]]"\n  - { link: "[[Game 1]]", label: x, directed: true }\n---\n# T\n';
    const p = parsePage(src);
    expect(p.frontmatter?.data?.subtitle).toBe('Hero');
    expect(src.slice(...p.frontmatter!.range)).toMatch(/^---\n[\s\S]*\n---$/);
    expect(p.links.map((l) => [l.kind, l.target])).toEqual([
      ['cover', 'assets/c.png'],
      ['related', 'Sparda'],
      ['related', 'Game 1'],
    ]);
  });

  it('reports malformed YAML without failing the body', () => {
    const p = parsePage('---\ntags: [unclosed\n---\n[[target]]\n');
    expect(p.frontmatter?.data).toBeNull();
    expect(p.frontmatter?.error).toBeTruthy();
    expect(p.links.map((l) => l.target)).toEqual(['target']);
  });

  it('a note opening with a `---` rule that nothing closes keeps its lists and quotes (final review C1)', () => {
    // remark-frontmatter's construct, failing at the end of the note, left
    // every later line without its containers: lists and quotes read as
    // paragraphs.
    const types = (src: string) => parsePage(src).tree.children.map((n) => n.type);
    expect(types('---\n\n> quote\n\n- item\n\n# h\n')).toEqual([
      'thematicBreak',
      'blockquote',
      'list',
      'heading',
    ]);
    expect(types('---\r\nPara\r\n\r\n1. one\r\n')).toEqual(['thematicBreak', 'paragraph', 'list']);
    expect(types('---  \n```\ncode\n```\n\n> q\n')).toEqual([
      'thematicBreak',
      'code',
      'blockquote',
    ]);
    // A closed block is front matter, as before (trailing spaces allowed).
    expect(types('---\na: 1\n---  \n> q\n')).toEqual(['yaml', 'blockquote']);
    expect(types('---\n---\n- x\n')).toEqual(['yaml', 'list']);
    expect(parsePage('---\r\na: 1\r\n---\r\nBody\r\n').frontmatter?.data).toEqual({ a: 1 });
  });
});

describe('review focus: offsets', () => {
  it('positions are UTF-16 offsets that slice the source exactly, after emoji and accents', () => {
    const src = '🎨 Café ñandú → [[Ideas]] and #tag\n';
    const [l] = findAll<WikiLink>(parsePage(src).tree, 'wikiLink');
    expect(slice(src, l)).toBe('[[Ideas]]');
    const [t] = findAll<Tag>(parsePage(src).tree, 'tag');
    expect(slice(src, t)).toBe('#tag');
  });

  it('CRLF files keep exact positions', () => {
    const src = '# Title\r\n\r\nText [[A]]\r\nmore [[B|b]]\r\n';
    const links = findAll<WikiLink>(parsePage(src).tree, 'wikiLink');
    expect(links.map((l) => slice(src, l))).toEqual(['[[A]]', '[[B|b]]']);
  });

  it('a file starting with a byte-order mark keeps exact positions: the mark is no text (final review I4)', () => {
    const src = '\uFEFF# Title [[A]]\n\nText %%c%% [[B]] #tag\n';
    const page = parsePage(src);
    expect(page.tree.children.map((n) => slice(src, n))).toEqual([
      '# Title [[A]]',
      'Text %%c%% [[B]] #tag',
    ]);
    expect(page.links.map((l) => src.slice(...l.range))).toEqual(['[[A]]', '[[B]]']);
    expect(page.comments.map(([s, e]) => src.slice(s, e))).toEqual(['%%c%%']);
    expect(page.tree.children[0].position!.start).toEqual({ line: 1, column: 2, offset: 1 });
    // Front matter after the mark.
    const fm = '\uFEFF---\na: 1\n---\nBody\n';
    expect(fm.slice(...parsePage(fm).frontmatter!.range)).toBe('---\na: 1\n---');
  });
});

describe('inline extensions keep mdast text values (I6)', () => {
  /** All text a reader sees, as rendered (hast text nodes, in order). */
  const shown = (md: string) => {
    const out: string[] = [];
    const walk = (n: { type: string; value?: string; children?: unknown[] }) => {
      if (n.type === 'text') out.push(n.value!);
      (n.children as (typeof n)[] | undefined)?.forEach(walk);
    };
    walk(toSafeHast(parsePage(md), { sourcePath: 'A.md' }));
    return out.join('');
  };

  it.each([
    ['a link in a quote', '> see [[x]] and\n> more\n', 'see x and\nmore'],
    ['a link in a callout', '> [!note] T\n> see [[x]] and\n> more\n', 'T\nsee x and\nmore'],
    ['a tag in a quote', '> see #t and\n> more\n', 'see #t and\nmore'],
    ['a highlight in a quote', '> see ==hi== and\n> more\n', 'see hi and\nmore'],
    ['a highlight across lines', '> see ==a\n> b== and\n> more\n', 'see a\nb and\nmore'],
    ['a nested quote in a list', '- > a [[x]] b\n  > c\n', 'a x b\nc'],
    ['trailing space and escapes', 'a [[x]] \\*b\\* &amp; \nc\n', 'a x *b* &\nc'],
  ])('%s: no quote markers or escapes leak', (_, md, text) => {
    expect(shown(md).trim()).toBe(text);
  });
});

describe('parsePage — maths (M4b part 2 §3)', () => {
  const kinds = (text: string) => [
    ...findAll(parsePage(text).tree, 'math').map((n) => n.type),
    ...findAll(parsePage(text).tree, 'inlineMath').map((n) => n.type),
  ];

  it('reads $inline$ and $$block$$ as maths', () => {
    const page = parsePage('Energy is $E = mc^2$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n');
    const [inline] = findAll(page.tree, 'inlineMath');
    const [block] = findAll(page.tree, 'math');
    expect((inline as unknown as { value: string }).value).toBe('E = mc^2');
    expect((block as unknown as { value: string }).value).toBe('\\int_0^1 x\\,dx');
  });

  it('prices and escaped dollars stay text, as in Obsidian', () => {
    expect(kinds('It costs $5 and $10 today.\n')).toEqual([]);
    expect(kinds('Not maths: \\$x\\$.\n')).toEqual([]);
    expect(kinds('A $ x$ and $y $ too.\n')).toEqual([]);
    expect(parsePage('It costs $5 and $10 today.\n').tree.children[0]).toMatchObject({
      type: 'paragraph',
    });
  });

  it('a #tag inside maths is not a tag; one outside still is', () => {
    expect(parsePage('$a #fake$ and #real\n').tags).toEqual(['real']);
  });

  // Pandoc's rules (final review I2): a `$` opens maths before a non-space
  // and not right after a letter or digit; the next `$` closes it only
  // after a non-space and not before a digit — else neither is maths.
  it.each([
    '$10-$20',
    '$5.99/$6.99',
    '($5)($10)',
    'US$5 and US$10',
    'Pay $5 for [[Shop]]/$10',
    'Pay 5$ or 10$ now',
    'From $x$5 on',
  ])('prices stay text: %s', (text) => {
    expect(kinds(`${text}\n`)).toEqual([]);
  });

  it('a link between two prices is still a link', () => {
    expect(parsePage('Pay $5 for [[Shop]]/$10\n').links.map((l) => l.target)).toEqual(['Shop']);
  });

  it('markup between two prices still renders', () => {
    expect(findAll(parsePage('Was $10, **now** $20.\n').tree, 'strong')).toHaveLength(1);
  });

  it('a dollar that is no opener leaves a later pair to be maths', () => {
    const page = parsePage('Pay $5 for $x$ today.\n');
    expect(
      findAll(page.tree, 'inlineMath').map((n) => (n as unknown as { value: string }).value),
    ).toEqual(['x']);
  });

  it.each([
    ['$x$', 'inlineMath'],
    ['$\\alpha$', 'inlineMath'],
    ['($x$)', 'inlineMath'],
    ['$x$, then', 'inlineMath'],
    ['$$10-$$', 'inlineMath'],
    ['$$\na + b\n$$', 'math'],
  ])('maths still reads: %s', (text, kind) => {
    expect(kinds(`${text}\n`)).toEqual([kind]);
  });
});
