import { describe, expect, it } from 'vitest';
import { detectEol, fromLf, toLf } from './eol';
import { merge3 } from './merge';

describe('merge3 (ED-08: 3-way merge of external changes)', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n';

  it('merges edits on separate lines', () => {
    const mine = 'one\nTWO\nthree\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree\nfour\nFIVE\n';
    expect(merge3(base, mine, theirs)).toEqual({
      clean: true,
      text: 'one\nTWO\nthree\nfour\nFIVE\n',
    });
  });

  it('takes the other side when only one side changed', () => {
    expect(merge3(base, base, 'x\n')).toEqual({ clean: true, text: 'x\n' });
    expect(merge3(base, 'y\n', base)).toEqual({ clean: true, text: 'y\n' });
    expect(merge3(base, 'same\n', 'same\n')).toEqual({ clean: true, text: 'same\n' });
  });

  it('reports overlapping edits as a conflict', () => {
    const mine = 'one\ntwo\nMINE\nfour\nfive\n';
    const theirs = 'one\ntwo\nTHEIRS\nfour\nfive\n';
    expect(merge3(base, mine, theirs)).toEqual({ clean: false });
  });

  it('merges an identical change made on both sides (false conflict)', () => {
    const mine = 'one\nTWO\nthree\nfour\nFIVE\n';
    const theirs = 'one\nTWO\nthree\nfour\nfive\n';
    expect(merge3(base, mine, theirs)).toEqual({ clean: true, text: mine });
  });
});

describe('line endings (CRLF files stay CRLF)', () => {
  it('detects the first line ending and converts both ways', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(detectEol('a\nb\r\n')).toBe('\n');
    expect(detectEol('no newline')).toBe('\n');
    expect(toLf('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(fromLf('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
    expect(fromLf('a\nb\n', '\n')).toBe('a\nb\n');
  });
});
