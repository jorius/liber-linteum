import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onWindowResized, settingsSet, windowFullscreen, windowSetFullscreen } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { enterFocus, FOCUS_SETTLE_MS, installFocusMode, isFocusKey, leaveFocus } from './focusMode';

vi.mock('../../ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ipc')>()),
  windowFullscreen: vi.fn(),
  windowSetFullscreen: vi.fn(),
  onWindowResized: vi.fn(),
  settingsSet: vi.fn(),
}));

const fullscreen = vi.mocked(windowFullscreen);
const setFullscreen = vi.mocked(windowSetFullscreen);
let resized: () => void = () => undefined;
let uninstall: () => void = () => undefined;

const focused = () => useUiStore.getState().focus;
const flush = () => vi.advanceTimersByTimeAsync(0);
const key = (k: string, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

// Settling is module state: each test starts past the last one's settling.
let clock = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: clock });
  fullscreen.mockResolvedValue({ ok: true, value: false });
  setFullscreen.mockResolvedValue({ ok: true, value: undefined });
  vi.mocked(onWindowResized).mockImplementation(async (cb) => {
    resized = cb;
    return () => undefined;
  });
  vi.mocked(settingsSet).mockImplementation(async (patch) => ({
    ok: true,
    value: { ...useSettingsStore.getState().settings, ...patch },
  }));
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useVaultStore.setState({ status: 'open' });
  usePageStore.setState({ state: 'ready' });
  useUiStore.setState({ focus: false, screen: 'edit', dialog: null });
  uninstall = installFocusMode();
});

afterEach(async () => {
  await leaveFocus();
  uninstall();
  vi.clearAllMocks();
  clock = Date.now() + FOCUS_SETTLE_MS;
  vi.useRealTimers();
});

describe('enter and leave', () => {
  it('enters full screen and remembers it entered', async () => {
    await enterFocus();
    expect(setFullscreen).toHaveBeenCalledWith(true);
    expect(focused()).toBe(true);
    await leaveFocus();
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
    expect(focused()).toBe(false);
  });

  it('stays in full screen the user chose', async () => {
    fullscreen.mockResolvedValue({ ok: true, value: true });
    await enterFocus();
    await leaveFocus();
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it('works when full screen fails', async () => {
    setFullscreen.mockResolvedValue({ ok: false, error: { kind: 'io', message: 'no' } } as never);
    await enterFocus();
    expect(focused()).toBe(true);
    await leaveFocus();
    expect(setFullscreen).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a ready page', async () => {
    usePageStore.setState({ state: 'empty' });
    await enterFocus();
    expect(focused()).toBe(false);
  });

  it('switches to the editor screen first', async () => {
    useUiStore.setState({ screen: 'global' });
    await enterFocus();
    expect(useUiStore.getState().screen).toBe('edit');
    expect(focused()).toBe(true);
  });
});

describe('double Escape', () => {
  beforeEach(() => enterFocus());

  it('two Escapes within 500 ms leave', async () => {
    key('Escape');
    vi.advanceTimersByTime(400);
    key('Escape');
    await flush();
    expect(focused()).toBe(false);
  });

  it("two Escapes 600 ms apart don't", () => {
    key('Escape');
    vi.advanceTimersByTime(600);
    key('Escape');
    expect(focused()).toBe(true);
  });

  it("Escape, a letter, Escape doesn't", () => {
    key('Escape');
    key('a');
    key('Escape');
    expect(focused()).toBe(true);
  });

  it("an Escape another handler prevented doesn't count", () => {
    const prevent = (e: Event) => e.preventDefault();
    document.body.addEventListener('keydown', prevent);
    key('Escape');
    document.body.removeEventListener('keydown', prevent);
    key('Escape');
    expect(focused()).toBe(true);
  });

  it("an Escape that closes an overlay doesn't count", () => {
    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    document.body.appendChild(list);
    const close = () => list.remove();
    document.body.addEventListener('keydown', close);
    key('Escape');
    document.body.removeEventListener('keydown', close);
    key('Escape');
    expect(focused()).toBe(true);
  });
});

describe('watchers', () => {
  it("the resize during its own enter doesn't leave", async () => {
    await enterFocus();
    resized();
    await flush();
    expect(focused()).toBe(true);
    await vi.advanceTimersByTimeAsync(FOCUS_SETTLE_MS);
    resized();
    await flush();
    expect(focused()).toBe(false);
  });

  it("a re-enter during its leave's settling isn't ended by that leave's resize", async () => {
    await enterFocus();
    await vi.advanceTimersByTimeAsync(FOCUS_SETTLE_MS);
    await leaveFocus();
    await vi.advanceTimersByTimeAsync(300);
    fullscreen.mockResolvedValue({ ok: true, value: true }); // still animating out
    await enterFocus();
    fullscreen.mockResolvedValue({ ok: true, value: false });
    resized();
    await flush();
    expect(focused()).toBe(true);
  });

  it('leaving full screen yourself leaves Focus mode', async () => {
    fullscreen.mockResolvedValue({ ok: true, value: true });
    await enterFocus();
    fullscreen.mockResolvedValue({ ok: true, value: false });
    resized();
    await flush();
    expect(focused()).toBe(false);
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it('Global View, or a toolbar/outline/line-number toggle, leaves', async () => {
    await enterFocus();
    useUiStore.getState().setScreen('global');
    expect(focused()).toBe(false);

    useUiStore.getState().setScreen('edit');
    await enterFocus();
    expect(focused()).toBe(true);
    const { outline } = useSettingsStore.getState().settings;
    await useSettingsStore.getState().update({ outline: !outline });
    expect(focused()).toBe(false);
  });

  it('closing the vault turns Focus mode off without touching full screen', async () => {
    await enterFocus();
    useVaultStore.setState({ status: 'locked' });
    expect(focused()).toBe(false);
    expect(setFullscreen).toHaveBeenCalledTimes(1);
  });
});

describe('isFocusKey', () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('matches Alt+Mod+Z by the physical key', () => {
    expect(isFocusKey(ev({ altKey: true, metaKey: true, code: 'KeyZ', key: 'Ω' }), true)).toBe(
      true,
    );
    expect(isFocusKey(ev({ altKey: true, ctrlKey: true, code: 'KeyZ', key: 'z' }), false)).toBe(
      true,
    );
  });

  it('ignores Shift and AltGr', () => {
    expect(
      isFocusKey(ev({ altKey: true, metaKey: true, shiftKey: true, code: 'KeyZ' }), true),
    ).toBe(false);
    const altGr = ev({ altKey: true, ctrlKey: true, code: 'KeyZ', key: 'z' });
    Object.defineProperty(altGr, 'getModifierState', { value: (m: string) => m === 'AltGraph' });
    expect(isFocusKey(altGr, false)).toBe(false);
  });
});
