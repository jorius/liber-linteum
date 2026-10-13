import { isTauri, onMenuToggle } from '../ipc';
import { useSettingsStore } from './settingsStore';

/** Follows View → Toggle Formatting Toolbar / Toggle Line Numbers from the
 *  app menu; returns the unsubscribe. */
export async function installMenuToggles(): Promise<() => void> {
  return onMenuToggle((key) => {
    if (key !== 'toolbar' && key !== 'lineNumbers') return;
    const { settings, update } = useSettingsStore.getState();
    void update({ [key]: !settings[key] });
  });
}

export function installMenuTogglesIfTauri(): void {
  if (isTauri()) void installMenuToggles().catch(() => undefined);
}
