import { describe, expect, it } from 'vitest';
import { bodyStart, matchRange } from './matchRange';

const PAGE = `---
subtitle: "The camels rest here."
tags: [place]
---

# Cairn of Teeth

Travellers stop at midday to water the Camels. More camels later.
`;

describe('matchRange', () => {
  it('skips the frontmatter and finds the first body match, ignoring case', () => {
    const r = matchRange(PAGE, 'camels')!;
    expect(PAGE.slice(r.from, r.to)).toBe('Camels');
    expect(r.from).toBeGreaterThan(PAGE.indexOf('water'));
  });

  it('a page without frontmatter starts at 0', () => {
    expect(bodyStart('# Title\n\nText')).toBe(0);
    expect(matchRange('# Title\n\nText', 'title')).toEqual({ from: 2, to: 7 });
  });

  it('an unclosed frontmatter fence is body', () => {
    expect(bodyStart('---\nnot closed\n\nText')).toBe(0);
  });

  it('matches accented words and treats symbols literally', () => {
    const text = 'Cuidado con los mesías (y los [[profetas]]).';
    const r = matchRange(text, 'MESÍAS')!;
    expect(text.slice(r.from, r.to)).toBe('mesías');
    expect(matchRange(text, '[[profetas]]')).not.toBeNull();
    expect(matchRange(text, 'p.o')).toBeNull();
  });

  it('null when the word is gone or empty', () => {
    expect(matchRange(PAGE, 'oasis')).toBeNull();
    expect(matchRange(PAGE, '  ')).toBeNull();
  });
});
