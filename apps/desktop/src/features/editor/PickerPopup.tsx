import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { linkSuggest, type LinkSuggestion } from '../../ipc';
import { Icon } from '../explorer/TreeRow';
import { useIcons } from '../icons/ItemIcon';
import styles from './Editor.module.css';
import { placePopup, type Anchor } from './placePopup';

const URL_RE = /^(?:https?:\/\/|mailto:)\S+$/i;
const MAX_PAGES = 8;

export type PickerOption = { kind: 'url'; url: string } | { kind: 'page'; page: LinkSuggestion };

export interface PickerPopupProps {
  /** The page links resolve from (`link_suggest`'s source). */
  source: string;
  /** Where it points at, re-read when anything scrolls or the window
   *  resizes; `null` while unknown. */
  anchor: () => Anchor | null;
  /** Offer the typed web address as the first option. */
  allowUrl: boolean;
  label: string;
  placeholder: string;
  onPick: (option: PickerOption) => void;
  /** `refocus`: give the keyboard back to where the picker was opened. */
  onClose: (refocus: boolean) => void;
}

/** A combobox over the vault's pages (M2c §6.3), anchored to a line of text
 *  or a button: it follows its anchor while anything scrolls, flips above
 *  when there's no room below and stays inside the window (M4b §4). */
export function PickerPopup({
  source,
  anchor,
  allowUrl,
  label,
  placeholder,
  onPick,
  onClose,
}: PickerPopupProps) {
  const { t } = useTranslation();
  const icons = useIcons();
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<LinkSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let live = true;
    void linkSuggest(source, query.trim(), false).then((res) => {
      if (!live || !res.ok) return;
      setPages(res.value.filter((s) => s.kind === 'page').slice(0, MAX_PAGES));
      setActive(0);
    });
    return () => {
      live = false;
    };
  }, [query, source]);

  const reposition = useCallback(() => {
    const at = anchor();
    if (!at) {
      setPlace(null);
      return;
    }
    const el = box.current;
    const size = { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
    const { top, left } = placePopup(at, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    setPlace((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, [anchor]);

  // Once mounted and whenever its contents change size; then on every
  // scroll (any scroller: captured on window) and resize.
  useLayoutEffect(reposition, [reposition, pages.length, query]);
  useEffect(() => {
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  const url = allowUrl && URL_RE.test(query.trim()) ? query.trim() : null;
  const options: PickerOption[] = [
    ...(url ? [{ kind: 'url' as const, url }] : []),
    ...pages.map((page) => ({ kind: 'page' as const, page })),
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + step + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o) onPick(o);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose(true);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div ref={box} className={styles.linkPicker} style={place ?? undefined}>
      <input
        className={`field-control ${styles.linkPickerInput}`}
        role="combobox"
        aria-label={label}
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options.length ? optionId(active) : undefined}
        placeholder={placeholder}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => onClose(false)}
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
            className={
              o.kind === 'url'
                ? styles.linkPickerOption
                : `${styles.linkPickerOption} ${styles.linkPickerPage}`
            }
            // Keep focus in the input; the click picks.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o)}
          >
            {o.kind === 'url' ? (
              t('linkPicker.url', { url: o.url })
            ) : (
              <>
                {/* Round 3b §8.2: the page's icon in a leading box. */}
                <span className={styles.linkPickerIcon} aria-hidden="true">
                  {icons.get(o.page.path) ?? (
                    <Icon node={{ path: o.page.path, kind: o.page.kind }} expanded={false} />
                  )}
                </span>
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
