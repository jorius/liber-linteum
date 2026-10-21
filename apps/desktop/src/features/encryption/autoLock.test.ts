// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { useRecorderStore } from '../audio/recorderStore';
import { installShellMenu } from '../shell/shellMenu';
import { useAutoLock } from './autoLock';

const info = { name: 'V', root: '/v', report: { pages: 1, warnings: [] }, encrypted: true };
const editorActions = useEditorStore.getState();
const lock = vi.fn(async () => true);
const sec = (s: number) => act(() => vi.advanceTimersByTimeAsync(s * 1000));
const setMinutes = (autoLockMinutes: number | null) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoLockMinutes } });

let log: string[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  log = [];
  mockIPC(
    (cmd) => {
      log.push(cmd);
      return null;
    },
    { shouldMockEvents: true },
  );
  useEditorStore.setState(editorActions, true);
  lock.mockClear();
  useVaultStore.setState({ status: 'open', info: info as never, lock });
  useRecorderStore.setState({ phase: 'idle' });
  setMinutes(1);
});
afterEach(async () => {
  vi.useRealTimers();
  await resetVaultStore();
  clearMocks();
});

describe('useAutoLock (E4)', () => {
  it('idle_resets_and_waits_for_recording', async () => {
    const { unmount } = renderHook(() => useAutoLock());
    await sec(50);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    await sec(59); // 1:49: the keydown moved the lock past 1:00
    expect(lock).not.toHaveBeenCalled();
    useRecorderStore.setState({ phase: 'recording' });
    await sec(1); // 1:50
    expect(lock).not.toHaveBeenCalled();
    await sec(55); // a minute later, still recording
    expect(lock).not.toHaveBeenCalled();
    useRecorderStore.setState({ phase: 'idle' });
    await sec(60);
    expect(lock).toHaveBeenCalledWith('idle');
    unmount();
  });

  it('pointer, wheel and the throttled move all reset; move at most once a second', async () => {
    renderHook(() => useAutoLock());
    for (const ev of ['pointerdown', 'wheel']) {
      await sec(50);
      act(() => void window.dispatchEvent(new Event(ev)));
    }
    await sec(50);
    expect(lock).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new Event('pointermove'))); // 2:30 (first move counts)
    await sec(0.5);
    act(() => void window.dispatchEvent(new Event('pointermove'))); // throttled
    await sec(59.5); // 60 s after the first move, 59.5 after the second
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('a lock request locks at once, even while recording', async () => {
    useRecorderStore.setState({ phase: 'recording' });
    renderHook(() => useAutoLock());
    await sec(0);
    await act(() => emit('vault:lock-request', { reason: 'sleep' }));
    await act(() => emit('vault:lock-request', { reason: 'screenLock' }));
    expect(lock.mock.calls).toEqual([['sleep'], ['screenLock']]);
  });

  it('never locks with autoLockMinutes null', async () => {
    setMinutes(null);
    renderHook(() => useAutoLock());
    await sec(24 * 3600);
    expect(lock).not.toHaveBeenCalled();
  });

  it('a plain vault has no timer, no menu item', async () => {
    useVaultStore.setState({ info: { ...info, encrypted: false } as never });
    renderHook(() => useAutoLock());
    await sec(3600);
    expect(lock).not.toHaveBeenCalled();
    expect(log).not.toContain('menu_set_lock_enabled');
  });

  it('changing the setting re-arms; unmounting removes everything', async () => {
    const { unmount } = renderHook(() => useAutoLock());
    await sec(30);
    act(() => setMinutes(2));
    await sec(90);
    expect(lock).not.toHaveBeenCalled(); // the new 2 min counts from the change
    unmount();
    await sec(600);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown')));
    await sec(600);
    expect(lock).not.toHaveBeenCalled();
    await act(() => emit('vault:lock-request', { reason: 'sleep' }));
    expect(lock).not.toHaveBeenCalled();
  });

  it('the menu item follows the vault, and ⌥⌘L locks', async () => {
    const { unmount } = renderHook(() => useAutoLock());
    await sec(0);
    expect(log).toContain('menu_set_lock_enabled');
    act(
      () =>
        void window.dispatchEvent(
          new KeyboardEvent('keydown', { code: 'KeyL', key: '¬', altKey: true, metaKey: true }),
        ),
    );
    expect(lock).toHaveBeenCalledWith('menu');
    unmount();
  });

  it('a lock the backend started goes to locked without IPC, once', async () => {
    useVaultStore.setState({ lock: editorLessLock() });
    renderHook(() => useAutoLock());
    await sec(0);
    log.length = 0;
    await act(() => emit('vault:locked', { path: '/v' }));
    await act(() => emit('vault:locked', { path: '/v' }));
    const s = useVaultStore.getState();
    expect([s.status, s.lockedPath, s.info]).toEqual(['locked', '/v', null]);
    expect(log.filter((c) => c.startsWith('vault_'))).toEqual([]);
  });
});

/** The store's real `lock` (the others replace it with a spy). */
function editorLessLock() {
  return useVaultStore.getInitialState().lock;
}

describe('lock from the menu (E4)', () => {
  it('lock_saves_without_asking', async () => {
    const saveAll = vi.fn(async () => []);
    const confirmUnsaved = vi.fn();
    let dirty = ['a.md'];
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoSave: false } });
    useEditorStore.setState({
      askPaths: () => dirty,
      dirtyPaths: () => dirty,
      saveAll: async () => {
        dirty = [];
        return saveAll();
      },
      confirmUnsaved,
    } as never);
    usePageStore.setState({ path: 'a.md' });
    useVaultStore.setState({ lock: useVaultStore.getInitialState().lock });
    const stop = await installShellMenu({ main: true });
    await act(() => emit('menu:vault', 'lock'));
    await vi.advanceTimersByTimeAsync(0);
    expect(confirmUnsaved).not.toHaveBeenCalled();
    expect(saveAll).toHaveBeenCalled();
    expect(useVaultStore.getState().status).toBe('locked');
    expect(log).toContain('vault_lock');
    stop();
  });
});
