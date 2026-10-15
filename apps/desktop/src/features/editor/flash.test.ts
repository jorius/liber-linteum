import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLASH_MS, flash, jumpTo } from './flash';

afterEach(() => vi.useRealTimers());

function view(doc: string) {
  const parent = document.createElement('div');
  document.body.append(parent);
  return new EditorView({ parent, state: EditorState.create({ doc, extensions: [flash] }) });
}

const flashed = (v: EditorView) =>
  [...v.dom.querySelectorAll('.cm-nimw-flash')].map((el) => el.textContent);

describe('jump and flash (M4b part 3 §6: an atom clicked in the Global View)', () => {
  it('puts the cursor on the block and flashes its lines for a second', () => {
    vi.useFakeTimers();
    const v = view('intro\n\nfirst line\nsecond line\n\nafter');
    jumpTo(v, 7, 29);
    expect(v.state.selection.main.head).toBe(7);
    expect(flashed(v)).toEqual(['first line', 'second line']);
    vi.advanceTimersByTime(FLASH_MS);
    expect(flashed(v)).toEqual([]);
    v.destroy();
  });

  it('offsets past the end of a text that changed since are clamped', () => {
    const v = view('short');
    jumpTo(v, 40, 90);
    expect(v.state.selection.main.head).toBe(5);
    v.destroy();
  });

  it('a destroyed view is left alone when the flash ends', () => {
    vi.useFakeTimers();
    const v = view('a\nb');
    jumpTo(v, 0, 1);
    v.destroy();
    expect(() => vi.advanceTimersByTime(FLASH_MS)).not.toThrow();
  });
});
