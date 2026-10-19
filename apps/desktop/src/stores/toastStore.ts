import { create } from 'zustand';

export const TOAST_MS = 5000;
/** A toast with a button (Undo, Open) stays longer, to be reachable (M5b round 2). */
export const ACTION_TOAST_MS = 8000;
/** The most toasts shown at once; the oldest timed one makes room, never one
 *  listing details (round-2 review I4). */
export const MAX_TOASTS = 3;

export interface Toast {
  id: number;
  message: string;
  /** Extra lines (e.g. files that couldn't be updated); such toasts stay until dismissed. */
  detail?: string[];
  tone: 'info' | 'error';
  /** A button on the toast (e.g. "Undo"); such toasts stay ACTION_TOAST_MS. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastState {
  toasts: Toast[];
  push: (t: {
    message: string;
    detail?: string[];
    tone?: Toast['tone'];
    action?: ToastAction;
  }) => number;
  dismiss: (id: number) => void;
  /** Pauses (or resumes) a toast's timer while it's hovered or focused. */
  hold: (id: number, held: boolean) => void;
  clear: () => void;
}

let nextId = 1;
/** Running timers: the time left, and when it last started counting. */
const timers = new Map<
  number,
  { timer?: ReturnType<typeof setTimeout>; left: number; at: number }
>();

function stop(id: number) {
  clearTimeout(timers.get(id)?.timer);
  timers.delete(id);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ message, detail, tone = 'info', action }) => {
    const id = nextId++;
    let kept = get().toasts;
    while (kept.length >= MAX_TOASTS) {
      const oldest = kept.find((t) => !t.detail?.length);
      if (!oldest) break;
      stop(oldest.id);
      kept = kept.filter((t) => t !== oldest);
    }
    set({ toasts: [...kept, { id, message, detail, tone, action }] });
    if (!detail?.length) {
      timers.set(id, { left: action ? ACTION_TOAST_MS : TOAST_MS, at: 0 });
      get().hold(id, false);
    }
    return id;
  },
  dismiss: (id) => {
    stop(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  hold: (id, held) => {
    const entry = timers.get(id);
    // Already in that state (hover and focus both hold it).
    if (!entry || (entry.timer === undefined) === held) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (held) entry.left -= Date.now() - entry.at;
    else {
      entry.at = Date.now();
      entry.timer = setTimeout(() => get().dismiss(id), Math.max(0, entry.left));
    }
  },
  clear: () => {
    for (const id of [...timers.keys()]) stop(id);
    set({ toasts: [] });
  },
}));
