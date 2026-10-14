import { useTranslation } from 'react-i18next';
import styles from './GlobalView.module.css';

/** The Global View screen (M3a): the vault as cards, level by level. */
export function GlobalView() {
  const { t } = useTranslation();
  return <section className={styles.view} aria-label={t('gv.region')} />;
}
