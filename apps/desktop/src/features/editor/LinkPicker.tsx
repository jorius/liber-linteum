import type { EditorView } from '@codemirror/view';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { linkSuggest, type LinkSuggestion } from '../../ipc';
import styles from './Editor.module.css';
import { aliasFor } from './linkComplete';
import { pagePath } from './livePreview';

const URL_RE = /^(?:https?:\/\/|mailto:)\S+$/i;
const MAX_PAGES = 8;

type Option = { kind: 'url'; url: string } | { kind: 'page'; page: LinkSuggestion };

/** "Link to…" (M2c §6.3): a combobox over the vault's pages, plus the typed
 *  web address. A page links the selection as `[[target|selection]]` (or
 *  `[[target]]` / `[[target|Title]]` without one); a URL gives `[text](url)`. */
export function LinkPicker({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const { t } = useTranslation();
  const listId = useId();
  const range = useRef(view.state.selection.main);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<LinkSuggestion[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let live = true;
    const source = view.state.facet(pagePath)();
    void linkSuggest(source, query.trim(), false).then((res) => {
      if (!live || !res.ok) return;
      setPages(res.value.filter((s) => s.kind === 'page').slice(0, MAX_PAGES));
      setActive(0);
    });
    return () => {
      live = false;
    };
  }, [query, view]);

  const url = URL_RE.test(query.trim()) ? query.trim() : null;
  const options: Option[] = [
    ...(url ? [{ kind: 'url' as const, url }] : []),
    ...pages.map((page) => ({ kind: 'page' as const, page })),
  ];

  const close = (refocus: boolean) => {
    onClose();
    if (refocus) view.focus();
  };
  const pick = (o: Option) => {
    const length = view.state.doc.length;
    const from = Math.min(range.current.from, length);
    const to = Math.min(range.current.to, length);
    const selected = view.state.sliceDoc(from, to).replace(/\n/g, ' ');
    let insert: string;
    if (o.kind === 'url') insert = `[${selected || o.url}](${o.url})`;
    else {
      const alias = selected || aliasFor(o.page);
      insert = alias ? `[[${o.page.target}|${alias}]]` : `[[${o.page.target}]]`;
    }
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.link',
    });
    close(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + step + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  };

  const at = view.coordsAtPos(range.current.from);
  const style = at ? { top: at.bottom + 6, left: at.left } : undefined;
  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div className={styles.linkPicker} style={style}>
      <input
        className={styles.linkPickerInput}
        role="combobox"
        aria-label={t('linkPicker.label')}
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options.length ? optionId(active) : undefined}
        placeholder={t('linkPicker.placeholder')}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => close(false)}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={t('linkPicker.results')}
        className={styles.linkPickerList}
      >
        {options.map((o, i) => (
          <li
            key={o.kind === 'url' ? 'url' : o.page.path}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            className={styles.linkPickerOption}
            // Keep focus in the input; the click picks.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(o)}
          >
            {o.kind === 'url' ? (
              t('linkPicker.url', { url: o.url })
            ) : (
              <>
                <span>{o.page.title ?? o.page.target}</span>
                <span className={styles.linkPickerPath}>{o.page.path}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
