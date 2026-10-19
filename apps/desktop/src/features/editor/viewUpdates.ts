// Who follows the page editor from outside it (the outline and the word
// count, M4b part 2 §5): the view on screen, and its selection, text and
// viewport changes, without one listener per editor state.
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { useSyncExternalStore } from 'react';

/** `null` means the view's state was replaced (another page shown). */
type Listener = (u: ViewUpdate | null) => void;

const listeners = new WeakMap<EditorView, Set<Listener>>();

/** Calls `fn` on every update of `view`; returns the unsubscribe. */
export function onViewUpdate(view: EditorView, fn: Listener): () => void {
  let set = listeners.get(view);
  if (!set) listeners.set(view, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

export function notifyViewUpdate(u: ViewUpdate): void {
  listeners.get(u.view)?.forEach((fn) => fn(u));
}

export function notifyViewReset(view: EditorView): void {
  listeners.get(view)?.forEach((fn) => fn(null));
}

let current: EditorView | null = null;
const watchers = new Set<() => void>();

/** The page editor's view while one is mounted. */
export function setCurrentView(view: EditorView | null): void {
  current = view;
  watchers.forEach((fn) => fn());
}

export function useCurrentView(): EditorView | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
  );
}
