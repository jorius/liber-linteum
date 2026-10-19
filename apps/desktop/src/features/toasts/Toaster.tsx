import { useTranslation } from 'react-i18next';
import { useToastStore } from '../../stores/toastStore';
import styles from './Toaster.module.css';

/** Bottom-centre notifications. Errors are alerts; the rest are polite status. */
export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const hold = useToastStore((s) => s.hold);
  // The timer waits while the pointer is over a toast or focus is inside it.
  const hovered = (el: HTMLElement) => el.matches(':hover');
  const focused = (el: HTMLElement) => el.contains(document.activeElement);
  return (
    <div className={styles.stack}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={styles.toast}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => hold(toast.id, true)}
          onMouseLeave={(e) => !focused(e.currentTarget) && hold(toast.id, false)}
          onFocus={() => hold(toast.id, true)}
          onBlur={(e) => {
            const el = e.currentTarget;
            if (!el.contains(e.relatedTarget as Node | null) && !hovered(el)) hold(toast.id, false);
          }}
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
          {toast.action && (
            <button
              type="button"
              className={styles.action}
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
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
