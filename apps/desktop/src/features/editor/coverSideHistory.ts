// Cover placement in the editor's undo history (M4b part 3 §3). A placement
// lives in `.liber/vault.json`, not in the note, but ⌘Z should put it back
// like the other cover edits: choosing one adds a history entry holding no
// text change, only an effect that undo and redo invert and re-save.
import { invertedEffects, isolateHistory } from '@codemirror/commands';
import { StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { CoverSide } from '../../ipc';
import { useCoverLayoutStore } from '../../stores/coverLayoutStore';
import { useEditorStore } from '../../stores/editorStore';
import { viewOf } from './views';

interface SideChange {
  path: string;
  from: CoverSide;
  to: CoverSide;
}

const sideChange = StateEffect.define<SideChange>();

/** Undo and redo re-save the placement they bring back. */
export const coverSideHistory: Extension = [
  invertedEffects.of((tr) =>
    tr.effects
      .filter((e) => e.is(sideChange))
      .map((e) => {
        const { path, from, to } = (e as StateEffect<SideChange>).value;
        return sideChange.of({ path, from: to, to: from });
      }),
  ),
  EditorView.updateListener.of((u) => {
    for (const tr of u.transactions) {
      if (!tr.isUserEvent('undo') && !tr.isUserEvent('redo')) continue;
      for (const e of tr.effects) {
        if (e.is(sideChange))
          void useCoverLayoutStore.getState().saveSide(e.value.path, e.value.to);
      }
    }
  }),
];

/** Records a placement change of the page open in the editor as one undo
 *  step of its own (never merged with typing around it). */
export function recordCoverSide(path: string, from: CoverSide, to: CoverSide): void {
  const doc = useEditorStore.getState().doc;
  const view = doc?.path === path ? viewOf(doc) : null;
  view?.dispatch({
    effects: sideChange.of({ path, from, to }),
    annotations: isolateHistory.of('full'),
    userEvent: 'cover.side',
  });
}
