import { useTranslation } from 'react-i18next';
import { BrandMark, FolderIcon, ImportIcon, LockIcon, PlusIcon, VaultIcon } from '../../app/icons';
import { SUPPORTED_LANGUAGES } from '../../i18n';
import styles from './Welcome.module.css';

export interface WelcomeProps {
  version: string | null;
}

export function Welcome({ version }: WelcomeProps) {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage;

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.header}>
          <BrandMark />
          {version && <span className={styles.version}>{t('app.version', { version })}</span>}
        </div>
        <h1 className={styles.title}>{t('app.name')}</h1>
        <p className={styles.tagline}>{t('app.tagline')}</p>

        <div className={styles.row}>
          <span className={styles.label} id="welcome-language">
            {t('welcome.language')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby="welcome-language">
            {SUPPORTED_LANGUAGES.map((lng) => (
              <button
                key={lng}
                type="button"
                lang={lng}
                aria-pressed={current === lng}
                onClick={() => void i18n.changeLanguage(lng)}
              >
                {t(`languages.${lng}`)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.actions} aria-describedby="welcome-coming-soon">
          <button type="button" className={`${styles.button} ${styles.primary}`} disabled>
            <PlusIcon />
            {t('welcome.create')}
          </button>
          <button type="button" className={styles.button} disabled>
            <FolderIcon />
            {t('welcome.open')}
          </button>
          <button type="button" className={styles.button} disabled>
            <VaultIcon />
            {t('welcome.openObsidian')}
          </button>
          <button type="button" className={styles.button} disabled>
            <ImportIcon />
            {t('welcome.importNotion')}
          </button>
          <p className={styles.note} id="welcome-coming-soon">
            {t('welcome.comingSoon')}
          </p>
        </div>

        <section className={styles.recent} aria-labelledby="welcome-recent">
          <h2 className={styles.label} id="welcome-recent">
            {t('welcome.recent')}
          </h2>
          <p className={styles.empty}>{t('welcome.noRecent')}</p>
        </section>

        <p className={styles.footer}>
          <LockIcon />
          {t('privacy.localOnly')}
        </p>
      </div>
    </main>
  );
}
