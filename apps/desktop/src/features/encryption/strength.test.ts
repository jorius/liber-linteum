import { describe, expect, it } from 'vitest';
import { strength } from './strength';

describe('strength', () => {
  it.each([
    ['correct horse', 'fair'],
    ['aaaaaaaaaaaa', 'weak'],
    ['short', 'tooShort'],
    ['Tr0ub4dor&3xx!', 'strong'],
    ['blue cat sun', 'fair'], // the space is a symbol: 12 * log2(59) = 70.6
  ] as const)('%s is %s', (input, want) => {
    expect(strength(input)).toBe(want);
  });

  it('counts code points: 12 emoji are long enough, 11 are not', () => {
    expect(strength('😀'.repeat(12))).toBe('fair');
    expect(strength('😀'.repeat(11))).toBe('tooShort');
  });
});
