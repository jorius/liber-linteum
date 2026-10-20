// Spell checking (spell checking spec §5): the prose words of the visible
// ranges, checked in Rust against local dictionaries, underlined in place.
// Only `text` nodes of the parsed page (and a wikilink's shown text) are
// words: code, math, HTML, frontmatter, tags, URLs and comments never are.
import { type EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin } from '@codemirror/view';
import i18n from 'i18next';
import type { Node, Parent } from 'mdast';
import { spellCheck } from '../../ipc';
import type { ParsedPage, WikiLink } from '../../markdown/types';
import { useSpellStore } from '../../stores/spellStore';
import { parsedFor } from './pageModel';

export const SPELL_DEBOUNCE_MS = 300;
/** Most words per check call (the Rust side's limit). */
const MAX_WORDS = 5000;

export interface WordRange {
  from: number;
  to: number;
  word: string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Not prose: numbers and versions, acronyms, camelCase and iPhone. */
const skipShape = (w: string) => /\d/.test(w) || /^\p{Lu}{2,}$/u.test(w) || /\p{Ll}\p{Lu}/u.test(w);

/** Source ranges holding prose: text nodes (not an autolink's own URL) and
 *  the shown part of a wikilink. */
function proseRanges(page: ParsedPage, text: string): [number, number][] {
  const out: [number, number][] = [];
  const visit = (node: Node, parent: Parent | null) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'text' && start != null && end != null) {
      const url = parent?.type === 'link' ? (parent as Parent & { url: string }).url : null;
      if (url == null || !url.endsWith(text.slice(start, end))) out.push([start, end]);
    } else if (node.type === 'wikiLink' && start != null && end != null) {
      const link = node as WikiLink;
      const shown = link.alias ?? link.target;
      const at = link.alias != null ? end - 2 - shown.length : start + 2;
      if (text.slice(at, at + shown.length) === shown) out.push([at, at + shown.length]);
    }
    if ('children' in node) for (const c of (node as Parent).children) visit(c, node as Parent);
  };
  visit(page.tree, null);
  return out;
}

export function wordsToCheck(
  page: ParsedPage,
  text: string,
  from: number,
  to: number,
): WordRange[] {
  const out: WordRange[] = [];
  for (const [s, e] of proseRanges(page, text)) {
    const a = Math.max(s, from);
    const b = Math.min(e, to);
    if (a >= b) continue;
    for (const seg of segmenter.segment(text.slice(a, b))) {
      if (!seg.isWordLike || skipShape(seg.segment)) continue;
      const at = a + seg.index;
      if (page.comments.some(([cs, ce]) => at >= cs && at < ce)) continue;
      out.push({ from: at, to: at + seg.segment.length, word: seg.segment });
    }
  }
  return out;
}

/** Answers by word for the current dictionaries; `bump` empties it. */
const cache = new Map<string, boolean>();

export function clearSpellCache(): void {
  cache.clear();
}

const setMisspelled = StateEffect.define<DecorationSet>();
const mark = Decoration.mark({ class: 'cm-nimw-misspelled' });

const misspelled = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    for (const e of tr.effects) if (e.is(setMisspelled)) return e.value;
    return set.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function misspelledAt(state: EditorState, pos: number): WordRange | null {
  let hit: WordRange | null = null;
  state.field(misspelled, false)?.between(pos, pos, (from, to) => {
    hit = { from, to, word: state.sliceDoc(from, to) };
    return false;
  });
  return hit;
}

const visibleWords = (view: EditorView) => {
  const text = view.state.doc.toString();
  const page = parsedFor(text, view.state);
  return view.visibleRanges.flatMap((r) => wordsToCheck(page, text, r.from, r.to));
};

const checker = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;
    unsubscribe: () => void;
    constructor(readonly view: EditorView) {
      this.unsubscribe = useSpellStore.subscribe((s, prev) => {
        if (s.setKey === prev.setKey) return;
        clearSpellCache();
        this.schedule();
      });
      this.schedule();
    }
    update(u: { docChanged: boolean; viewportChanged: boolean }) {
      if (u.docChanged || u.viewportChanged) this.schedule();
    }
    schedule() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.run(), SPELL_DEBOUNCE_MS);
    }
    async run() {
      this.timer = null;
      const asked = [...new Set(visibleWords(this.view).map((w) => w.word))]
        .filter((w) => !cache.has(w))
        .slice(0, MAX_WORDS);
      if (asked.length > 0) {
        const res = await spellCheck(asked, i18n.resolvedLanguage ?? i18n.language ?? 'en');
        // Other tests' IPC mocks answer null to commands they don't know.
        if (!res.ok || !Array.isArray(res.value)) return;
        asked.forEach((w, i) => cache.set(w, res.value[i] ?? true));
      }
      // Ranges from the editor as it is now: typing during the check is fine.
      const wrong = visibleWords(this.view).filter((w) => cache.get(w.word) === false);
      this.view.dispatch({
        effects: setMisspelled.of(Decoration.set(wrong.map((w) => mark.range(w.from, w.to)))),
      });
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
      this.unsubscribe();
    }
  },
);

type SpellMenuOpener = (target: WordRange, anchor: { x: number; y: number }) => void;
const openers = new WeakMap<EditorView, SpellMenuOpener>();

/** The editor component shows the spelling menu for its view. */
export function setSpellMenuOpener(view: EditorView, open: SpellMenuOpener | null): void {
  if (open) openers.set(view, open);
  else openers.delete(view);
}

/** Opens the menu for a misspelled word at `pos`; false leaves the event to
 *  the default menu (a correct word, or no menu here). */
export function openSpellMenuAt(
  view: EditorView,
  pos: number,
  anchor: { x: number; y: number },
): boolean {
  const target = misspelledAt(view.state, pos);
  const open = openers.get(view);
  if (!target || !open) return false;
  open(target, anchor);
  return true;
}

/** The context-menu key or Shift+F10 on the word at the cursor. */
const fromKeyboard = (view: EditorView) => {
  const pos = view.state.selection.main.head;
  const at = view.coordsAtPos(pos);
  return openSpellMenuAt(view, pos, { x: at?.left ?? 0, y: at?.bottom ?? 0 });
};

/** Spell checking for a page editor; leave it out to turn it off. */
export function spellcheck(): Extension {
  return [
    misspelled,
    checker,
    EditorView.domEventHandlers({
      contextmenu(e, view) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null || !openSpellMenuAt(view, pos, { x: e.clientX, y: e.clientY }))
          return false;
        e.preventDefault();
        return true;
      },
    }),
    keymap.of([
      { key: 'Shift-F10', run: fromKeyboard },
      { key: 'ContextMenu', run: fromKeyboard },
    ]),
  ];
}
