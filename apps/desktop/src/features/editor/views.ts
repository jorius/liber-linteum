// Where each page's editor state lives: the live EditorView showing it, or the
// state kept while it is in the background. Changes made outside the editor
// go through them and join the page's undo history: header edits (M2c §4), and
// pastes and drops that finish after a page switch (§5, final review I1).
import { Facet, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { PageDoc } from './pageDoc';

/** The page a state belongs to: a cached state is reused by whichever editor
 *  shows the page next, so nothing in it may close over a component. */
export const pageDocOf = Facet.define<PageDoc, PageDoc | null>({
  combine: (values) => values[0] ?? null,
});

const views = new Map<PageDoc, EditorView>();

/** Each page keeps its CodeMirror state (text, selection, undo) while the app
 *  runs, so switching pages or modes never loses history (ED-07). Current
 *  only while the page isn't shown: a view holds the live state. */
const states = new WeakMap<PageDoc, EditorState>();

export function showView(doc: PageDoc, view: EditorView): void {
  views.set(doc, view);
}

export function hideView(doc: PageDoc, view: EditorView): void {
  if (views.get(doc) === view) views.delete(doc);
}

export const viewOf = (doc: PageDoc): EditorView | null => views.get(doc) ?? null;

export const storedState = (doc: PageDoc): EditorState | null => states.get(doc) ?? null;

export function storeState(doc: PageDoc, state: EditorState): void {
  states.set(doc, state);
}

/** The first line each page showed when it was left (0.1.2: going back to it
 *  from the Open list finds it scrolled as it was). */
const tops = new WeakMap<PageDoc, number>();

export function storeTop(doc: PageDoc, view: EditorView): void {
  tops.set(doc, view.lineBlockAtHeight(view.scrollDOM.scrollTop).from);
}

/** Scrolls `view` back to where `doc` was left, if it was. */
export function restoreTop(doc: PageDoc, view: EditorView): void {
  const top = tops.get(doc);
  if (top === undefined || top > view.state.doc.length) return;
  view.dispatch({ effects: EditorView.scrollIntoView(top, { y: 'start' }) });
}
