import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../stores/vaultStore';
import { dropEntry, planDrop } from '../explorer/drop';
import { displayName } from '../explorer/TreeRow';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

/** Keyboard-friendly alternative to drag-and-drop (spec §3.4). */
export function MoveToDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const nodes = useVaultStore((s) => s.nodes);
  const node = nodes.find((n) => n.path === path);
  const targets = ['', ...nodes.filter((n) => n.kind === 'folder').map((n) => n.path)].filter(
    (target) => planDrop(path, target) !== null,
  );
  const [target, setTarget] = useState(targets[0] ?? '');

  // Its item vanished (deleted or renamed outside the app): close instead of
  // lingering invisibly with global shortcuts disabled (final review, upgraded M3).
  useEffect(() => {
    if (!node) onClose();
  }, [node, onClose]);

  if (!node) return null;
  const move = async () => {
    onClose();
    await dropEntry(path, target);
  };

  return (
    <Dialog title={t('dialogs.move.title', { name: displayName(node) })} onClose={onClose}>
      <label className={styles.field}>
        <span>{t('dialogs.move.to')}</span>
        <select
          className={styles.select}
          size={Math.min(10, Math.max(2, targets.length))}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void move();
          }}
        >
          {targets.map((p) => (
            <option key={p || 'root'} value={p}>
              {p || t('dialogs.move.root')}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={targets.length === 0}
          onClick={() => void move()}
        >
          {t('dialogs.move.confirm')}
        </button>
      </div>
    </Dialog>
  );
}
