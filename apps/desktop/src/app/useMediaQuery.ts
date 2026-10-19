import { useCallback, useSyncExternalStore } from 'react';

/** Whether a media query matches, following its changes (false where the
 *  environment has no `matchMedia`, as in jsdom). */
export function useMediaQuery(query: string): boolean {
  const list = useCallback(
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query) : null),
    [query],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      const l = list();
      l?.addEventListener('change', onChange);
      return () => l?.removeEventListener('change', onChange);
    },
    [list],
  );
  return useSyncExternalStore(subscribe, () => list()?.matches ?? false);
}
