import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../ipc/testing';
import { installMenuScreen, installMenuToggles, installNightKey, isNightKey } from './menuToggles';
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
    await emit('menu:toggle', 'outline');
    await vi.waitFor(() => expect(useSettingsStore.getState().settings.outline).toBe(true));
    expect(patches).toEqual([
      { toolbar: false },
      { lineNumbers: true },
      { toolbar: true },
      { outline: true },
    ]);
    stop();
  });

  it('swaps light and dark from the menu (menu:toggle theme)', async () => {
    const stop = await installMenuToggles();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } });
    await emit('menu:toggle', 'theme');
    await vi.waitFor(() => expect(useSettingsStore.getState().settings.theme).toBe('dark'));
    await emit('menu:toggle', 'theme');
    await vi.waitFor(() => expect(useSettingsStore.getState().settings.theme).toBe('light'));
    expect(patches).toEqual([{ theme: 'dark' }, { theme: 'light' }]);
    stop();
  });

  it('⌥⌘N swaps light and dark; a held key swaps once', async () => {
    const stop = installNightKey();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'dark' } });
    const mac = /Mac/i.test(navigator.platform);
    const key = (repeat: boolean) =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'KeyN',
          altKey: true,
          metaKey: mac,
          ctrlKey: !mac,
          repeat,
        }),
      );
    key(false);
    key(true);
    await vi.waitFor(() => expect(patches).toEqual([{ theme: 'light' }]));
    stop();
  });

  it('isNightKey wants Alt + the platform modifier on the N key, no Shift', () => {
    const ev = (o: KeyboardEventInit) => new KeyboardEvent('keydown', { code: 'KeyN', ...o });
    expect(isNightKey(ev({ altKey: true, metaKey: true }), true)).toBe(true);
    expect(isNightKey(ev({ altKey: true, ctrlKey: true }), false)).toBe(true);
    expect(isNightKey(ev({ altKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isNightKey(ev({ altKey: true, metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isNightKey(ev({ metaKey: true }), true)).toBe(false);
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
