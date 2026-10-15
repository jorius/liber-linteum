import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { AudioIcon, CloseIcon, ImageIcon, SearchIcon, SmallCloseIcon } from '../../app/icons';
import { assetUrl, type SearchHit } from '../../ipc';
import { openPage } from '../../stores/navigate';
import { useUiStore } from '../../stores/uiStore';
import { Dialog } from '../dialogs/Dialog';
import { useGvStore } from '../global-view/gvStore';
import { ItemIcon, useIcons } from '../icons/ItemIcon';
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className={styles.row} role="group" aria-labelledby={id}>
      <span id={id} className={styles.rowLabel}>
        {label}
      </span>
      <div className={styles.chips}>{children}</div>
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
 *  by the top bar, ⌘⇧F and View → Search…. ↑/↓ move through the results
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
    if (global) {
      useUiStore.getState().setScreen('global');
      void useGvStore.getState().showPage(hit.path, hit.title);
    } else void openPage(hit.path);
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
    }
  };
  const chips = activeFilters(filters);
  const showMedia =
    !!facets &&
    (facets.hasImage > 0 || facets.hasAudio > 0 || filters.hasImage || filters.hasAudio);

  return (
    <Dialog title={t('search.title')} onClose={onClose} wide hideTitle>
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
            <Row label={t('search.media')}>
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
              {hit.cover ? (
                <img src={assetUrl(hit.cover)} alt="" loading="lazy" />
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
                <ItemIcon icon={icons.get(hit.path)} />
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
