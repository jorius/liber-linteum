import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backlinkCount } from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { displayName } from '../explorer/TreeRow';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

/** "Move X to Trash?" with the links that will break (spec §4.2). */
export function ConfirmDeleteDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const node = useVaultStore((s) => s.nodes.find((n) => n.path === path));
  const items = useVaultStore((s) => s.nodes.filter((n) => n.path.startsWith(`${path}/`)).length);
  const [links, setLinks] = useState<number | null>(null);
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    void backlinkCount(path).then((res) => setLinks(res.ok ? res.value : 0));
  }, [path]);

  // Its item vanished (deleted or renamed outside the app): close instead of
  // lingering invisibly with global shortcuts disabled (final review, upgraded M3).
  useEffect(() => {
    if (!node) onClose();
  }, [node, onClose]);

  if (!node) return null;
  const confirm = async () => {
    if (dontAsk) await useSettingsStore.getState().update({ confirmDelete: false });
    onClose();
    await useVaultStore.getState().trash(path);
  };

  return (
    <Dialog
      title={t('dialogs.delete.title', { name: displayName(node) })}
      onClose={onClose}
      onConfirm={() => void confirm()}
    >
      {node.kind === 'folder' && (
        <p className={styles.text}>{t('dialogs.delete.items', { count: items })}</p>
      )}
      <p className={styles.text}>
        {links === null ? '…' : t('dialogs.delete.links', { count: links })}
      </p>
      <label className={styles.check}>
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        {t('dialogs.delete.dontAsk')}
      </label>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          data-autofocus
          onClick={() => void confirm()}
        >
          {t('dialogs.delete.confirm')}
        </button>
      </div>
    </Dialog>
  );
}
