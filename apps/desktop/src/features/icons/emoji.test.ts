import { describe, expect, it } from 'vitest';
import { loadEmoji, rememberIcon, recentIcons, searchEmoji } from './emoji';

describe('the bundled emoji list (M5b §4)', () => {
  it('has the groups in order, without skin tones or the component group', async () => {
    const groups = await loadEmoji();
    expect(groups.map((g) => g.id)).toEqual([
      'smileys-emotion',
      'people-body',
      'animals-nature',
      'food-drink',
      'travel-places',
      'activities',
      'objects',
      'symbols',
      'flags',
    ]);
    const all = groups.flatMap((g) => g.items.map((i) => i[0]));
    expect(all).toContain('🚀');
    expect(all.some((e) => /[\u{1F3FB}-\u{1F3FF}]/u.test(e))).toBe(false);
  });

  it('finds emoji by English or Spanish name, ignoring case and accents', async () => {
    const groups = await loadEmoji();
    expect(searchEmoji(groups, 'rocket')).toContain('🚀');
    expect(searchEmoji(groups, 'Cohete')).toContain('🚀');
    expect(searchEmoji(groups, 'corazon rojo')).toContain('❤️');
    expect(searchEmoji(groups, 'corazón')).toContain('❤️');
    expect(searchEmoji(groups, 'zzzqqq')).toEqual([]);
    // A name match ranks above a keyword match (astronauts have "cohete").
    expect(searchEmoji(groups, 'cohete')[0]).toBe('🚀');
    // An exact name first ("dragon face" comes earlier in the list).
    expect(searchEmoji(groups, 'Dragon')[0]).toBe('🐉');
  });

  it('keeps recent picks, newest first, without repeats', () => {
    localStorage.clear();
    rememberIcon('🚀');
    rememberIcon('🐉');
    rememberIcon('🚀');
    expect(recentIcons()).toEqual(['🚀', '🐉']);
  });
});
