import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderIcon, LockIcon, SearchIcon, SmallCloseIcon } from '../../app/icons';
import { vaultsForget, vaultsRecent, vaultsReveal, type RecentVault } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { ItemIcon } from '../icons/ItemIcon';
import { QuickNoteIcon } from '../scratchpad/QuickNoteIcon';
import styles from './Welcome.module.css';

/** The filter shows once the list is longer than this (R3 §7). */
const FILTER_FROM = 6;

const OS = /Mac/i.test(navigator.platform)
  ? 'mac'
  : /Win/i.test(navigator.platform)
    ? 'windows'
    : 'other';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "5 minutes ago", "yesterday", "last week"… in `lng`; null without a date. */
export function lastOpened(iso: string, now: number, lng: string): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.round((then - now) / 1000);
  const format = new Intl.RelativeTimeFormat(lng, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'second');
}

/** A long path keeps its start and its end: `/Users/me/…/Vaults/Cybersec`.
 * shortcut: counts characters, not pixels; measure the row if it reads badly. */
function middle(path: string, max = 52): string {
  if (path.length <= max) return path;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${path.slice(0, max - 1 - tail)}…${path.slice(-tail)}`;
}

/** Recently opened vaults (most recent first). Missing folders (e.g. an
 * unmounted drive) are shown but can't be opened; any entry can be removed. */
export function RecentList() {
  const { t, i18n } = useTranslation();
  const open = useVaultStore((s) => s.open);
  const openScratchpad = useVaultStore((s) => s.openScratchpad);
  const [items, setItems] = useState<RecentVault[] | null>(null);
  const [query, setQuery] = useState('');

  const reload = useCallback(async () => {
    const res = await vaultsRecent();
    setItems(res.ok ? res.value : []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The folder may have gone since the list loaded (an unmounted drive).
  const reveal = async (path: string) => {
    const res = await vaultsReveal(path);
    if (!res.ok) useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
  };

  const forget = async (path: string) => {
    await vaultsForget(path);
    await reload();
  };

  const needle = query.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (it) =>
      !needle ||
      (it.scratchpad ? t('scratchpad.title') : it.name).toLowerCase().includes(needle) ||
      it.path.toLowerCase().includes(needle),
  );
  const now = Date.now();

  return (
    <section className={styles.recent} aria-labelledby="welcome-recent">
      <div className={styles.recentHead}>
        <h2 className={styles.label} id="welcome-recent">
          {t('welcome.recent')}
        </h2>
        {items && items.length >= FILTER_FROM && (
          <label className={styles.filter}>
            <SearchIcon />
            <input
              type="search"
              className="field-control"
              aria-label={t('welcome.filter')}
              placeholder={t('welcome.filter')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
      </div>
      {items && items.length > 0 ? (
        shown.length > 0 ? (
          <ul className={styles.recentList} aria-labelledby="welcome-recent">
            {shown.map((it) => {
              // The global Scratchpad reads as "Quick notes" and opens without
              // a path from the page (M4c §7.16, §7.19).
              const item = it.scratchpad ? { ...it, name: t('scratchpad.title') } : it;
              const when = lastOpened(item.openedAt, now, i18n.resolvedLanguage ?? 'en');
              return (
                <li
                  key={item.path}
                  className={styles.recentItem}
                  data-latest={it === items[0] || undefined}
                >
                  <button
                    type="button"
                    className={styles.recentOpen}
                    disabled={item.missing}
                    title={item.path}
                    onClick={() =>
                      // A failed open may mean the folder is gone: refresh "missing".
                      void (item.scratchpad ? openScratchpad() : open(item.path)).then((res) =>
                        res.ok ? undefined : reload(),
                      )
                    }
                  >
                    <span className={styles.recentIcon} aria-hidden="true">
                      {item.scratchpad ? (
                        <span data-quick-note-icon>
                          <QuickNoteIcon />
                        </span>
                      ) : item.icon ? (
                        <ItemIcon icon={item.icon} />
                      ) : (
                        <FolderIcon />
                      )}
                    </span>
                    <span className={styles.recentText}>
                      <span className={styles.recentTitle}>
                        <span className={styles.recentName}>{item.name}</span>
                        {/* Unrendered in the flex row; read as "Myproject Encrypted". */}
                        {item.encrypted && ' '}
                        {item.encrypted && (
                          <span className="liber-chip">
                            <LockIcon />
                            {t('unlock.encryptedBadge')}
                          </span>
                        )}
                      </span>
                      <span className={styles.recentPath}>{middle(item.path)}</span>
                    </span>
                    <span className={styles.recentMeta}>
                      {item.missing ? (
                        <span className={styles.missing}>{t('welcome.missing')}</span>
                      ) : (
                        when
                      )}
                    </span>
                  </button>
                  <span className={styles.rowActions}>
                    {!item.missing && (
                      <button
                        type="button"
                        className={styles.rowAction}
                        aria-label={t('welcome.reveal', { name: item.name, os: OS })}
                        title={t('welcome.reveal', { name: item.name, os: OS })}
                        onClick={() => void reveal(item.path)}
                      >
                        <FolderIcon />
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.rowAction}
                      aria-label={t('welcome.forget', { name: item.name })}
                      title={t('welcome.forget', { name: item.name })}
                      onClick={() => void forget(item.path)}
                    >
                      <SmallCloseIcon />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.empty}>{t('welcome.noMatch', { query: query.trim() })}</p>
        )
      ) : (
        <p className={styles.empty}>{t('welcome.noRecent')}</p>
      )}
    </section>
  );
}
