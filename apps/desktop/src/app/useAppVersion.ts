import { useEffect, useState } from 'react';
import { appInfo } from '../ipc';

export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    appInfo()
      .then((info) => {
        if (!cancelled) setVersion(info.version);
      })
      .catch(() => {
        // Not running inside Tauri (e.g. plain `vite` in a browser): the version stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
