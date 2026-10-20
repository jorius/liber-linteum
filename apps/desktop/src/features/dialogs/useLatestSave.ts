import { useEffect, useRef, useState } from 'react';

export interface LatestSaver<T> {
  /** Save `value` once it has settled for `delay` ms (a dragged colour). */
  schedule: (value: T) => void;
  /** Save `value` now, replacing anything scheduled. */
  now: (value: T) => void;
  /** A value is waiting, queued or being saved. */
  pending: () => boolean;
  /** Drop anything not yet sent (after a refused save). */
  cancel: () => void;
}

/** Coalesces rapid saves so the last value always lands last: scheduled
 *  values are debounced, at most one save is in flight, and a value that
 *  arrives meanwhile is sent when it returns (older ones are dropped). A
 *  waiting value is saved on unmount. */
export function useLatestSave<T>(
  save: (value: T) => Promise<unknown>,
  delay = 150,
): LatestSaver<T> {
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  const [saver] = useState(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting: { value: T } | undefined;
    let queued: { value: T } | undefined;
    let busy = false;
    const pump = () => {
      if (busy || !queued) return;
      const { value } = queued;
      queued = undefined;
      busy = true;
      const done = () => {
        busy = false;
        pump();
      };
      void saveRef.current(value).then(done, done);
    };
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (waiting) queued = waiting;
      waiting = undefined;
      pump();
    };
    return {
      schedule: (value: T) => {
        clearTimeout(timer);
        waiting = { value };
        timer = setTimeout(flush, delay);
      },
      now: (value: T) => {
        waiting = { value };
        flush();
      },
      pending: () => busy || queued !== undefined || waiting !== undefined,
      cancel: () => {
        clearTimeout(timer);
        waiting = undefined;
        queued = undefined;
      },
      flush,
    };
  });
  useEffect(() => saver.flush, [saver]);
  return saver;
}
