import { isTauri, onMenuScreen, onMenuToggle } from '../ipc';
import { nextTheme } from '../theme/theme';
import { useSettingsStore } from './settingsStore';
import { useUiStore } from './uiStore';

const MAC = /Mac/i.test(navigator.platform);

/** Swaps light and dark (night mode), saving the theme; from `system` it
 *  picks the opposite of what the system shows now. */
export function toggleNight(): void {
  const { settings, update } = useSettingsStore.getState();
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  void update({ theme: nextTheme(settings.theme, systemDark) });
}

/** ⌥⌘N / Alt+Ctrl+N, by key position (⌥N is a dead key on macOS). */
export function isNightKey(e: KeyboardEvent, mac = MAC): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.altKey && !e.shiftKey && e.code === 'KeyN' && !e.getModifierState('AltGraph');
}

/** The night shortcut, in every window; returns the uninstall. */
export function installNightKey(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isNightKey(e) || e.repeat) return;
    e.preventDefault();
    toggleNight();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** Follows View → Toggle Formatting Toolbar / Toggle Line Numbers / Toggle
 *  Outline / Toggle Dark Mode from the app menu; returns the unsubscribe. */
export async function installMenuToggles(): Promise<() => void> {
  return onMenuToggle((key) => {
    if (key === 'theme') return toggleNight();
    if (key !== 'toolbar' && key !== 'lineNumbers' && key !== 'outline') return;
    const { settings, update } = useSettingsStore.getState();
    void update({ [key]: !settings[key] });
  });
}

/** Follows View → Editor / Global View (M3a §2); returns the unsubscribe. */
export async function installMenuScreen(): Promise<() => void> {
  return onMenuScreen((screen) => {
    if (screen === 'edit' || screen === 'global') useUiStore.getState().setScreen(screen);
  });
}

export function installMenuTogglesIfTauri(): void {
  if (!isTauri()) return;
  void installMenuToggles().catch(() => undefined);
  void installMenuScreen().catch(() => undefined);
}
