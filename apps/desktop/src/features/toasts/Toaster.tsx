import { useTranslation } from 'react-i18next';
import { useToastStore } from '../../stores/toastStore';
import styles from './Toaster.module.css';

/** Bottom-centre notifications. Errors are alerts; the rest are polite status. */
export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div className={styles.stack}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={styles.toast}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <div className={styles.body}>
            <span>{toast.message}</span>
            {toast.detail && toast.detail.length > 0 && (
              <details className={styles.details}>
                <summary>{t('toasts.details')}</summary>
                <ul>
                  {toast.detail.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <button
            type="button"
            className={styles.dismiss}
            aria-label={t('toasts.dismiss')}
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
