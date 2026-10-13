import { create } from 'zustand';

export const TOAST_MS = 5000;

export interface Toast {
  id: number;
  message: string;
  /** Extra lines (e.g. files that couldn't be updated); such toasts stay until dismissed. */
  detail?: string[];
  tone: 'info' | 'error';
  /** A button on the toast (e.g. "Open"); such toasts stay until dismissed. */
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
  clear: () => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ message, detail, tone = 'info', action }) => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message, detail, tone, action }] });
    if (!detail?.length && !action) setTimeout(() => get().dismiss(id), TOAST_MS);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  clear: () => set({ toasts: [] }),
}));
