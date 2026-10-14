import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../ipc/testing';
import { installMenuScreen, installMenuToggles } from './menuToggles';
import { useUiStore } from './uiStore';
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';

let patches: Record<string, unknown>[];

beforeEach(() => {
  patches = [];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  mockIPC(
    (cmd, raw) => {
      if (cmd !== 'settings_set') return null;
      const patch = (raw as { patch: Record<string, unknown> }).patch;
      patches.push(patch);
      return { ...useSettingsStore.getState().settings, ...patch };
    },
    { shouldMockEvents: true },
  );
});
afterEach(() => clearMocks());

describe('View menu toggles (M2b feedback round)', () => {
  it('flip the formatting toolbar and the line numbers (menu:toggle)', async () => {
    const stop = await installMenuToggles();
    await emit('menu:toggle', 'toolbar');
    await vi.waitFor(() => expect(useSettingsStore.getState().settings.toolbar).toBe(false));
    await emit('menu:toggle', 'lineNumbers');
    await vi.waitFor(() => expect(useSettingsStore.getState().settings.lineNumbers).toBe(true));
    await emit('menu:toggle', 'toolbar');
    await vi.waitFor(() => expect(useSettingsStore.getState().settings.toolbar).toBe(true));
    expect(patches).toEqual([{ toolbar: false }, { lineNumbers: true }, { toolbar: true }]);
    stop();
  });

  it('ignores an unknown payload', async () => {
    const stop = await installMenuToggles();
    await emit('menu:toggle', 'palette');
    await new Promise((r) => setTimeout(r, 10));
    expect(patches).toEqual([]);
    stop();
  });
});

describe('View → Editor / Global View (M3a §2)', () => {
  it('switch the screen (menu:screen); an unknown payload is ignored', async () => {
    useUiStore.setState({ screen: 'edit' });
    const stop = await installMenuScreen();
    await emit('menu:screen', 'global');
    await vi.waitFor(() => expect(useUiStore.getState().screen).toBe('global'));
    await emit('menu:screen', 'sideways');
    await new Promise((r) => setTimeout(r, 10));
    expect(useUiStore.getState().screen).toBe('global');
    await emit('menu:screen', 'edit');
    await vi.waitFor(() => expect(useUiStore.getState().screen).toBe('edit'));
    stop();
  });
});
