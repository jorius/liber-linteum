// A one-time hint above the Split panes (M4 §4, from the prototype): blocks
// in the preview can be dragged. Dismissing it is remembered in this
// browser's storage — a hint seen again after storage is cleared costs
// nothing, so it isn't a setting.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '../../app/icons';
import styles from './BlockGutter.module.css';

export const HINT_KEY = 'nimw.blockHintDismissed';

function dismissed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function SplitHint() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(dismissed);
  if (hidden) return null;
  return (
    <div className={styles.hint}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="9" cy="6" r="1.8" />
        <circle cx="15" cy="6" r="1.8" />
        <circle cx="9" cy="12" r="1.8" />
        <circle cx="15" cy="12" r="1.8" />
        <circle cx="9" cy="18" r="1.8" />
        <circle cx="15" cy="18" r="1.8" />
      </svg>
      <span>{t('editor.blocks.hint')}</span>
      <button
        type="button"
        className={styles.hintClose}
        aria-label={t('editor.blocks.dismissHint')}
        title={t('editor.blocks.dismissHint')}
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(HINT_KEY, '1');
          } catch {
            // Shown again next time; nothing else depends on it.
          }
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
