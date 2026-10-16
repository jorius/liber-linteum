import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BinItem } from '../../ipc';
import { nameOf, parentOf } from '../../stores/tree';
import { Dialog } from '../dialogs/Dialog';
import dialogStyles from '../dialogs/Dialogs.module.css';
import { requestTrash } from '../explorer/trashAction';
import { deleteItems, emptyTrash, restoreItem } from './binActions';
import { useBinStore } from './binStore';
import styles from './Bin.module.css';

type Ask = { type: 'delete'; items: BinItem[] } | { type: 'empty' };

/** A page's name without `.md`; a folder's or attachment's as is. */
export const binLabel = (path: string) => nameOf(path).replace(/\.md$/i, '');
const label = (item: BinItem) => (item.folder ? nameOf(item.path) : binLabel(item.path));

/** The Trash or the Archive, in place of the editor (M5b §5.2, §5.3). */
export function BinView({ kind }: { kind: 'trash' | 'archive' }) {
  const { t, i18n } = useTranslation();
  const items = useBinStore((s) => s[kind]);
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    void useBinStore.getState().refresh();
  }, [kind]);

  const when = (at: number | null) =>
    at === null
      ? null
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
          at,
        );
  const title = t(kind === 'trash' ? 'bin.trash' : 'bin.archived');

  return (
    <section className={styles.view} aria-labelledby="bin-title">
      <header className={styles.head}>
        <h1 id="bin-title" className={styles.title}>
          {title}
        </h1>
        {kind === 'trash' && items.length > 0 && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setAsk({ type: 'empty' })}
          >
            {t('bin.empty')}
          </button>
        )}
      </header>
      <p className={styles.note}>{t(kind === 'trash' ? 'bin.trashNote' : 'bin.archiveNote')}</p>
      {items.length === 0 ? (
        <p className={styles.note}>{t(kind === 'trash' ? 'bin.trashEmpty' : 'bin.archiveEmpty')}</p>
      ) : (
        <ul className={styles.list} aria-label={title}>
          {items.map((item) => {
            const name = label(item);
            const from = item.from === null ? null : parentOf(item.from) || t('bin.root');
            return (
              <li key={item.path} className={styles.item}>
                <span className={styles.name}>
                  {name}
                  {item.folder && <span className={styles.meta}>{t('bin.folder')}</span>}
                </span>
                <span className={styles.meta}>
                  {from === null ? t('bin.unknownFrom') : t('bin.from', { folder: from })}
                  {item.at !== null && ` · ${when(item.at)}`}
                </span>
                <span className={styles.actions}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label={t(kind === 'trash' ? 'bin.restoreName' : 'bin.unarchiveName', {
                      name,
                    })}
                    onClick={() => void restoreItem(kind, item.path)}
                  >
                    {t(kind === 'trash' ? 'bin.restore' : 'bin.unarchive')}
                  </button>
                  {kind === 'trash' ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-label={t('bin.deleteName', { name })}
                      onClick={() => setAsk({ type: 'delete', items: [item] })}
                    >
                      {t('bin.delete')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-label={t('bin.toTrashName', { name })}
                      onClick={() => requestTrash(item.path)}
                    >
                      {t('bin.toTrash')}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {ask && <Confirm ask={ask} count={items.length} onClose={() => setAsk(null)} />}
    </section>
  );
}

function Confirm({ ask, count, onClose }: { ask: Ask; count: number; onClose: () => void }) {
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
    void run();
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
