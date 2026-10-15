// Focus mode (M4b part 3 §5) for a Global View canvas: the card under the
// pointer, else the one the keyboard moved to (arrow keys, Tab inside the
// canvas), lights its edges and neighbours. A card focused for you (a level
// that just loaded) doesn't: the view would arrive dimmed. Attributes only
// (focusEdges), re-applied when what is drawn changes.
import {
  useEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import { focusEdges } from './edges';

const MOVES = new Set(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

const nodeOf = (target: EventTarget | null) =>
  (target as HTMLElement | null)?.closest?.<HTMLElement>('.react-flow__node')?.dataset.id ?? null;

/** Handlers for the canvas wrapper; `drawn` changing re-applies the light. */
export function useFocusMode(wrapper: RefObject<HTMLElement | null>, drawn: unknown[]) {
  const lit = useRef<{
    hover: string | null;
    keys: string | null;
    shown: string | null;
    keyed: boolean;
  }>({ hover: null, keys: null, shown: null, keyed: false });

  const relight = (force = false) => {
    const root = wrapper.current;
    if (!root) return;
    const want = lit.current.hover ?? lit.current.keys;
    if (!force && want === lit.current.shown) return;
    lit.current.shown = want;
    focusEdges(root, want);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => relight(true), drawn);

  return {
    onMouseOver: (e: MouseEvent) => {
      lit.current.hover = nodeOf(e.target);
      relight();
    },
    onMouseLeave: () => {
      lit.current.hover = null;
      relight();
    },
    onKeyDownCapture: (e: KeyboardEvent) => {
      if (MOVES.has(e.key)) lit.current.keyed = true;
    },
    onFocusCapture: (e: FocusEvent) => {
      lit.current.keys = lit.current.keyed ? nodeOf(e.target) : null;
      lit.current.keyed = false;
      relight();
    },
    onBlurCapture: () => {
      lit.current.keys = null;
      relight();
    },
  };
}
