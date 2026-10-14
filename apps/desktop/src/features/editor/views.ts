// The live EditorView showing each page, so changes made outside the editor
// (header edits, M2c §4) go through the view and join its undo history.
import type { EditorView } from '@codemirror/view';
import type { PageDoc } from './pageDoc';

const views = new Map<PageDoc, EditorView>();

export function showView(doc: PageDoc, view: EditorView): void {
  views.set(doc, view);
}

export function hideView(doc: PageDoc, view: EditorView): void {
  if (views.get(doc) === view) views.delete(doc);
}

export const viewOf = (doc: PageDoc): EditorView | null => views.get(doc) ?? null;
