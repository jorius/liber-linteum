import {
  Children,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArchiveIcon,
  AudioIcon,
  CloseIcon,
  CodeIcon,
  ImageIcon,
  SearchIcon,
  SmallCloseIcon,
} from '../../app/icons';
import { assetUrl, type SearchHit } from '../../ipc';
import { openPage } from '../../stores/navigate';
import { usePageStore } from '../../stores/pageStore';
import { isTextPath } from '../../stores/textFiles';
import { useUiStore } from '../../stores/uiStore';
import { Dialog } from '../dialogs/Dialog';
import { useGvStore } from '../global-view/gvStore';
import { useIcons } from '../icons/ItemIcon';
import {
  highlightParts,
  pathTrail,
  queryWords,
  tagKey,
  takeFilterWord,
  type TextPart,
} from './highlight';
import { activeFilters, useSearchStore, type ActiveFilter } from './searchStore';
import styles from './Search.module.css';

/** The live region waits for typing to settle before it speaks. */
const ANNOUNCE_MS = 500;

function Marked({ parts }: { parts: TextPart[] }) {
  return (
    <>
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** Lines of chips a row shows before "+N more" (M5b §7.1). */
const ROW_LINES = 2;

/** The distinct line tops of a box's children, in order. */
function lineTops(box: HTMLElement): number[] {
  return [...new Set([...box.children].map((c) => (c as HTMLElement).offsetTop))].sort(
    (a, b) => a - b,
  );
}

/** A labelled group of chips that keeps to two lines; "+N more" shows the
 *  rest. A pressed chip is never hidden. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);
  const [open, setOpen] = useState(false);
  // How many chips show; null = all of them (also while measuring).
  const [shown, setShown] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const keys = items.map((c) => (c as { key?: unknown }).key).join('|');

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A new set of chips or a new width is measured again from all of them.
  useLayoutEffect(() => setShown(null), [keys, width]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const tops = lineTops(el);
    if (tops.length <= ROW_LINES) return;
    const kids = [...el.children] as HTMLElement[];
    if (shown === null) {
      const cut = kids.findIndex((k) => k.offsetTop >= tops[ROW_LINES]!);
      // One chip less leaves room for "+N more" on the last line.
      const next = Math.max(1, cut - 1);
      const pressedLater = kids.slice(next).some((k) => k.getAttribute('aria-pressed') === 'true');
      if (pressedLater) setOpen(true);
      else setShown(next);
    } else if (shown > 1) {
      // "+N more" itself wrapped to a third line: hide one more chip.
      setShown(shown - 1);
    }
  }, [shown, open, keys, width]);

  const visible = open || shown === null ? items : items.slice(0, shown);
  const hidden = items.length - visible.length;
  return (
    <div className={styles.row} role="group" aria-labelledby={id}>
      <span id={id} className={styles.rowLabel}>
        {label}
      </span>
      <div ref={box} className={styles.chips}>
        {visible}
        {hidden > 0 && (
          <button
            type="button"
            className={styles.moreChip}
            aria-expanded={false}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              // From the keyboard, focus goes to the first chip it shows, not to
              // nothing as the button leaves (final review M9).
              const first = e.currentTarget === document.activeElement ? visible.length : -1;
              setOpen(true);
              if (first >= 0) {
                requestAnimationFrame(() =>
                  box.current?.querySelectorAll<HTMLElement>('button')[first]?.focus(),
                );
              }
            }}
          >
            {t('search.moreChips', { count: hidden })}
          </button>
        )}
      </div>
    </div>
  );
}

function Chip({
  pressed,
  onClick,
  children,
  count,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={styles.chip}
      aria-pressed={pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </button>
  );
}

/** Search (M5 §4): a field with filter chips over the vault's pages, opened
 *  by the floating button, ⌘F / ⌘⇧F and View → Search…. ↑/↓ move through the results
 *  with the keyboard kept in the field; Enter opens the page, Shift+Enter
 *  its level in the Global View; Escape clears the text, then closes. */
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const icons = useIcons();
  const text = useSearchStore((s) => s.text);
  const filters = useSearchStore((s) => s.filters);
  const page = useSearchStore((s) => s.page);
  const extra = useSearchStore((s) => s.extra);
  const error = useSearchStore((s) => s.error);
  const loadingMore = useSearchStore((s) => s.loadingMore);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [active, setActive] = useState(0);
  const [announced, setAnnounced] = useState('');

  // Opening restores the last query (selected, so typing replaces it) and
  // asks again: the vault may have changed meanwhile.
  useEffect(() => {
    input.current?.select();
    void useSearchStore.getState().refresh();
  }, []);

  const hits: SearchHit[] = page ? [...page.results, ...extra] : [];
  const count = page
    ? page.recent
      ? t('search.recentCount', { count: hits.length })
      : t('search.results', { count: page.total })
    : '';
  useEffect(() => setActive(0), [page]);
  useEffect(() => {
    const id = setTimeout(() => setAnnounced(count), ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [count]);
  const optionId = (i: number) => `${listId}-${i}`;
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // optionId only depends on listId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const store = useSearchStore.getState;
  const addFilter = (kind: 'tag' | 'in' | 'to' | 'from', value: string) => {
    const f = store().filters;
    if (kind === 'tag') {
      const has = f.tags.some((x) => tagKey(x) === tagKey(value));
      store().setFilters({ tags: has ? f.tags : [...f.tags, value] });
    } else if (kind === 'in') store().setFilters({ folder: value });
    else if (kind === 'to') store().setFilters({ linksTo: value });
    else store().setFilters({ linksFrom: value });
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const taken = takeFilterWord(e.target.value, false);
    if (taken) {
      store().setText(taken.rest);
      addFilter(taken.filter.kind, taken.filter.value);
    } else store().setText(e.target.value);
  };

  const open = (hit: SearchHit, global: boolean) => {
    onClose();
    // A text file has no card in the Global View: it opens in the text view (batch 6).
    if (global && !isTextPath(hit.path)) {
      useUiStore.getState().setScreen('global');
      void useGvStore.getState().showPage(hit.path, hit.title);
    } else {
      // At the match the snippet shows, where there is one.
      const word = hit.snippet?.find((part) => part.hit)?.text;
      void openPage(hit.path).then(() => {
        if (word) usePageStore.getState().requestFind(hit.path, word);
      });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => Math.min(hits.length - 1, Math.max(0, a + step)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const taken = takeFilterWord(text, true);
      if (taken) {
        store().setText(taken.rest);
        addFilter(taken.filter.kind, taken.filter.value);
      } else if (store().stale()) {
        // The hits shown answer older text: search now, open its first hit.
        const global = e.shiftKey;
        void store()
          .refresh()
          .then(() => {
            const first = store().page?.results[0];
            if (first && !store().stale()) open(first, global);
          });
      } else if (hits[active]) open(hits[active], e.shiftKey);
    } else if (e.key === 'Escape' && text) {
      // The first Escape clears; the dialog closes on the next.
      e.preventDefault();
      e.stopPropagation();
      store().setText('');
    } else if (e.key === 'Backspace' && !text && store().removeLast()) {
      e.preventDefault();
    }
  };

  const facets = page?.facets;
  const words = queryWords(text);
  const tagOn = (v: string) => filters.tags.some((x) => tagKey(x) === tagKey(v));
  const chipLabel = (c: ActiveFilter): string => {
    switch (c.kind) {
      case 'project':
        return t('search.chipProject', { name: c.value });
      case 'folder':
        return t('search.chipFolder', { name: c.value });
      case 'tag':
        return `#${c.value}`;
      case 'linksTo': {
        const on = facets?.linksTo.find((p) => p.active);
        return t('search.chipLinksTo', { name: on?.title ?? c.value });
      }
      case 'linksFrom':
        return t('search.chipLinksFrom', { name: facets?.linksFrom?.title ?? c.value });
      case 'hasImage':
        return t('search.hasImage');
      case 'hasAudio':
        return t('search.hasAudio');
      case 'archived':
        return t('search.archived');
      case 'textFiles':
        return t('search.textFiles');
    }
  };
  const chips = activeFilters(filters);
  const showMedia =
    !!facets &&
    (facets.hasImage > 0 ||
      facets.hasAudio > 0 ||
      facets.archived > 0 ||
      facets.textFiles > 0 ||
      filters.hasImage ||
      filters.hasAudio ||
      filters.archived ||
      filters.textFiles);

  return (
    <Dialog title={t('search.title')} onClose={onClose} wide bare hideTitle>
      <div className={styles.field}>
        <SearchIcon />
        <input
          ref={input}
          data-autofocus
          className={styles.input}
          role="combobox"
          aria-label={t('search.field')}
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={hits.length ? optionId(active) : undefined}
          aria-describedby={`${listId}-hint`}
          placeholder={t('search.placeholder')}
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        {text && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('search.clear')}
            onClick={() => {
              store().setText('');
              input.current?.focus();
            }}
          >
            <SmallCloseIcon />
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('search.close')}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <p id={`${listId}-hint`} className={styles.hint}>
        {t('search.hint')}
      </p>

      {facets && (
        <div className={styles.filters}>
          {facets.projects.length > 0 && (
            <Row label={t('search.project')}>
              {facets.projects.map((p) => (
                <Chip
                  key={p.value}
                  pressed={filters.project === p.value}
                  count={p.count}
                  onClick={() =>
                    store().setFilters({ project: filters.project === p.value ? null : p.value })
                  }
                >
                  {p.value}
                </Chip>
              ))}
            </Row>
          )}
          {facets.tags.length > 0 && (
            <Row label={t('search.tags')}>
              {facets.tags.map((tag) => (
                <Chip
                  key={tag.value}
                  pressed={tagOn(tag.value)}
                  count={tag.count}
                  onClick={() =>
                    store().setFilters({
                      tags: tagOn(tag.value)
                        ? filters.tags.filter((x) => tagKey(x) !== tagKey(tag.value))
                        : [...filters.tags, tag.value],
                    })
                  }
                >
                  #{tag.value}
                </Chip>
              ))}
            </Row>
          )}
          {facets.linksTo.length > 0 && (
            <Row label={t('search.linksTo')}>
              {facets.linksTo.map((p) => (
                <Chip
                  key={p.path}
                  pressed={p.active}
                  count={p.count}
                  onClick={() => store().setFilters({ linksTo: p.active ? null : p.path })}
                >
                  {p.title}
                </Chip>
              ))}
            </Row>
          )}
          {showMedia && (
            <Row label={t('search.show')}>
              <Chip
                pressed={filters.hasImage}
                count={facets.hasImage}
                onClick={() => store().setFilters({ hasImage: !filters.hasImage })}
              >
                <ImageIcon />
                {t('search.hasImage')}
              </Chip>
              <Chip
                pressed={filters.hasAudio}
                count={facets.hasAudio}
                onClick={() => store().setFilters({ hasAudio: !filters.hasAudio })}
              >
                <AudioIcon />
                {t('search.hasAudio')}
              </Chip>
              <Chip
                pressed={filters.archived}
                count={facets.archived}
                onClick={() => store().setFilters({ archived: !filters.archived })}
              >
                <ArchiveIcon />
                {t('search.archived')}
              </Chip>
              <Chip
                pressed={filters.textFiles}
                count={facets.textFiles}
                onClick={() => store().setFilters({ textFiles: !filters.textFiles })}
              >
                <CodeIcon />
                {t('search.textFiles')}
              </Chip>
            </Row>
          )}
          {chips.length > 0 && (
            <Row label={t('search.active')}>
              {chips.map((c, i) => {
                const label = chipLabel(c);
                return (
                  <button
                    key={`${c.kind}-${i}`}
                    type="button"
                    className={styles.activeChip}
                    aria-label={t('search.remove', { label })}
                    onClick={() => store().removeFilter(c)}
                  >
                    {label}
                    <SmallCloseIcon />
                  </button>
                );
              })}
              <button type="button" className={styles.linkButton} onClick={store().clearFilters}>
                {t('search.clearAll')}
              </button>
            </Row>
          )}
        </div>
      )}

      <div className={styles.status}>
        {page?.recent ? (
          <h3 className={styles.recent}>{t('search.recent')}</h3>
        ) : (
          <span>{count}</span>
        )}
        {page?.indexing && <span className={styles.indexing}>{t('search.indexing')}</span>}
        {error && (
          <span className={styles.error} role="alert">
            {t('search.failed', { error })}
          </span>
        )}
      </div>
      <div role="status" aria-live="polite" className={styles.srOnly}>
        {announced}
      </div>

      <ul id={listId} role="listbox" aria-label={t('search.resultsLabel')} className={styles.list}>
        {hits.map((hit, i) => (
          <li
            key={hit.path}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            className={styles.hit}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== active && setActive(i)}
            onClick={(e) => open(hit, e.shiftKey)}
          >
            <span className={styles.thumb}>
              {/* Round 3b §8.2: the page's icon is its identity, ahead of its cover. */}
              {icons.get(hit.path) ? (
                <span className={styles.thumbIcon} aria-hidden="true">
                  {icons.get(hit.path)}
                </span>
              ) : hit.cover ? (
                <img src={assetUrl(hit.cover)} alt="" loading="lazy" />
              ) : isTextPath(hit.path) ? (
                <TextFileBadge path={hit.path} />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M6 3h8l4 4v14H6z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            <span className={styles.body}>
              <span className={styles.title}>
                <Marked parts={highlightParts(hit.title, words)} />
              </span>
              <span className={styles.path}>{pathTrail(hit.path)}</span>
              {hit.tags.length > 0 && (
                <span className={styles.tags}>{hit.tags.map((x) => `#${x}`).join('  ')}</span>
              )}
              {hit.snippet && (
                <span className={styles.snippet}>
                  <Marked parts={hit.snippet} />
                </span>
              )}
            </span>
            {hit.hasImage && (
              <span className={styles.media} role="img" aria-label={t('search.hasImage')}>
                <ImageIcon />
              </span>
            )}
            {hit.hasAudio && (
              <span className={styles.media} role="img" aria-label={t('search.hasAudio')}>
                <AudioIcon />
              </span>
            )}
          </li>
        ))}
      </ul>
      {page && hits.length === 0 && <p className={styles.none}>{t('search.none')}</p>}
      {page && !page.recent && hits.length < page.total && (
        <button
          type="button"
          className={styles.more}
          disabled={loadingMore}
          onClick={() => void store().showMore()}
        >
          {t('search.showMore')}
        </button>
      )}
    </Dialog>
  );
}

/** A text or code file's thumbnail (batch 6): its extension, or a code glyph
 *  for a name without one (`Makefile`). */
function TextFileBadge({ path }: { path: string }) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (
    <span className={styles.ext}>{name.slice(dot + 1).toUpperCase()}</span>
  ) : (
    <CodeIcon />
  );
}
