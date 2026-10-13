import type { Node, Parent } from 'mdast';
import { describe, expect, it } from 'vitest';
import type { Callout, Columns, WikiLink } from './types';
import { parsePage } from './parse';
import { findAll } from './walk';

describe('callouts (M2a §2.1, Tier B toggles)', () => {
  it('turns > [!type] Title into a callout with the remaining lines as content', () => {
    const p = parsePage('> [!note] Remember\n> Body with [[Link]]\n');
    const [c] = findAll<Callout>(p.tree, 'callout');
    expect([c.calloutType, c.title, c.foldable, c.folded]).toEqual([
      'note',
      'Remember',
      false,
      false,
    ]);
    expect(findAll<WikiLink>(c, 'wikiLink').map((l) => l.target)).toEqual(['Link']);
    expect(JSON.stringify(c.children)).not.toContain('[!note]');
  });

  it('reads foldable markers and defaults the title to the type', () => {
    const p = parsePage('> [!TIP]- \n> hidden\n\n> [!warning]+ Open\n> shown\n\n> plain quote\n');
    const callouts = findAll<Callout>(p.tree, 'callout');
    expect(callouts.map((c) => [c.calloutType, c.title, c.foldable, c.folded])).toEqual([
      ['tip', 'Tip', true, true],
      ['warning', 'Open', true, false],
    ]);
    expect(findAll(p.tree, 'blockquote')).toHaveLength(1);
  });
});

describe('callout titles keep inline content (I7, parity with nimw-markdown)', () => {
  const callout = (src: string) => findAll<Callout>(parsePage(src).tree, 'callout')[0];

  it('a link in the title is a link', () => {
    const c = callout('> [!note] Title [[x]]\n> body\n');
    const [title, body] = c.children;
    expect(title.type).toBe('calloutTitle');
    expect(findAll<WikiLink>(title, 'wikiLink').map((l) => l.target)).toEqual(['x']);
    expect(c.title).toBe('Title [[x]]');
    expect(findAll(body, 'wikiLink')).toEqual([]);
  });

  it('bold in the title stays in the title; the body starts on the next line', () => {
    const src = '> [!note] Title **bold** end\n> body **b2**\n';
    const c = callout(src);
    const [title, body] = c.children as Parent[];
    expect(title.children.map((n) => n.type)).toEqual(['text', 'strong', 'text']);
    expect(body.type).toBe('paragraph');
    expect(body.children.map((n) => n.type)).toEqual(['text', 'strong']);
    const at = (n: Node) => src.slice(n.position!.start.offset!, n.position!.end.offset!);
    expect(at(title)).toBe('Title **bold** end');
    expect(at(body.children[0])).toBe('> body ');
  });

  it('an empty title has no title node, and the body keeps its first line', () => {
    const c = callout('> [!TIP]- \n> hidden\n');
    expect(c.children.map((n) => n.type)).toEqual(['paragraph']);
    expect(c.title).toBe('Tip');
    expect(JSON.stringify(c.children)).toContain('"value":"hidden"');
  });
});

describe('columns (Tier B)', () => {
  it('maps ::::columns / :::column containers to columns and column nodes', () => {
    const src = '::::columns\n:::column\nLeft [[A]]\n:::\n:::column\nRight\n:::\n::::\n';
    const p = parsePage(src);
    const [cols] = findAll<Columns>(p.tree, 'columns');
    expect(cols.children.map((c) => c.type)).toEqual(['column', 'column']);
    expect(src.slice(cols.position!.start.offset!, cols.position!.end.offset!)).toBe(src.trimEnd());
    expect(p.links.map((l) => l.target)).toEqual(['A']);
  });

  it('never turns ordinary colons into directives', () => {
    const p = parsePage('Ratio 3:2, note:hello, time 10:30, a :b c\n\n::leaf[x]\n');
    const text = JSON.stringify(p.tree);
    expect(text).not.toContain('Directive');
    expect(text).toContain('note:hello');
    expect(text).toContain('::leaf[x]');
  });
});

describe('comments %% … %%', () => {
  it('records inline and block comments and leaves them out of the tree and links', () => {
    const src = 'a %%hidden [[X]]%% b\n\n%%\nblock [[Y]]\n%%\n\nafter [[Z]]\n';
    const p = parsePage(src);
    expect(p.comments.map(([s, e]) => src.slice(s, e))).toEqual([
      '%%hidden [[X]]%%',
      '%%\nblock [[Y]]\n%%',
    ]);
    expect(p.links.map((l) => l.target)).toEqual(['Z']);
    expect(JSON.stringify(p.tree)).not.toContain('hidden');
  });

  it('ignores %% inside code and unclosed %%', () => {
    const p = parsePage('`%%code%%` and %%open [[A]]\n');
    expect(p.comments).toEqual([]);
    expect(p.links.map((l) => l.target)).toEqual(['A']);
  });
});
