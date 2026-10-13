import { useTranslation } from 'react-i18next';
import { usePageStore } from '../../stores/pageStore';
import styles from './PageView.module.css';

/** Read-only page view (EXP-05): header + raw Markdown. CodeMirror arrives in M2. */
export function PageView() {
  const { t } = useTranslation();
  const state = usePageStore((s) => s.state);
  const page = usePageStore((s) => s.page);

  if (state === 'empty') {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.muted}>{t('page.empty')}</p>
      </section>
    );
  }
  if (state === 'loading') {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.muted} role="status">
          {t('page.loading')}
        </p>
      </section>
    );
  }
  if (state === 'deleted' || !page) {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.notice}>{t('page.deleted')}</p>
      </section>
    );
  }
  return (
    <section className={styles.page} aria-label={t('page.region')}>
      <header className={styles.header}>
        <h1 className={styles.title}>{page.title}</h1>
        {page.subtitle && <p className={styles.subtitle}>{page.subtitle}</p>}
        {page.tags.length > 0 && (
          <ul className={styles.tags} aria-label={t('page.tags')}>
            {page.tags.map((tag) => (
              <li key={tag} className={styles.tag}>
                #{tag}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.meta}>
          <span className={styles.path}>{page.path}</span>
          <span>{t('page.meta', { links: page.links, backlinks: page.backlinks })}</span>
        </p>
      </header>
      {page.binary ? (
        <p className={styles.notice}>{t('page.binary')}</p>
      ) : (
        <>
          {page.truncated && <p className={styles.notice}>{t('page.truncated')}</p>}
          <pre className={styles.source} tabIndex={0} aria-label={page.title}>
            {page.text}
          </pre>
        </>
      )}
    </section>
  );
}
