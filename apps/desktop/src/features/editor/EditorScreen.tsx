import { useTranslation } from 'react-i18next';

// M2 replaces this stub with the CodeMirror editor (ED-*).
export function EditorScreen() {
  const { t } = useTranslation();
  return (
    <main>
      <h1>{t('screens.edit')}</h1>
    </main>
  );
}
