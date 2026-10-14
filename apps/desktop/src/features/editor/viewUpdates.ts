// Who follows an editor view's updates from outside it (the outline, M4b part
// 2 §5): selection, text and viewport changes, without one listener per state.
import type { EditorView, ViewUpdate } from '@codemirror/view';

const listeners = new WeakMap<EditorView, Set<(u: ViewUpdate) => void>>();

/** Calls `fn` on every update of `view`; returns the unsubscribe. */
export function onViewUpdate(view: EditorView, fn: (u: ViewUpdate) => void): () => void {
  let set = listeners.get(view);
  if (!set) listeners.set(view, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

export function notifyViewUpdate(u: ViewUpdate): void {
  listeners.get(u.view)?.forEach((fn) => fn(u));
}
