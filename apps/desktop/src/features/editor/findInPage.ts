// Find in page: CodeMirror's search panel, opened by ⌘F / Ctrl+F while the
// editor shows (Edit → Find… on macOS), styled with the app's tokens and
// labelled in the app's language. ⌘⇧F / Ctrl+Shift+F stays the vault-wide
// Search; outside the editor ⌘F opens Search too (useGlobalShortcuts).
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  openSearchPanel,
  search,
} from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import i18next from 'i18next';
import { isTauri, onMenuFind } from '../../ipc';
import { useUiStore } from '../../stores/uiStore';
import { openSearch } from '../search/searchMenu';
import { currentView } from './viewUpdates';

/** CodeMirror's English phrases → the app's `findInPage.*` keys. "Go to
 *  line" isn't bound (no ⌥⌘G), so it has none. */
const PHRASES: Record<string, string> = {
  Find: 'find',
  Replace: 'replaceField',
  next: 'next',
  previous: 'previous',
  all: 'all',
  'match case': 'matchCase',
  regexp: 'regexp',
  'by word': 'byWord',
  replace: 'replace',
  'replace all': 'replaceAll',
  close: 'close',
  'current match': 'currentMatch',
  'on line': 'onLine',
  // CodeMirror puts the number where the `$` is.
  'replaced $ matches': 'replacedMatches',
  'replaced match on line $': 'replacedOnLine',
};

/** The panel's words in the app's language (`EditorState.phrases`). */
export function findPhrases(t: (key: string) => string = i18next.t.bind(i18next)): Extension {
  const out: Record<string, string> = {};
  for (const [phrase, key] of Object.entries(PHRASES)) out[phrase] = t(`findInPage.${key}`);
  return EditorState.phrases.of(out);
}

/** The phrases of each editor state, swapped when the language changes. */
export const phrasesSlot = new Compartment();

/** The panel and its matches, drawn like the app's fields and buttons in
 *  every palette, light and dark (`.cm-panels` is CodeMirror's own grey). */
const findTheme = EditorView.theme({
  '.cm-panels': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-body)',
  },
  // Inset by the editor's focus ring (Editor.module.css), which it would cover.
  '.cm-panels.cm-panels-top': {
    margin: '2px 2px 0',
    borderBottom: '1px solid var(--color-border)',
  },
  '.cm-panel.cm-search': {
    padding: '8px 48px 6px 12px',
    fontSize: '13px',
    lineHeight: '1.3',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    margin: '0 6px 4px 0',
    verticalAlign: 'middle',
  },
  '.cm-panel.cm-search .cm-textfield': {
    boxSizing: 'border-box',
    width: '220px',
    maxWidth: 'calc(100% - 12px)',
    height: '30px',
    padding: '0 10px',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--color-surface-subtle)',
    color: 'var(--color-text)',
    font: '400 13px var(--font-body)',
  },
  '.cm-panel.cm-search .cm-textfield::placeholder': { color: 'var(--color-text-faint)' },
  '.cm-panel.cm-search .cm-textfield:focus': {
    outline: '2px solid var(--color-focus)',
    outlineOffset: '1px',
    borderColor: 'var(--color-accent)',
  },
  '.cm-panel.cm-search .cm-button': {
    boxSizing: 'border-box',
    height: '30px',
    padding: '0 10px',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--color-surface)',
    backgroundImage: 'none',
    color: 'var(--color-text)',
    font: '600 12.5px var(--font-body)',
    textTransform: 'none',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search .cm-button:hover': { borderColor: 'var(--color-accent)' },
  '.cm-panel.cm-search .cm-button:active': {
    backgroundImage: 'none',
    backgroundColor: 'var(--color-accent-soft)',
  },
  '.cm-panel.cm-search .cm-button:focus-visible': {
    outline: '2px solid var(--color-focus)',
    outlineOffset: '1px',
  },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '30px',
    fontSize: '12.5px',
    color: 'var(--color-text-body)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search input[type=checkbox]': {
    margin: '0',
    accentColor: 'var(--color-accent)',
  },
  '.cm-panel.cm-search [name=close]': {
    top: '8px',
    right: '10px',
    width: '30px',
    height: '30px',
    margin: '0',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--color-text-muted)',
    fontSize: '20px',
    lineHeight: '1',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': {
    backgroundColor: 'var(--color-accent-soft)',
    color: 'var(--color-text)',
  },
  '.cm-panel.cm-search [name=close]:focus-visible': {
    outline: '2px solid var(--color-focus)',
    outlineOffset: '1px',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--color-highlight-bg)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--color-highlight-bg)',
    outline: '2px solid var(--color-accent)',
  },
});

/** Find (and, unless the state is read-only, replace) in the page: the panel
 *  at the top of the editor; Enter / ⇧Enter and F3 / ⇧F3 (⌘G / ⇧⌘G) step
 *  through the matches, Escape closes it and gives the text back the
 *  keyboard. ⌘F / Ctrl+F itself is the page's shortcut (`openFindInPage`,
 *  from useGlobalShortcuts), so it isn't bound here. */
export function findInPage(): Extension {
  return [
    search({ top: true }),
    keymap.of([
      {
        key: 'F3',
        run: findNext,
        shift: findPrevious,
        scope: 'editor search-panel',
        preventDefault: true,
      },
      {
        key: 'Mod-g',
        run: findNext,
        shift: findPrevious,
        scope: 'editor search-panel',
        preventDefault: true,
      },
      { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
    ]),
    findTheme,
    phrasesSlot.of(findPhrases()),
  ];
}

/** The page editor on screen, if find can open in it: mounted, the editor
 *  screen showing (not the Global View or the Trash), no dialog over it. */
export function findableView(): EditorView | null {
  const view = currentView();
  if (!view?.dom.isConnected) return null;
  const ui = useUiStore.getState();
  return ui.screen === 'edit' && !ui.dialog ? view : null;
}

/** Opens find in the page on screen (again: its field takes the keyboard);
 *  `false` when there is none. */
export function openFindInPage(): boolean {
  const view = findableView();
  if (!view) return false;
  openSearchPanel(view);
  return true;
}

/** Edit → Find… (macOS app menu, ⌘F): find in the page; in the main window
 *  with no editor showing, the vault's Search, as the key does. */
export function installFindMenuIfTauri(main: boolean): void {
  if (!isTauri()) return;
  void onMenuFind(() => {
    if (!openFindInPage() && main) openSearch();
  }).catch(() => undefined);
}
