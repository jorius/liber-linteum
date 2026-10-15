import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../stores/settingsStore';
import { widestLine, wideAttrs, wideExtents } from './wideBox';

describe('wide elements box (M4b part 3)', () => {
  it('reaches evenly past a centred measure, up to the scroller less its padding', () => {
    // A 1200 px scroller, the 760 px measure centred: text 260–940.
    expect(wideExtents({ textLeft: 260, textRight: 940, leftBound: 40, rightBound: 1160 })).toEqual(
      { m: 220, r: 220 },
    );
  });

  it('with line numbers beside the measure, keeps the text’s left edge and grows right', () => {
    // A 48 px gutter beside the measure: text 284–964, nothing free on the left.
    expect(
      wideExtents({ textLeft: 284, textRight: 964, leftBound: 284, rightBound: 1160 }),
    ).toEqual({ m: 0, r: 196 });
  });

  it('never reaches a negative distance in a cramped editor', () => {
    expect(wideExtents({ textLeft: 40, textRight: 300, leftBound: 60, rightBound: 280 })).toEqual({
      m: 0,
      r: 0,
    });
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
