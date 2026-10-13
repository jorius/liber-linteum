import { useEffect, useState } from 'react';

/** `value`, updated `ms` after it stops changing (the first value is immediate). */
export function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}
