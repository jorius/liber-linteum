import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { languageName } from '../../markdown/codeHighlight';
import styles from './Preview.module.css';

/** A fenced code block in the rendered pane (M4b part 2 §2): its language
 *  above the code. */
export function CodeBlock({ lang, children }: { lang?: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang ? languageName(lang) : t('code.plain')}</span>
      </div>
      {children}
    </div>
  );
}
