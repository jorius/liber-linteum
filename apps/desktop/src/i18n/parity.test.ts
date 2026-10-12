import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import es from './locales/es.json';
import { findMissingKeys } from './parity';

describe('NFR-07 locale key parity', () => {
  it('reports nothing when locales match', () => {
    expect(findMissingKeys({ en: { a: { b: 'x' } }, es: { a: { b: 'y' } } })).toEqual([]);
  });

  it('reports keys missing from any locale, sorted', () => {
    const missing = findMissingKeys({ en: { a: 'x', b: { c: 'y' } }, es: { a: 'x', z: 'extra' } });
    expect(missing).toEqual(['en: z', 'es: b.c']);
  });

  it('shipped en and es locales are in parity', () => {
    expect(findMissingKeys({ en, es })).toEqual([]);
  });
});
