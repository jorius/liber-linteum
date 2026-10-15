import { describe, expect, it } from 'vitest';
import { fold, highlightParts, pathTrail, queryWords, takeFilterWord } from './highlight';

describe('search text helpers (M5 §4)', () => {
  it('folds accents and case, and splits words like the index', () => {
    expect(fold('CANCIÓN')).toBe('cancion');
    expect(queryWords('Canción "del" dra-gón, #lore')).toEqual([
      'cancion',
      'del',
      'dra',
      'gon',
      'lore',
    ]);
    expect(queryWords('*** - ')).toEqual([]);
  });

  it('highlights word starts, accent-insensitively', () => {
    expect(highlightParts('Canción del dragón', ['cancion'])).toEqual([
      { text: 'Canción', hit: true },
      { text: ' del dragón', hit: false },
    ]);
    expect(highlightParts('Canción del dragón', ['drag'])).toEqual([
      { text: 'Canción del ', hit: false },
      { text: 'drag', hit: true },
      { text: 'ón', hit: false },
    ]);
    // The longest matching word wins; mid-word text never matches.
    expect(highlightParts('undragon dragonfly', ['drag', 'dragonf'])).toEqual([
      { text: 'undragon ', hit: false },
      { text: 'dragonf', hit: true },
      { text: 'ly', hit: false },
    ]);
    expect(highlightParts('Plain', [])).toEqual([{ text: 'Plain', hit: false }]);
    expect(highlightParts('', ['x'])).toEqual([]);
  });

  it('turns filter words into chips (Space needs whitespace after, Enter not)', () => {
    expect(takeFilterWord('red #lore ', false)).toEqual({
      rest: 'red ',
      filter: { kind: 'tag', value: 'lore' },
    });
    expect(takeFilterWord('red #lore', false)).toBeNull();
    expect(takeFilterWord('red #lore', true)?.filter).toEqual({ kind: 'tag', value: 'lore' });
    expect(takeFilterWord('#lore/places/ ', false)?.filter.value).toBe('lore/places');
    expect(takeFilterWord('in:"Game design"', true)).toEqual({
      rest: '',
      filter: { kind: 'in', value: 'Game design' },
    });
    expect(takeFilterWord('in:"Game des', true)?.filter.value).toBe('Game des');
    expect(takeFilterWord('in:"Game des ', false)).toBeNull();
    expect(takeFilterWord('x To:Rex', true)).toEqual({
      rest: 'x ',
      filter: { kind: 'to', value: 'Rex' },
    });
    expect(takeFilterWord('from:Session ', false)?.filter).toEqual({
      kind: 'from',
      value: 'Session',
    });
    for (const text of ['email@x ', 'a#b ', '# ', '#123 ', 'in: ', 'into:x ', 'to:"" ']) {
      expect(takeFilterWord(text, true), text).toBeNull();
    }
  });

  it('shows a path as a trail', () => {
    expect(pathTrail('Lore/Dragons/Smaug.md')).toBe('Lore › Dragons › Smaug.md');
    expect(pathTrail('Root.md')).toBe('Root.md');
  });
});
