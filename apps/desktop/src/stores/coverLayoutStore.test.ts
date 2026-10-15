import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../ipc/testing';
import {
  coverWidthMax,
  DEFAULT_COVER_WIDTH,
  MIN_COVER_WIDTH,
  useCoverLayoutStore,
  useCoverSide,
  useCoverWidth,
} from './coverLayoutStore';
import { useToastStore } from './toastStore';

let sides: Record<string, string>;
let widths: Record<string, number>;
let calls: [string, unknown][];
let failNext: boolean;

const reply = () => ({
  attachments: { mode: 'subfolder', path: 'attachments' },
  obsidian: null,
  overrideObsidian: false,
  pageWidth: null,
  pageWidths: {},
  coverHeights: {},
  coverSides: { ...sides },
  coverWidths: { ...widths },
});

beforeEach(() => {
  sides = {};
  widths = {};
  calls = [];
  failNext = false;
  useCoverLayoutStore.setState({ sides: {}, widths: {} });
  useToastStore.setState({ toasts: [] });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    if (cmd === 'vault_settings_get') return reply();
    if (failNext && cmd.startsWith('cover_')) throw { kind: 'io', message: 'disk full' };
    if (cmd === 'cover_side_set') {
      const { path, side } = args as { path: string; side: string };
      if (side === 'top') delete sides[path];
      else sides[path] = side;
      return reply();
    }
    if (cmd === 'cover_width_set') {
      const { path, width } = args as { path: string; width: number | null };
      if (width === null) delete widths[path];
      else widths[path] = Math.min(2000, Math.max(160, Math.round(width)));
      return reply();
    }
    return null;
  });
});
afterEach(() => clearMocks());

const side = (path: string) => renderHook(() => useCoverSide(path)).result.current;
const width = (path: string) => renderHook(() => useCoverWidth(path)).result.current;

describe('cover placement and strip width (M4b part 3 §3)', () => {
  it('pages without an entry sit on top with the default width', async () => {
    sides = { 'B.md': 'left' };
    widths = { 'B.md': 340 };
    await useCoverLayoutStore.getState().load();
    expect(side('A.md')).toBe('top');
    expect(width('A.md')).toBe(DEFAULT_COVER_WIDTH);
    expect(side('B.md')).toBe('left');
    expect(width('B.md')).toBe(340);
  });

  it('choosing a placement saves it and shows at once; top clears it', async () => {
    await useCoverLayoutStore.getState().load();
    const saving = useCoverLayoutStore.getState().saveSide('A.md', 'right');
    expect(side('A.md')).toBe('right');
    expect(await saving).toBe(true);
    expect(calls).toContainEqual(['cover_side_set', { path: 'A.md', side: 'right' }]);
    expect(sides).toEqual({ 'A.md': 'right' });
    await useCoverLayoutStore.getState().saveSide('A.md', 'top');
    expect(side('A.md')).toBe('top');
    expect(sides).toEqual({});
  });

  it('a width is saved rounded; null clears it', async () => {
    await useCoverLayoutStore.getState().load();
    await useCoverLayoutStore.getState().saveWidth('A.md', 301.6);
    expect(calls).toContainEqual(['cover_width_set', { path: 'A.md', width: 302 }]);
    expect(width('A.md')).toBe(302);
    await useCoverLayoutStore.getState().saveWidth('A.md', null);
    expect(width('A.md')).toBe(DEFAULT_COVER_WIDTH);
  });

  it('a failed save puts the previous value back and says so', async () => {
    sides = { 'A.md': 'left' };
    widths = { 'A.md': 300 };
    await useCoverLayoutStore.getState().load();
    failNext = true;
    expect(await useCoverLayoutStore.getState().saveSide('A.md', 'right')).toBe(false);
    expect(side('A.md')).toBe('left');
    await useCoverLayoutStore.getState().saveWidth('A.md', 500);
    expect(width('A.md')).toBe(300);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toMatchObject({ tone: 'error' });
  });

  it('a slow reply to an earlier save never undoes a later one', async () => {
    await useCoverLayoutStore.getState().load();
    mockIPC(async (cmd, raw) => {
      const args = (raw ?? {}) as { path: string; side: string };
      if (cmd === 'cover_side_set') sides[args.path] = args.side;
      const snapshot = reply();
      await new Promise((r) => setTimeout(r, args.side === 'left' ? 40 : 0));
      return snapshot;
    });
    const first = useCoverLayoutStore.getState().saveSide('A.md', 'left');
    const second = useCoverLayoutStore.getState().saveSide('A.md', 'right');
    await Promise.all([first, second]);
    expect(side('A.md')).toBe('right');
  });

  it('a strip is at least 160 px and at most 45% of the window', () => {
    expect(MIN_COVER_WIDTH).toBe(160);
    expect(coverWidthMax(1000)).toBe(450);
    expect(coverWidthMax(300)).toBe(160);
  });
});
