import { useTranslation } from 'react-i18next';

// M3 replaces this stub with the React Flow canvas (GV-*).
export function GlobalViewScreen() {
  const { t } = useTranslation();
  return (
    <main>
      <h1>{t('screens.global')}</h1>
    </main>
  );
}
