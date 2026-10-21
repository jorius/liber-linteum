import { useEffect } from 'react';
import { menuSetLockEnabled, onLockRequest, onVaultLocked } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useRecorderStore } from '../audio/recorderStore';

const MINUTE = 60_000;
const MOVE_THROTTLE_MS = 1000;

/** Locks an open encrypted vault: after `autoLockMinutes` without input in
 *  this window, on the OS's sleep / screen-lock request (even while
 *  recording), and on ⌥⌘L; keeps the Vault → Lock Vault menu item enabled and
 *  follows a lock the backend started. */
export function useAutoLock(): void {
  const encrypted = useVaultStore((s) => !!s.info?.encrypted);
  const minutes = useSettingsStore((s) => s.settings.autoLockMinutes);
  useEffect(() => {
    if (!encrypted) return;
    const vault = () => useVaultStore.getState();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      if (minutes == null) return;
      timer = setTimeout(() => {
        const phase = useRecorderStore.getState().phase;
        // A take in progress postpones the lock (a lock would end it).
        if (phase === 'recording' || phase === 'starting') return arm(MINUTE);
        void vault()
          .lock('idle')
          .then((done) => {
            if (!done && vault().status === 'open') arm(MINUTE);
          });
      }, ms);
    };
    const reset = () => arm((minutes ?? 0) * MINUTE);
    let lastMove = 0;
    const onMove = () => {
      const now = Date.now();
      if (now - lastMove < MOVE_THROTTLE_MS) return;
      lastMove = now;
      reset();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyL') {
        e.preventDefault();
        void vault().lock('menu');
      } else reset();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', reset);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('wheel', reset);
    reset();

    let stopped = false;
    const stops: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((stop) => (stopped ? stop() : stops.push(stop))).catch(() => undefined);
    keep(onLockRequest((reason) => void vault().lock(reason)));
    keep(onVaultLocked((path) => vault().lockedByBackend(path)));
    void menuSetLockEnabled(true);

    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('wheel', reset);
      stops.forEach((stop) => stop());
      void menuSetLockEnabled(false);
    };
  }, [encrypted, minutes]);
}
