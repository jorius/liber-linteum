import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../ipc/testing';
import {
  coverHeightFor,
  coverMax,
  useCoverHeightStore,
  MIN_COVER_HEIGHT,
} from './coverHeightStore';
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
import { useToastStore } from './toastStore';

let stored: Record<string, number>;
let calls: [string, unknown][];
let failNext: boolean;

beforeEach(() => {
  stored = {};
  calls = [];
  failNext = false;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useCoverHeightStore.setState({ pages: {}, loaded: false });
  useToastStore.setState({ toasts: [] });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    const reply = () => ({
      attachments: { mode: 'subfolder', path: 'attachments' },
      obsidian: null,
      overrideObsidian: false,
      pageWidth: null,
      pageWidths: {},
      coverHeights: { ...stored },
    });
    if (cmd === 'vault_settings_get') return reply();
    if (cmd === 'cover_height_set') {
      if (failNext) throw { kind: 'io', message: 'disk full' };
      const { path, height } = args as { path: string; height: number | null };
      if (height === null) delete stored[path];
      else stored[path] = Math.min(2000, Math.max(132, Math.round(height)));
      return reply();
    }
    return null;
  });
});
afterEach(() => clearMocks());

describe('cover heights (cover resize)', () => {
  it("a page's own height wins over the app's default", async () => {
    stored = { 'B.md': 320 };
    await useCoverHeightStore.getState().load();
    expect(coverHeightFor('A.md')).toBe(200);
    expect(coverHeightFor('B.md')).toBe(320);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, coverHeight: 280 } });
    expect(coverHeightFor('A.md')).toBe(280);
    expect(coverHeightFor('B.md')).toBe(320);
  });

  it('setting a height saves it in the vault and shows it at once; null clears it', async () => {
    await useCoverHeightStore.getState().load();
    const saving = useCoverHeightStore.getState().save('A.md', 300);
    // Shown before the reply comes back (no snap back after a drag).
    expect(coverHeightFor('A.md')).toBe(300);
    await saving;
    expect(calls).toContainEqual(['cover_height_set', { path: 'A.md', height: 300 }]);
    expect(stored).toEqual({ 'A.md': 300 });
    await useCoverHeightStore.getState().save('A.md', null);
    expect(coverHeightFor('A.md')).toBe(200);
    expect(stored).toEqual({});
  });

  it('a failed save puts the previous height back and says so', async () => {
    stored = { 'A.md': 240 };
    await useCoverHeightStore.getState().load();
    failNext = true;
    await useCoverHeightStore.getState().save('A.md', 400);
    expect(coverHeightFor('A.md')).toBe(240);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ tone: 'error' });
  });

  it('a slow reply to an earlier save (or load) never undoes a later save', async () => {
    await useCoverHeightStore.getState().load();
    // Replies are computed when the call arrives and come back after `delay`.
    const delays: Record<string, number> = { '300': 40, '400': 0, load: 40 };
    mockIPC(async (cmd, raw) => {
      const args = (raw ?? {}) as { path: string; height: number };
      if (cmd === 'cover_height_set') stored[args.path] = args.height;
      const reply = { pageWidth: null, pageWidths: {}, coverHeights: { ...stored } };
      const delay = cmd === 'vault_settings_get' ? delays.load : delays[String(args.height)];
      await new Promise((r) => setTimeout(r, delay));
      return reply;
    });
    const loading = useCoverHeightStore.getState().load();
    const first = useCoverHeightStore.getState().save('A.md', 300);
    const second = useCoverHeightStore.getState().save('A.md', 400);
    await Promise.all([loading, first, second]);
    expect(coverHeightFor('A.md')).toBe(400);
  });

  it('the band is at least 132 px and at most 60% of the window', () => {
    expect(MIN_COVER_HEIGHT).toBe(132);
    expect(coverMax(1000)).toBe(600);
    expect(coverMax(901)).toBe(540);
    // A window too short for 132 px still gets the minimum.
    expect(coverMax(150)).toBe(132);
  });
});
