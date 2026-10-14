import { describe, expect, it } from 'vitest';
import { setFrontmatter, type TextChange } from './frontmatterEdit';
import { parsePage } from './parse';

/** Applies the edit (or returns the text unchanged / `null` when refused). */
function edit(text: string, patch: Parameters<typeof setFrontmatter>[1]): string | null {
  const res = setFrontmatter(text, patch);
  if (!res.ok) return null;
  const c: TextChange | null = res.change;
  return c ? text.slice(0, c.from) + c.insert + text.slice(c.to) : text;
}

describe('setFrontmatter (M2c §4)', () => {
  it('creates a frontmatter block when the note has none', () => {
    expect(edit('# Rex\n\nBody\n', { subtitle: 'Hero redesign' })).toBe(
      '---\nsubtitle: Hero redesign\n---\n# Rex\n\nBody\n',
    );
    expect(edit('', { cover: 'attachments/x.png' })).toBe('---\ncover: attachments/x.png\n---\n');
  });

  it('updates and adds keys, keeping order, comments, quoting and other keys', () => {
    const text = [
      '---',
      '# kept comment',
      'title: "Rex"',
      'subtitle: Old',
      'tags: [a, b]',
      'related:',
      '  - "[[Sparda]]"',
      '---',
      'Body',
      '',
    ].join('\n');
    expect(edit(text, { subtitle: 'New: v3', 'cover-y': 40 })).toBe(
      [
        '---',
        '# kept comment',
        'title: "Rex"',
        'subtitle: "New: v3"',
        'tags: [a, b]',
        'related:',
        '  - "[[Sparda]]"',
        'cover-y: 40',
        '---',
        'Body',
        '',
      ].join('\n'),
    );
  });

  it('the change spans only the frontmatter block', () => {
    const text = '---\nsubtitle: a\n---\n# Title\n\nlong body…\n';
    const res = setFrontmatter(text, { subtitle: 'b' });
    expect(res.ok && res.change).toEqual({ from: 4, to: 16, insert: 'subtitle: b\n' });
  });

  it('deletes keys; an emptied block is removed entirely', () => {
    const text = '---\ncover: a.png\ncover-y: 30\nsubtitle: S\n---\nBody\n';
    expect(edit(text, { cover: null, 'cover-y': null })).toBe('---\nsubtitle: S\n---\nBody\n');
    expect(edit('---\nsubtitle: S\n---\nBody\n', { subtitle: null })).toBe('Body\n');
    // A comment keeps the block.
    expect(edit('---\n# note\nsubtitle: S\n---\nBody\n', { subtitle: null })).toBe(
      '---\n# note\n---\nBody\n',
    );
  });

  it('no-ops: deleting a missing key, setting the same value', () => {
    expect(setFrontmatter('Body\n', { subtitle: null })).toEqual({ ok: true, change: null });
    expect(setFrontmatter('---\nsubtitle: S\n---\n', { subtitle: 'S' })).toEqual({
      ok: true,
      change: null,
    });
  });

  it('refuses invalid YAML and non-mapping frontmatter (never rewrites them)', () => {
    expect(setFrontmatter('---\nsubtitle: [unclosed\n---\nBody\n', { subtitle: 'x' })).toEqual({
      ok: false,
    });
    expect(setFrontmatter('---\n- a\n- b\n---\nBody\n', { subtitle: 'x' })).toEqual({ ok: false });
  });

  it('an empty block (---/---) is filled in place', () => {
    expect(edit('---\n---\nBody\n', { subtitle: 'S' })).toBe('---\nsubtitle: S\n---\nBody\n');
  });

  it('a leading thematic break is not frontmatter', () => {
    expect(edit('---\n\nText\n', { subtitle: 'S' })).toBe('---\nsubtitle: S\n---\n---\n\nText\n');
  });
});

describe('setFrontmatter never corrupts the frontmatter (final review C2)', () => {
  it('empty values (Obsidian templates: `cover:`) get the value after the colon', () => {
    const text = '---\ntags:\n  - project\ncover:\nsubtitle:\ncover-y:\n---\n# T\n';
    expect(edit(text, { cover: 'attachments/x.png' })).toBe(
      '---\ntags:\n  - project\ncover: attachments/x.png\nsubtitle:\ncover-y:\n---\n# T\n',
    );
    expect(edit(text, { subtitle: 'Hi' })).toBe(
      '---\ntags:\n  - project\ncover:\nsubtitle: Hi\ncover-y:\n---\n# T\n',
    );
    expect(edit(text, { 'cover-y': 30 })).toBe(
      '---\ntags:\n  - project\ncover:\nsubtitle:\ncover-y: 30\n---\n# T\n',
    );
    // Trailing space after the colon, and a space before it: the pair is
    // rewritten as `key: value`.
    expect(edit('---\ncover: \nb: 1\n---\n', { cover: 'x.png' })).toBe(
      '---\ncover: x.png\nb: 1\n---\n',
    );
    expect(edit('---\ncover :\nb: 1\n---\n', { cover: 'x.png' })).toBe(
      '---\ncover: x.png\nb: 1\n---\n',
    );
  });

  it('an empty value with a comment keeps the comment after the new value', () => {
    expect(edit('---\ncover: # todo\ntags: [a]\n---\n', { cover: 'x.png' })).toBe(
      '---\ncover: x.png # todo\ntags: [a]\n---\n',
    );
    // A comment on the next line stays where it is.
    expect(edit('---\ncover:   # todo\n# next\ntags: [a]\n---\n', { cover: 'x.png' })).toBe(
      '---\ncover: x.png # todo\n# next\ntags: [a]\n---\n',
    );
  });

  it('a block-scalar value is replaced as a whole', () => {
    expect(
      edit('---\nsubtitle: |\n  old line\ntags: [a, b]\n---\n# T\n', { subtitle: 'New' }),
    ).toBe('---\nsubtitle: New\ntags: [a, b]\n---\n# T\n');
    expect(
      edit('---\nsubtitle: >-\n  old\n  line\n\ncover: a.png\n---\n# T\n', { subtitle: 'New' }),
    ).toBe('---\nsubtitle: New\n\ncover: a.png\n---\n# T\n');
  });

  it('a tagged value is replaced as a whole (the tag would change its type)', () => {
    expect(edit('---\ncover-y: !!str 30\n---\n', { 'cover-y': 40 })).toBe(
      '---\ncover-y: 40\n---\n',
    );
    expect(edit('---\ncover: !!null\nb: 1\n---\n', { cover: 'x.png' })).toBe(
      '---\ncover: x.png\nb: 1\n---\n',
    );
  });

  it('a collection value is replaced with a scalar, keeping a trailing comment', () => {
    expect(edit('---\ncover: [a.png] # old\nb: 1\n---\n', { cover: 'x.png' })).toBe(
      '---\ncover: x.png # old\nb: 1\n---\n',
    );
    expect(edit('---\ncover:\n  - a.png\nb: 1\n---\n', { cover: 'x.png' })).toBe(
      '---\ncover: x.png\nb: 1\n---\n',
    );
  });

  it('an indented block map keeps its indentation when keys are added or removed', () => {
    const text = '---\n  cover: a.png\n  tags: [x]\n---\nB\n';
    expect(edit(text, { subtitle: 'S' })).toBe(
      '---\n  cover: a.png\n  tags: [x]\n  subtitle: S\n---\nB\n',
    );
    expect(edit(text, { cover: null })).toBe('---\n  tags: [x]\n---\nB\n');
    expect(edit('---\n  a: 1\n  cover: x\n  b: 2\n---\n', { cover: null })).toBe(
      '---\n  a: 1\n  b: 2\n---\n',
    );
  });

  it('flow-mapping frontmatter is edited only when the result is right, else refused', () => {
    const text = '---\n{subtitle: a, cover: x.png}\n---\nB\n';
    expect(edit(text, { subtitle: 'b' })).toBe('---\n{subtitle: b, cover: x.png}\n---\nB\n');
    expect(setFrontmatter(text, { subtitle: 'b, c' })).toEqual({ ok: false });
    expect(setFrontmatter(text, { subtitle: null })).toEqual({ ok: false });
    expect(setFrontmatter(text, { 'cover-y': 30 })).toEqual({ ok: false });
  });

  it('refuses an edit that would change another key (anchors and aliases)', () => {
    const text = '---\ncover: &c a.png\nother: *c\n---\n';
    expect(setFrontmatter(text, { cover: 'b.png' })).toEqual({ ok: false });
    expect(setFrontmatter(text, { cover: null })).toEqual({ ok: false });
    // Unaliased anchors are fine.
    expect(edit('---\ncover: &c a.png\n---\n', { cover: 'b.png' })).toBe(
      '---\ncover: &c b.png\n---\n',
    );
  });

  it('sweep: every edit either yields exactly the patched values or is refused', () => {
    const texts = [
      '---\ntags:\n  - project\ncover:\nsubtitle:\n---\n# T\n',
      '---\ncover: # todo\ntags: [a]\n---\n',
      '---\nsubtitle: |\n  old line\ntags: [a, b]\n---\n',
      '---\nsubtitle: >-\n  old\n  line\ncover: a.png\n---\n',
      '---\nsubtitle: |+\n  keep\n\n---\n',
      '---\nsubtitle: old # note\ncover: &c a.png\nother: *c\n---\nB\n',
      '---\n{subtitle: a, cover: x.png}\n---\n',
      '---\n  cover: a.png\n  tags: [x]\n---\n',
      '---\nsubtitle:\n  Old value\n  continued\ncover-y: !!str 30\n---\n',
      '---\n"cover": \'a.png\'\n? subtitle\n: S\n---\n',
      '---\ncover: ~\nsubtitle: null\n---\n',
      '---\n# only a comment\n---\n',
      '---\n---\n',
      'No frontmatter\n',
    ];
    const values = [
      'x.png',
      'a: b',
      '#tag',
      'yes',
      '[[Link]]',
      "it's",
      'x #y',
      '- li',
      '{a}',
      '*x',
      '|',
      '',
    ];
    const patches: Parameters<typeof setFrontmatter>[1][] = [
      { cover: null, 'cover-y': null },
      { subtitle: null },
      { 'cover-y': 30 },
      ...values.map((v) => ({ subtitle: v })),
      ...values.map((v) => ({ cover: v, 'cover-y': 55 })),
    ];
    for (const text of texts) {
      const before = parsePage(text).frontmatter?.data ?? {};
      for (const patch of patches) {
        const out = edit(text, patch);
        if (out === null) continue; // refused: the text is left alone
        const fm = parsePage(out).frontmatter;
        const label = JSON.stringify({ text, patch, out });
        expect(fm?.error, label).toBeUndefined();
        const after = fm?.data ?? {};
        for (const key of new Set([
          ...Object.keys(before),
          ...Object.keys(after),
          ...Object.keys(patch),
        ])) {
          const want = key in patch ? (patch[key] ?? undefined) : before[key];
          expect(after[key], `${label} key ${key}`).toEqual(want);
        }
      }
    }
  });
});

describe('setFrontmatter never puts a second block in front of one (final review Minor 2)', () => {
  it('refuses a block closed with `...` (nimw-markdown reads it, remark does not)', () => {
    const text = '---\ntags: [x]\n...\n\nbody\n';
    expect(setFrontmatter(text, { subtitle: 'S' })).toEqual({ ok: false });
    expect(setFrontmatter(text, { cover: null })).toEqual({ ok: false });
  });

  it('refuses a block whose fences have trailing spaces (remark reads it, nimw-markdown does not)', () => {
    expect(setFrontmatter('---\ntitle: a\n--- \n\nbody\n', { subtitle: 'S' })).toEqual({
      ok: false,
    });
    expect(setFrontmatter('--- \ntitle: a\n---\n\nbody\n', { subtitle: 'S' })).toEqual({
      ok: false,
    });
  });

  it('refuses a block after a byte-order mark', () => {
    expect(setFrontmatter('\uFEFF---\ncover: a.png\n---\nB\n', { subtitle: 'S' })).toEqual({
      ok: false,
    });
    expect(setFrontmatter('\uFEFF---\n\nText\n', { subtitle: 'S' })).toEqual({ ok: false });
  });

  it('a leading thematic break with no closing line still gets a new block', () => {
    expect(edit('--- \n\nText\n', { subtitle: 'S' })).toBe('---\nsubtitle: S\n---\n--- \n\nText\n');
    expect(edit('---\n\nText\n\n***\n', { subtitle: 'S' })).toBe(
      '---\nsubtitle: S\n---\n---\n\nText\n\n***\n',
    );
  });
});
