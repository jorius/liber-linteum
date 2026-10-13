import { describe, expect, it } from 'vitest';
import { validateName } from './nameRules';

describe('nameRules (mirror of the backend rule, M1a amendment 9)', () => {
  it.each(['Notes', 'Café ñandú', 'v1.2 draft', 'Untitled 3'])('accepts %s', (n) => {
    expect(validateName(n)).toBeNull();
  });

  it('rejects empty, hidden and forbidden names with the reason', () => {
    expect(validateName('   ')).toEqual({ key: 'empty' });
    expect(validateName('.secret')).toEqual({ key: 'hidden' });
    expect(validateName('C# notes')).toEqual({ key: 'forbidden', char: '#' });
    for (const c of ['/', '\\', '|', '^', '[', ']', ':', '*', '"', '<', '>', '?']) {
      expect(validateName(`a${c}b`)).toEqual({ key: 'forbidden', char: c });
    }
    expect(validateName('tab\there')).toEqual({ key: 'forbidden', char: '\t' });
  });
});
