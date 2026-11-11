// Focus mode: the editor alone, in full screen. Session state lives in
// `uiStore.focus`; this module enters and leaves it, and watches for the
// things that end it (double Escape, leaving full screen, Global View, a
// toolbar/outline/line-number toggle, the vault closing).
import i18next from 'i18next';
import { onWindowResized, windowFullscreen, windowSetFullscreen } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { announce } from '../editor/announce';

/** Two Escapes this close together leave Focus mode. */
export const FOCUS_ESCAPE_MS = 500;
/** Resizes this soon after our own full-screen change are that change. */
export const FOCUS_SETTLE_MS = 1000;

/** An Escape meant for one of these closes it, not Focus mode. */
const OVERLAYS =
  '.cm-tooltip-autocomplete, .cm-panels .cm-search, [role="dialog"], [role="menu"], [role="listbox"], [data-liber-popup]';

const MAC = /Mac/i.test(navigator.platform);

/** Focus mode made the window full screen, so leaving undoes it. */
let enteredFullscreen = false;
/** The window was full screen at enter: leaving full screen ends Focus mode. */
let watchFullscreen = false;
let settleUntil = 0;
let entering = false;

const settle = () => (settleUntil = Date.now() + FOCUS_SETTLE_MS);

export function canFocus(): boolean {
  return (
    useVaultStore.getState().status === 'open' &&
    usePageStore.getState().state === 'ready' &&
    useUiStore.getState().dialog === null
  );
}

export async function enterFocus(): Promise<void> {
  if (entering || useUiStore.getState().focus || !canFocus()) return;
  entering = true;
  try {
    const ui = useUiStore.getState();
    if (ui.screen !== 'edit') ui.setScreen('edit');
    const full = await windowFullscreen();
    enteredFullscreen = false;
    watchFullscreen = full.ok && full.value;
    // An unreadable state is left alone: Focus mode still works in the window.
    if (full.ok && !full.value) {
      const set = await windowSetFullscreen(true);
      enteredFullscreen = watchFullscreen = set.ok;
      settle();
    }
    useUiStore.getState().setFocus(true);
    const content = document.querySelector<HTMLElement>('.cm-content');
    if (content && !content.contains(document.activeElement)) content.focus();
    announce(i18next.t('focus.on'));
  } finally {
    entering = false;
  }
}

export async function leaveFocus(): Promise<void> {
  if (!useUiStore.getState().focus) return;
  useUiStore.getState().setFocus(false);
  if (enteredFullscreen) {
    enteredFullscreen = false;
    await windowSetFullscreen(false);
    settle();
  }
  announce(i18next.t('focus.off'));
}

export function toggleFocus(): Promise<void> {
  return useUiStore.getState().focus ? leaveFocus() : enterFocus();
}

/** ⌥⌘Z / Ctrl+Alt+Z by the physical Z key; never AltGr typing. */
export function isFocusKey(e: KeyboardEvent, mac = MAC): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.altKey && !e.shiftKey && e.code === 'KeyZ' && !e.getModifierState('AltGraph');
}

/** The shortcut, double Escape and the watchers that end Focus mode.
 *  Returns the uninstall. */
export function installFocusMode(): () => void {
  let lastEscape = 0;
  let overlayOpen = false;

  // Captured first: by the bubble phase React has already removed the
  // overlay this Escape closed.
  const onCapture = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlayOpen = !!document.querySelector(OVERLAYS) || useUiStore.getState().dialog !== null;
    } else if (isFocusKey(e) && !e.repeat) {
      e.preventDefault();
      void toggleFocus();
    }
  };
  const onBubble = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') {
      lastEscape = 0;
      return;
    }
    if (!useUiStore.getState().focus) return;
    if (overlayOpen || e.defaultPrevented) {
      lastEscape = 0;
      return;
    }
    const now = Date.now();
    if (lastEscape && now - lastEscape <= FOCUS_ESCAPE_MS) {
      lastEscape = 0;
      void leaveFocus();
    } else {
      lastEscape = now;
    }
  };
  window.addEventListener('keydown', onCapture, true);
  window.addEventListener('keydown', onBubble);

  const onResize = async () => {
    if (!useUiStore.getState().focus || !watchFullscreen || Date.now() < settleUntil) return;
    const full = await windowFullscreen();
    if (full.ok && !full.value && Date.now() >= settleUntil) {
      enteredFullscreen = false; // already out: nothing to undo
      void leaveFocus();
    }
  };
  let unlistenResize: (() => void) | null = null;
  let gone = false;
  void onWindowResized(() => void onResize())
    .then((un) => (gone ? un() : (unlistenResize = un)))
    .catch(() => undefined);

  const unUi = useUiStore.subscribe((s) => {
    if (s.focus && s.screen !== 'edit') void leaveFocus();
  });
  const unSettings = useSettingsStore.subscribe(({ settings: a }, { settings: b }) => {
    if (a.toolbar !== b.toolbar || a.lineNumbers !== b.lineNumbers || a.outline !== b.outline) {
      void leaveFocus();
    }
  });
  const unVault = useVaultStore.subscribe((s) => {
    // Closing or locking: Focus mode ends, the window stays as it is.
    if (s.status !== 'open' && useUiStore.getState().focus) {
      enteredFullscreen = false;
      useUiStore.getState().setFocus(false);
    }
  });

  return () => {
    gone = true;
    unlistenResize?.();
    window.removeEventListener('keydown', onCapture, true);
    window.removeEventListener('keydown', onBubble);
    unUi();
    unSettings();
    unVault();
  };
}
