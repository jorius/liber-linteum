import { useTranslation } from 'react-i18next';
import type { Page } from '../../ipc';
import { stemOf } from './PageTitle';
import styles from './PageView.module.css';

/** The note's own title (first heading or `title:`) when it differs from the
 *  file name (M2b §11.6), shown in the header band (M4b §1). */
export function NoteTitle({ page }: { page: Page }) {
  const { t } = useTranslation();
  if (!page.title || page.title === stemOf(page.path)) return null;
  return <span className={styles.noteTitle}>{t('page.titleInNote', { title: page.title })}</span>;
}
