import { EditorView } from '@codemirror/view';
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
import { filterLanguages, setFenceLanguage } from './codeLanguages';
import styles from './Editor.module.css';
import { placePopup } from './placePopup';

const MAX = 40;

/** The searchable language list a code block's badge opens (M4b part 2 §2):
 *  "Plain text" first, then the languages matching what's typed. */
export function LanguagePicker({
  view,
  at,
  anchor,
  onClose,
}: {
  view: EditorView;
  at: number;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const plain = { name: t('code.plain'), id: '' };
  const found = filterLanguages(query).slice(0, MAX);
  const options = query.trim() ? found : [plain, ...found];

  const reposition = useCallback(() => {
    if (!anchor.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const el = box.current;
    const at2 = { top: r.top, bottom: r.bottom, left: r.left };
    const size = { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
    const { top, left } = placePopup(at2, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    setPlace({ top, left });
  }, [anchor]);
  useLayoutEffect(reposition, [reposition, options.length]);
  useEffect(() => {
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  const pick = (id: string) => {
    setFenceLanguage(view, at, id);
    onClose();
    view.focus();
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
      if (o) pick(o.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      anchor.focus();
    }
  };
  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div ref={box} className={styles.linkPicker} style={place ?? undefined}>
      <input
        className={styles.linkPickerInput}
        role="combobox"
        aria-label={t('code.pickLanguage')}
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options.length ? optionId(active) : undefined}
        placeholder={t('code.searchLanguage')}
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={onClose}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={t('code.languages')}
        className={styles.linkPickerList}
      >
        {options.map((o, i) => (
          <li
            key={o.id || 'plain'}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            className={styles.linkPickerOption}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(o.id)}
          >
            {o.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
