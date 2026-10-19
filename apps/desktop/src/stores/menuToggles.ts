import { isTauri, onMenuScreen, onMenuToggle } from '../ipc';
import { useSettingsStore } from './settingsStore';
import { useUiStore } from './uiStore';

/** Follows View → Toggle Formatting Toolbar / Toggle Line Numbers / Toggle
 *  Outline from the app menu; returns the unsubscribe. */
export async function installMenuToggles(): Promise<() => void> {
  return onMenuToggle((key) => {
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
