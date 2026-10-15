import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../stores/settingsStore';
import { widestLine, wideAttrs, wideMax } from './wideBox';

describe('wide elements box (M4b part 3)', () => {
  it('is the scroller less the gutter and both side paddings', () => {
    expect(wideMax(1200, 0, 40)).toBe(1120);
    // Line numbers on: the box stays clear of the gutter.
    expect(wideMax(1200, 48, 40)).toBe(1072);
    // Never negative in a collapsed editor.
    expect(wideMax(50, 48, 40)).toBe(0);
  });

  it('names the kinds that go wide, only on a wide page', () => {
    const kinds = DEFAULT_SETTINGS.wideElements;
    expect(wideAttrs('wide', kinds)).toEqual({ 'data-wide-tables': '', 'data-wide-diagrams': '' });
    expect(wideAttrs('wide', { ...kinds, code: true, tables: false })).toEqual({
      'data-wide-code': '',
      'data-wide-diagrams': '',
    });
    expect(wideAttrs('readable', kinds)).toEqual({});
    expect(wideAttrs('full', kinds)).toEqual({});
  });

  it('measures a block by its widest line, a tab as four columns', () => {
    expect(widestLine(['ab', '\tcd', 'efghi'])).toBe(6);
    expect(widestLine([])).toBe(0);
  });
});
