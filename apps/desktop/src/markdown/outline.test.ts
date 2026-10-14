import { describe, expect, it } from 'vitest';
import { headingAt, headingsOf, parentsOf } from './outline';
import { parsePage } from './parse';

const outline = (text: string) => headingsOf(parsePage(text), text);

describe('outline headings (M4b part 2 §5)', () => {
  it('lists H1–H6 with plain text, skipping fences, front matter and comments', () => {
    const text = [
      '---',
      'title: x',
      '---',
      '# Intro **bold** [[Target|alias]] `code`',
      '```md',
      '# not a heading',
      '```',
      '%% # hidden %%',
      '## Next',
      'Setext',
      '------',
      '> # quoted',
      '###### Deep',
    ].join('\n');
    const items = outline(text);
    expect(items.map((h) => [h.level, h.text])).toEqual([
      [1, 'Intro bold alias code'],
      [2, 'Next'],
      [2, 'Setext'],
      [6, 'Deep'],
    ]);
    expect(text.slice(items[0].from, items[0].at)).toBe('# ');
    expect(text.slice(items[1].at).startsWith('Next')).toBe(true);
  });

  it('nests by level, skipped levels included, and finds the section of a position', () => {
    const items = outline('# A\n### B\n## C\nbody\n# D\n');
    expect(parentsOf(items)).toEqual([-1, 0, 0, -1]);
    expect(headingAt(items, 0)).toBe(0);
    expect(headingAt(items, 'x# A\n### B\n## C\nbo'.length)).toBe(2);
    expect(headingAt(outline('text\n# A\n'), 1)).toBe(-1);
  });
});
