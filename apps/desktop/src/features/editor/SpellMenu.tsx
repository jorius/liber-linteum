import type { EditorView } from '@codemirror/view';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { spellAddWord, spellIgnore, spellSuggest, type IpcResult } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useSpellStore } from '../../stores/spellStore';
import { useToastStore } from '../../stores/toastStore';
import type { WordRange } from './spell';

/** The menu for a misspelled word (spell checking spec §6): suggestions,
 *  then Add to dictionary and Ignore. `onClose(refocus)`: true after a
 *  choice or Escape, to give the keyboard back to the editor. */
export function SpellMenu({
  view,
  target,
  anchor,
  onClose,
}: {
  view: EditorView;
  target: WordRange;
  anchor: { x: number; y: number };
  onClose: (refocus: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [active, setActive] = useState(0);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void spellSuggest(target.word, i18n.resolvedLanguage ?? 'en').then((r) => {
      if (live) setSuggestions(r.ok && Array.isArray(r.value) ? r.value.slice(0, 7) : []);
    });
    return () => {
      live = false;
    };
  }, [target.word, i18n.resolvedLanguage]);
  const count = (suggestions?.length ?? 0) + 2;
  useEffect(() => {
    if (suggestions) items.current[active]?.focus();
  }, [active, suggestions]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const replace = (word: string) => {
    onClose(true);
    // Typing since the menu opened may have moved or removed the word.
    if (view.state.sliceDoc(target.from, target.to) !== target.word) return;
    view.dispatch({
      changes: { from: target.from, to: target.to, insert: word },
      userEvent: 'input.spell',
    });
  };
  const remember = (save: (word: string) => Promise<IpcResult<void>>) => {
    onClose(true);
    void save(target.word).then((r) => {
      if (r.ok) useSpellStore.getState().bump();
      else useToastStore.getState().push({ message: errorMessage(r.error), tone: 'error' });
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % count);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + count) % count);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(e.key === 'Escape');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  // Stable keys: the suggestions arriving must not replace the other items.
  const item = (key: string, i: number, label: string, run: () => void) => (
    <button
      key={key}
      ref={(el) => {
        items.current[i] = el;
      }}
      type="button"
      role="menuitem"
      tabIndex={i === active ? 0 : -1}
      onClick={run}
    >
      {label}
    </button>
  );
  const n = suggestions?.length ?? 0;

  return (
    <div
      ref={box}
      role="menu"
      aria-label={t('spelling.menu', { word: target.word })}
      className="nimw-menu"
      style={{ position: 'fixed', left: anchor.x, top: anchor.y }}
      onKeyDown={onKeyDown}
    >
      {suggestions?.map((s, i) => item(`s:${s}`, i, s, () => replace(s)))}
      {suggestions && n === 0 && (
        <span role="none" aria-disabled="true" className="nimw-menu-note">
          {t('spelling.noSuggestions')}
        </span>
      )}
      <div role="separator" />
      {item('add', n, t('spelling.add'), () => remember(spellAddWord))}
      {item('ignore', n + 1, t('spelling.ignore'), () => remember(spellIgnore))}
    </div>
  );
}
