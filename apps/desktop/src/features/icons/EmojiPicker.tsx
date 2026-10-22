import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { placePopup, windowViewport, type Anchor } from '../editor/placePopup';
import {
  emojiName,
  loadEmoji,
  recentIcons,
  rememberIcon,
  searchEmoji,
  type EmojiGroup,
} from './emoji';
import styles from './Icons.module.css';

const COLUMNS = 8;
const MAX_RESULTS = 240;
/** Each group's button shows one of its emoji. */
const GROUP_GLYPH: Record<string, string> = {
  'smileys-emotion': '😀',
  'people-body': '👋',
  'animals-nature': '🐻',
  'food-drink': '🍔',
  'travel-places': '✈️',
  activities: '⚽',
  objects: '💡',
  symbols: '❤️',
  flags: '🏁',
};

export interface EmojiPickerProps {
  /** Where it opens (under its trigger), re-read on scroll and resize. */
  anchor: () => Anchor | null;
  label: string;
  /** Offer Remove. */
  hasIcon: boolean;
  /** An emoji, or `null` to remove the icon. */
  onPick: (emoji: string | null) => void;
  onClose: () => void;
}

/** Optional emoji icons' picker (M5b §4): a search field, Recent and the
 *  Unicode groups, and a grid of emoji (ARIA grid, arrow keys). */
export function EmojiPicker({ anchor, label, hasIcon, onPick, onClose }: EmojiPickerProps) {
  const { t, i18n } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [groups, setGroups] = useState<EmojiGroup[]>([]);
  const [recent] = useState(recentIcons);
  const [tab, setTab] = useState<string>(() =>
    recentIcons().length ? 'recent' : 'smileys-emotion',
  );
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let live = true;
    void loadEmoji().then((g) => live && setGroups(g));
    return () => {
      live = false;
    };
  }, []);

  const items: string[] = query.trim()
    ? searchEmoji(groups, query).slice(0, MAX_RESULTS)
    : tab === 'recent'
      ? recent
      : (groups.find((g) => g.id === tab)?.items.map((i) => i[0]) ?? []);

  const reposition = useCallback(() => {
    const at = anchor();
    const el = box.current;
    if (!at || !el) return;
    const { top, left } = placePopup(
      at,
      { width: el.offsetWidth, height: el.offsetHeight },
      windowViewport(),
    );
    setPlace((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, [anchor]);
  useLayoutEffect(reposition, [reposition, groups.length]);
  useEffect(() => {
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const pick = (emoji: string) => {
    rememberIcon(emoji);
    onPick(emoji);
  };
  const focusCell = (i: number) => {
    const next = Math.max(0, Math.min(items.length - 1, i));
    setActive(next);
    cellRefs.current[next]?.focus();
  };

  const onBoxKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      focusCell(0);
    } else if (e.key === 'Enter' && items.length) {
      e.preventDefault();
      pick(items[0]);
    }
  };
  const onCellKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const moves: Record<string, number> = {
      ArrowRight: i + 1,
      ArrowLeft: i - 1,
      ArrowDown: i + COLUMNS,
      ArrowUp: i - COLUMNS,
      Home: 0,
      End: items.length - 1,
    };
    if (e.key in moves) {
      e.preventDefault();
      if (e.key === 'ArrowUp' && i < COLUMNS) box.current?.querySelector('input')?.focus();
      else focusCell(moves[e.key]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(items[i]);
    }
  };

  const rows: string[][] = [];
  for (let i = 0; i < items.length; i += COLUMNS) rows.push(items.slice(i, i + COLUMNS));
  const tabs = [...(recent.length ? ['recent'] : []), ...groups.map((g) => g.id)];
  const lang = i18n.language;

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      className={styles.picker}
      style={place ?? undefined}
      onKeyDown={onBoxKey}
    >
      <div className={styles.pickerHead}>
        <input
          type="search"
          className={`field-control ${styles.search}`}
          aria-label={t('icons.search')}
          placeholder={t('icons.search')}
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onSearchKey}
        />
        {hasIcon && (
          <button type="button" className={styles.remove} onClick={() => onPick(null)}>
            {t('icons.remove')}
          </button>
        )}
      </div>
      {!query.trim() && (
        <div className={styles.tabs} role="group" aria-label={t('icons.grid')}>
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              className={styles.tab}
              aria-pressed={tab === id}
              aria-label={id === 'recent' ? t('icons.recent') : t(`icons.groups.${id}`)}
              title={id === 'recent' ? t('icons.recent') : t(`icons.groups.${id}`)}
              onClick={() => {
                setTab(id);
                setActive(0);
              }}
            >
              <span aria-hidden="true">{id === 'recent' ? '🕘' : GROUP_GLYPH[id]}</span>
            </button>
          ))}
        </div>
      )}
      {items.length === 0 && groups.length > 0 ? (
        <p className={styles.none}>{t('icons.none')}</p>
      ) : (
        <div role="grid" aria-label={t('icons.grid')} className={styles.grid}>
          {rows.map((row, r) => (
            <div role="row" key={r} className={styles.row}>
              {row.map((emoji, c) => {
                const i = r * COLUMNS + c;
                return (
                  <div
                    key={emoji}
                    ref={(el) => {
                      cellRefs.current[i] = el;
                    }}
                    role="gridcell"
                    tabIndex={i === Math.min(active, items.length - 1) ? 0 : -1}
                    aria-label={emojiName(groups, emoji, lang)}
                    className={styles.cell}
                    onClick={() => pick(emoji)}
                    onKeyDown={(e) => onCellKey(e, i)}
                    onFocus={() => setActive(i)}
                  >
                    {emoji}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
