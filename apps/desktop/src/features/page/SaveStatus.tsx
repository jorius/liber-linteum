import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../stores/editorStore';
import styles from './PageView.module.css';

/** The save-status pill, shared by the page header, text view, single-file
 *  window and Focus mode's strip. */
export function SaveStatus({ className }: { className?: string }) {
  const { t } = useTranslation();
  const status = useEditorStore((s) => s.status);
  const copying = useEditorStore((s) => s.copying > 0);
  return (
    <span
      role="status"
      aria-label={t('editor.saveStatus')}
      data-status={status}
      className={[styles.status, styles.pill, className].filter(Boolean).join(' ')}
    >
      {copying ? t('editor.copying') : t(`editor.${status}`)}
    </span>
  );
}
