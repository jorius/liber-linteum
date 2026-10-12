import { useEffect, useState } from 'react';
import { appInfo, isTauri } from '../ipc';

export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    appInfo()
      .then((info) => {
        if (!cancelled) setVersion(info.version);
      })
      .catch((error: unknown) => {
        // Outside Tauri (plain `vite` in a browser) the version just stays hidden.
        // Inside Tauri a failure means a broken command or capability: make it visible.
        if (isTauri()) console.error('app_info IPC failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
