import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { frontmatterLinks, readFrontmatter } from './frontmatter';
import { parsePage } from './parse';
import { appendRelated, readRelated, removeRelated, updateRelated } from './related';
import type { FrontmatterEdit } from './frontmatterEdit';

const apply = (text: string, edit: FrontmatterEdit): string => {
  if (!edit.ok) throw new Error('refused');
  const c = edit.change;
  return c ? text.slice(0, c.from) + c.insert + text.slice(c.to) : text;
};

/** The note's frontmatter as data. */
const data = (text: string) => {
  const m = /^---\n([\s\S]*?\n)?---(?:\n|$)/.exec(text);
  return m ? (parseYaml(m[1] ?? '') ?? {}) : {};
};

describe('reading related: (M3b §5)', () => {
  it('lists string and map entries with their targets, labels and arrows', () => {
    const text =
      '---\nrelated:\n  - "[[Sparda]]"\n  - { link: "[[Game 1#Plan|the game]]", label: playable, directed: true }\n  - link: "[[Z]]"\n    label: zed\n  - not a link\n---\nBody\n';
    expect(readRelated(text)).toEqual([
      { index: 0, link: '[[Sparda]]', target: 'Sparda', label: null, directed: false },
      {
        index: 1,
        link: '[[Game 1#Plan|the game]]',
        target: 'Game 1',
        label: 'playable',
        directed: true,
      },
      { index: 2, link: '[[Z]]', target: 'Z', label: 'zed', directed: false },
    ]);
  });

  it('reads a single relationship written without a list, and a flow list', () => {
    expect(readRelated('---\nrelated: "[[A]]"\n---\n').map((e) => e.target)).toEqual(['A']);
    expect(readRelated('---\nrelated: ["[[A]]", "[[B]]"]\n---\n').map((e) => e.target)).toEqual([
      'A',
      'B',
    ]);
    expect(readRelated('# No frontmatter\n')).toEqual([]);
    expect(readRelated('---\nrelated: [oops\n---\n')).toEqual([]);
  });

  it('the link reader counts a scalar related: too (parity with nimw-markdown)', () => {
    const fm = readFrontmatter(parsePage('---\nrelated: "[[A]]"\n---\n# x\n').tree);
    expect(frontmatterLinks(fm).map((l) => [l.kind, l.target])).toEqual([['related', 'A']]);
  });
});

describe('appending a relationship (M3b §2, §5)', () => {
  it('starts a frontmatter block when the note has none', () => {
    expect(apply('# Title\n', appendRelated('# Title\n', 'Sparda'))).toBe(
      '---\nrelated:\n  - "[[Sparda]]"\n---\n# Title\n',
    );
  });

  it('adds the key after the others, leaving them byte for byte', () => {
    const text = "---\ntitle: 'Rex'   # kept\ntags: [a, b]\n---\nBody\n";
    expect(apply(text, appendRelated(text, 'Sparda'))).toBe(
      '---\ntitle: \'Rex\'   # kept\ntags: [a, b]\nrelated:\n  - "[[Sparda]]"\n---\nBody\n',
    );
  });

  it('adds an item after the last one, with the list’s own indentation', () => {
    const text = '---\nrelated:\n    - "[[A]]"\n    - link: "[[B]]"\n      label: x\nz: 1\n---\n';
    expect(apply(text, appendRelated(text, 'C'))).toBe(
      '---\nrelated:\n    - "[[A]]"\n    - link: "[[B]]"\n      label: x\n    - "[[C]]"\nz: 1\n---\n',
    );
  });

  it('turns a flow list or a single value into a block list', () => {
    const flow = '---\nrelated: ["[[A]]", { link: "[[B]]", label: x }]\nz: 1\n---\n';
    expect(apply(flow, appendRelated(flow, 'C'))).toBe(
      '---\nrelated:\n  - "[[A]]"\n  - { link: "[[B]]", label: x }\n  - "[[C]]"\nz: 1\n---\n',
    );
    const one = '---\nrelated: "[[A]]"\n---\n';
    expect(apply(one, appendRelated(one, 'C'))).toBe(
      '---\nrelated:\n  - "[[A]]"\n  - "[[C]]"\n---\n',
    );
    // An empty key (as templates leave it) gets its first item.
    const empty = '---\nrelated:\nz: 1\n---\n';
    expect(apply(empty, appendRelated(empty, 'C'))).toBe('---\nrelated:\n  - "[[C]]"\nz: 1\n---\n');
  });

  it('refuses frontmatter it can’t edit safely, and never doubles a block', () => {
    expect(appendRelated('---\nrelated: [oops\n---\n', 'A')).toEqual({ ok: false });
    expect(appendRelated('---\nx: &a [1]\nrelated: *a\n---\n', 'A')).toEqual({ ok: false });
    expect(appendRelated('---\r\nrelated: []\r\n---\r\n', 'A')).toEqual({ ok: false });
  });
});

describe('editing and deleting a relationship (M3b §3, §5)', () => {
  const text =
    '---\nrelated:\n  - "[[A]]"   # first\n  - { link: "[[B]]", label: old, directed: true }\n  - link: "[[C]]"\n    label: multi\nz: 1\n---\nBody\n';

  it('a label or an arrow turns a string into a map; removing both turns it back', () => {
    const labelled = apply(text, updateRelated(text, 0, { label: 'inspired by', directed: false }));
    expect(labelled).toContain('  - { link: "[[A]]", label: inspired by }   # first\n');
    const plain = apply(text, updateRelated(text, 1, { label: null, directed: false }));
    expect(plain).toContain('  - "[[B]]"\n');
    const arrow = apply(text, updateRelated(text, 2, { label: 'multi', directed: true }));
    expect(arrow).toContain('  - { link: "[[C]]", label: multi, directed: true }\nz: 1\n');
    expect(data(arrow).z).toBe(1);
  });

  it('labels with commas, colons or line breaks stay one valid item', () => {
    const out = apply(text, updateRelated(text, 0, { label: 'a, b: c\n d', directed: false }));
    expect(data(out).related[0]).toEqual({ link: '[[A]]', label: 'a, b: c d' });
  });

  it('deleting removes the item’s lines; the last one removes the key', () => {
    const one = apply(text, removeRelated(text, 1));
    expect(one).toBe(
      '---\nrelated:\n  - "[[A]]"   # first\n  - link: "[[C]]"\n    label: multi\nz: 1\n---\nBody\n',
    );
    const multi = apply(text, removeRelated(text, 2));
    expect(multi).toBe(
      '---\nrelated:\n  - "[[A]]"   # first\n  - { link: "[[B]]", label: old, directed: true }\nz: 1\n---\nBody\n',
    );
    const last = '---\ntitle: x\nrelated:\n  - "[[A]]"\n---\nBody\n';
    expect(apply(last, removeRelated(last, 0))).toBe('---\ntitle: x\n---\nBody\n');
    const only = '---\nrelated: "[[A]]"\n---\nBody\n';
    expect(apply(only, removeRelated(only, 0))).toBe('Body\n');
    const flow = '---\nrelated: ["[[A]]", "[[B]]"]\n---\n';
    expect(data(apply(flow, removeRelated(flow, 0))).related).toEqual(['[[B]]']);
  });

  it('an index that isn’t there is refused', () => {
    expect(removeRelated(text, 7)).toEqual({ ok: false });
    expect(updateRelated(text, -1, { label: null, directed: false })).toEqual({ ok: false });
  });
});

describe('sweep: every relationship edit reads back exactly or is refused', () => {
  const texts = [
    '# none\n',
    '---\n---\nBody\n',
    '---\ntitle: x\n---\n',
    '---\nrelated:\n  - "[[A]]"\n---\n',
    '---\nrelated:\n- "[[A]]"\n- "[[B]]"\n---\n',
    '---\nrelated: ["[[A]]"]\n---\n',
    '---\nrelated: "[[A]]"\n---\n',
    '---\nrelated: { link: "[[A]]", label: x }\n---\n',
    '---\nrelated:\n  - link: "[[A]]"\n    directed: true\n  # a comment\n  - "[[B]]"\nz: [1, 2]\n---\n',
    '---\nrelated:\n---\n',
    '---\nrelated: []\n---\n',
    '---\n  related:\n    - "[[A]]"\n  y: 1\n---\n',
    '---\nrelated: |\n  [[A]]\n---\n',
    '---\nrelated: [oops\n---\n',
  ];
  it.each(texts)('%j', (text) => {
    const ops: [string, (t: string) => FrontmatterEdit][] = [
      ['append', (t) => appendRelated(t, 'New')],
      ['label 0', (t) => updateRelated(t, 0, { label: 'why, not', directed: true })],
      ['plain 0', (t) => updateRelated(t, 0, { label: null, directed: false })],
      ['remove 0', (t) => removeRelated(t, 0)],
      ['remove 1', (t) => removeRelated(t, 1)],
    ];
    for (const [name, op] of ops) {
      const edit = op(text);
      if (!edit.ok) continue;
      const out = apply(text, edit);
      // The result parses, and the body after the block is untouched.
      expect(() => data(out), name).not.toThrow();
      expect(parsePage(out).frontmatter?.error, name).toBeUndefined();
      const body = (t: string) => t.replace(/^---\n[\s\S]*?\n?---(?:\n|$)/, '');
      expect(body(out), name).toBe(body(text));
    }
  });
});
