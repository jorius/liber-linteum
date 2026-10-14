import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { indexPickSet } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import styles from '../dialogs/Dialogs.module.css';
import { cardButtonFor, useGvStore } from './gvStore';

/** A list longer than this gets a search field. */
const SEARCH_FROM = 10;
const stem = (path: string) => nameOf(path).replace(/\.md$/i, '');

/** Picks the page a folder's card previews (M3b §4, GV-02 rule 3): one of
 *  the folder's own pages, or none. Saved in `.nimw/vault.json`. A folder
 *  with a single page (`only`) uses it already (rule 4): it starts chosen,
 *  and the dialog says so (final review m14). */
export function IndexPickDialog({
  folder,
  current,
  only,
  onClose,
}: {
  folder: string;
  current: string | null;
  only?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useVaultStore((s) => s.nodes);
  const pages = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'page' && parentOf(n.path) === folder)
        .map((n) => n.path)
        .sort((a, b) => stem(a).localeCompare(stem(b), undefined, { numeric: true })),
    [nodes, folder],
  );
  const [choice, setChoice] = useState<string | null>(current ?? only ?? null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = query.trim()
    ? pages.filter((p) => stem(p).toLowerCase().includes(query.trim().toLowerCase()))
    : pages;

  const save = async () => {
    setBusy(true);
    const res = await indexPickSet(folder, choice);
    setBusy(false);
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
      return;
    }
    onClose();
    if (useGvStore.getState().loaded) void useGvStore.getState().load();
  };

  return (
    <Dialog
      title={t('gv.indexPick.title', { name: nameOf(folder) })}
      onClose={onClose}
      returnFocus={() => cardButtonFor(folder)}
    >
      <p className={styles.text}>{t('gv.indexPick.hint')}</p>
      {only && <p className={styles.text}>{t('gv.indexPick.only', { page: stem(only) })}</p>}
      {pages.length > SEARCH_FROM && (
        <label className={styles.field}>
          <span>{t('gv.indexPick.search')}</span>
          <input
            className={styles.textInput}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <fieldset className={styles.fieldset}>
        <legend>{t('gv.indexPick.legend')}</legend>
        <label className={styles.check}>
          <input
            type="radio"
            name="index-pick"
            checked={choice === null}
            onChange={() => setChoice(null)}
          />
          {t('gv.indexPick.none')}
        </label>
        {shown.map((p) => (
          <label key={p} className={styles.check}>
            <input
              type="radio"
              name="index-pick"
              checked={choice === p}
              onChange={() => setChoice(p)}
            />
            {stem(p)}
          </label>
        ))}
      </fieldset>
      <div className={styles.buttons}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {t('gv.relations.save')}
        </button>
      </div>
    </Dialog>
  );
}
