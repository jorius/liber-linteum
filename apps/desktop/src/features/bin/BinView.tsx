import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderIcon, ImageIcon, RestoreIcon, TrashIcon } from '../../app/icons';
import { assetUrl, type BinItem } from '../../ipc';
import { nameOf, parentOf, shownName } from '../../stores/tree';
import { useShowExtensions } from '../explorer/TreeRow';
import { Dialog } from '../dialogs/Dialog';
import dialogStyles from '../dialogs/Dialogs.module.css';
import { deleteItems, emptyTrash, restoreItem } from './binActions';
import { useBinStore } from './binStore';
import styles from './Bin.module.css';

type Ask = { type: 'delete'; items: BinItem[] } | { type: 'empty' };
type Sort = 'newest' | 'oldest' | 'name' | 'folder';

/** A page's name without `.md` (with it when extensions show); a folder's
 *  or attachment's as is. */
export const binLabel = (path: string, extensions = false) => shownName(path, extensions);
const label = (item: BinItem, extensions: boolean) =>
  item.folder ? nameOf(item.path) : binLabel(item.path, extensions);
const isImage = (path: string) => /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path);
const kindOf = (item: BinItem) =>
  item.folder
    ? 'folder'
    : /\.md$/i.test(item.path)
      ? 'page'
      : isImage(item.path)
        ? 'image'
        : 'file';
const DAY = 86_400_000;

// The sort is remembered for the session (M5b round 2).
let sessionSort: Sort = 'newest';
/** Tests: back to the default sort. */
export const resetTrashView = () => {
  sessionSort = 'newest';
};

/** Bytes as `512 byte`, `840 kB` or `1.2 MB` (1024-based). */
export function formatSize(bytes: number, lang: string) {
  const [value, unit, digits] =
    bytes < 1024
      ? [bytes, 'byte', 0]
      : bytes < 1024 * 1024
        ? [bytes / 1024, 'kilobyte', 0]
        : [bytes / 1024 / 1024, 'megabyte', 1];
  return new Intl.NumberFormat(lang, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: digits,
  }).format(value);
}

/** The Trash, in place of the editor (M5b §5.2; round 2 design): items by the
 *  day they were deleted, filtered and sorted, restored or deleted one by
 *  one or as a selection. */
export function BinView() {
  const { t, i18n } = useTranslation();
  const items = useBinStore((s) => s.trash);
  const extensions = useShowExtensions();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>(sessionSort);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const ids = { title: useId(), sort: useId() };
  useEffect(() => {
    void useBinStore.getState().refresh();
  }, []);
  // Items that left the Trash leave the selection.
  useEffect(() => {
    setPicked((p) => {
      const kept = new Set([...p].filter((path) => items.some((i) => i.path === path)));
      return kept.size === p.size ? p : kept;
    });
  }, [items]);

  const lang = i18n.language;
  const fromFolder = (item: BinItem) =>
    item.from === null ? null : parentOf(item.from) || t('bin.root');
  const time = (at: number) => new Intl.DateTimeFormat(lang, { timeStyle: 'short' }).format(at);
  const date = (at: number) => new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(at);
  const dayGroup = (at: number | null) => {
    if (at === null) return t('bin.unknownDate');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime();
    if (at >= start) return t('bin.today');
    if (at >= start - DAY) return t('bin.yesterday');
    if (at >= start - 6 * DAY) return t('bin.thisWeek');
    return date(at);
  };

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = items.filter(
      (i) =>
        !q ||
        label(i, extensions).toLowerCase().includes(q) ||
        (i.from ?? '').toLowerCase().includes(q),
    );
    const byName = (a: BinItem, b: BinItem) =>
      label(a, extensions).localeCompare(label(b, extensions), lang);
    const byAt = (a: BinItem, b: BinItem) => (b.at ?? 0) - (a.at ?? 0);
    const sorted = [...shown].sort(
      sort === 'newest'
        ? byAt
        : sort === 'oldest'
          ? (a, b) => -byAt(a, b)
          : sort === 'name'
            ? byName
            : (a, b) =>
                (fromFolder(a) ?? '').localeCompare(fromFolder(b) ?? '', lang) || byName(a, b),
    );
    const out: [string, BinItem[]][] = [];
    for (const item of sorted) {
      const key =
        sort === 'name'
          ? t('bin.allItems')
          : sort === 'folder'
            ? (fromFolder(item) ?? t('bin.unknownFrom'))
            : dayGroup(item.at);
      const last = out[out.length - 1];
      if (last && last[0] === key) last[1].push(item);
      else out.push([key, [item]]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, sort, lang, extensions]);

  const total = items.reduce((sum, i) => sum + (i.size ?? 0), 0);
  const chosen = items.filter((i) => picked.has(i.path));
  const toggle = (path: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  // One bulk action at a time: its buttons wait until it ends (round-2 review I2).
  const [busy, setBusy] = useState(false);
  const bulk = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };
  const restoreChosen = () =>
    bulk(async () => {
      for (const item of chosen) await restoreItem('trash', item.path);
    });
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && picked.size > 0 && !ask) {
      e.stopPropagation();
      setPicked(new Set());
    }
  };

  const meta = (item: BinItem) => {
    const kind = kindOf(item);
    const parts = [t(`bin.kind.${kind}`)];
    if (kind === 'folder' && item.pages !== undefined)
      parts.push(t('bin.pages', { count: item.pages }));
    if ((kind === 'image' || kind === 'file') && item.size !== undefined) {
      parts.push(formatSize(item.size, lang));
    }
    const from = fromFolder(item);
    parts.push(from === null ? t('bin.unknownFrom') : t('bin.fromLower', { folder: from }));
    if (item.at !== null) {
      const recent = item.at >= Date.now() - 2 * DAY;
      parts.push(t('bin.deletedAt', { when: recent ? time(item.at) : date(item.at) }));
    }
    return parts.join(' · ');
  };

  return (
    <section className={styles.view} aria-labelledby={ids.title} onKeyDown={onKeyDown}>
      <header className={styles.head}>
        <span className={styles.headTile} aria-hidden="true">
          <TrashIcon />
        </span>
        <div className={styles.headText}>
          <h1 id={ids.title} className={styles.title}>
            {t('bin.trash')}
          </h1>
          {items.length > 0 && (
            <p className={styles.note}>
              {t('bin.summary', { count: items.length, size: formatSize(total, lang) })}
            </p>
          )}
        </div>
        {items.length > 0 && (
          <button
            type="button"
            className={styles.emptyButton}
            onClick={() => setAsk({ type: 'empty' })}
          >
            <TrashIcon />
            {t('bin.empty')}
          </button>
        )}
      </header>

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyTile} aria-hidden="true">
            <TrashIcon />
          </span>
          <h2 className={styles.emptyTitle}>{t('bin.emptyTitleState')}</h2>
          <p className={styles.note}>{t('bin.emptyHelp')}</p>
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <input
              type="search"
              className={`field-control ${styles.filter}`}
              aria-label={t('bin.filter')}
              placeholder={t('bin.filterPlaceholder')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <label htmlFor={ids.sort} className={styles.sortLabel}>
              {t('bin.sort')}
            </label>
            <select
              id={ids.sort}
              className="field-control"
              value={sort}
              onChange={(e) => {
                sessionSort = e.target.value as Sort;
                setSort(sessionSort);
              }}
            >
              <option value="newest">{t('bin.sortNewest')}</option>
              <option value="oldest">{t('bin.sortOldest')}</option>
              <option value="name">{t('bin.sortName')}</option>
              <option value="folder">{t('bin.sortFolder')}</option>
            </select>
          </div>

          {chosen.length > 0 && (
            <div role="region" aria-label={t('bin.selection')} className={styles.selectionBar}>
              <span className={styles.selectionCount} aria-live="polite">
                {t('bin.selected', { count: chosen.length })}
              </span>
              <button
                type="button"
                className={styles.barButton}
                disabled={busy}
                onClick={() => void restoreChosen()}
              >
                <RestoreIcon />
                {t('bin.restore')}
              </button>
              <button
                type="button"
                className={`${styles.barButton} ${styles.barDanger}`}
                disabled={busy}
                onClick={() => setAsk({ type: 'delete', items: chosen })}
              >
                <TrashIcon />
                {t('bin.delete')}
              </button>
            </div>
          )}

          {groups.length === 0 && (
            <p className={styles.note}>{t('bin.noMatch', { query: filter.trim() })}</p>
          )}
          {groups.map(([heading, list]) => (
            <section key={heading} className={styles.group}>
              <h2 className={styles.groupTitle} aria-hidden="true">
                {heading}
              </h2>
              <ul className={styles.list} aria-label={heading}>
                {list.map((item) => {
                  const name = label(item, extensions);
                  const from = fromFolder(item);
                  return (
                    <li
                      key={item.path}
                      aria-label={name}
                      className={`${styles.item} ${picked.has(item.path) ? styles.picked : ''}`}
                    >
                      <input
                        type="checkbox"
                        className={styles.check}
                        aria-label={t('bin.select', { name })}
                        checked={picked.has(item.path)}
                        onChange={() => toggle(item.path)}
                      />
                      <Tile item={item} />
                      <span className={styles.text}>
                        <span className={styles.name} data-name>
                          {name}
                        </span>
                        <span className={styles.meta}>{meta(item)}</span>
                      </span>
                      <button
                        type="button"
                        className={styles.restoreButton}
                        disabled={busy}
                        aria-label={t('bin.restoreName', { name })}
                        title={
                          from === null ? t('bin.restore') : t('bin.restoreTo', { folder: from })
                        }
                        onClick={() => void restoreItem('trash', item.path)}
                      >
                        <RestoreIcon />
                        {t('bin.restore')}
                      </button>
                      <button
                        type="button"
                        className={styles.deleteButton}
                        disabled={busy}
                        aria-label={t('bin.deleteName', { name })}
                        title={t('bin.deleteTitleShort')}
                        onClick={() => setAsk({ type: 'delete', items: [item] })}
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
      {ask && <Confirm ask={ask} count={items.length} bulk={bulk} onClose={() => setAsk(null)} />}
    </section>
  );
}

/** The item's emoji, a folder, an image's thumbnail, or a page or file glyph. */
function Tile({ item }: { item: BinItem }) {
  const [broken, setBroken] = useState(false);
  const kind = kindOf(item);
  if (kind === 'image' && !broken) {
    return (
      <img
        className={styles.tile}
        src={assetUrl(item.path)}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className={styles.tile} aria-hidden="true">
      {item.icon ??
        (kind === 'folder' ? <FolderIcon /> : kind === 'image' ? <ImageIcon /> : <PageGlyph />)}
    </span>
  );
}

function PageGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h8l4 4v14H6z" />
    </svg>
  );
}

function Confirm({
  ask,
  count,
  bulk,
  onClose,
}: {
  ask: Ask;
  count: number;
  bulk: (run: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, confirm, run] =
    ask.type === 'delete'
      ? [
          t('bin.deleteTitle', { count: ask.items.length }),
          t('bin.delete'),
          () => deleteItems(ask.items),
        ]
      : [t('bin.emptyTitle', { count }), t('bin.empty'), () => emptyTrash()];
  const go = () => {
    onClose();
    void bulk(run);
  };
  return (
    <Dialog title={title} onClose={onClose} onConfirm={go}>
      <p className={dialogStyles.text}>{t('bin.deleteBody')}</p>
      <div className={dialogStyles.buttons}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button type="button" className="btn btn-danger" data-autofocus onClick={go}>
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}
