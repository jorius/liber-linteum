import { describe, expect, it } from 'vitest';
import { setFrontmatter, type TextChange } from './frontmatterEdit';

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
