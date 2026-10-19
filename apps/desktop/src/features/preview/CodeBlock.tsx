import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { languageName } from '../../markdown/codeHighlight';
import { copyWithFeedback } from '../editor/widgets';
import styles from './Preview.module.css';

/** A fenced code block in the rendered pane (M4b part 2 §2): its language
 *  above the code. */
export function CodeBlock({
  lang,
  code,
  children,
}: {
  lang?: string;
  code: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const label = useRef<HTMLSpanElement>(null);
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{lang ? languageName(lang) : t('code.plain')}</span>
        <button
          type="button"
          className={styles.codeCopy}
          aria-label={t('code.copyCode')}
          onClick={() => label.current && copyWithFeedback(code, label.current)}
        >
          <span ref={label}>{t('code.copy')}</span>
        </button>
      </div>
      {children}
    </div>
  );
}
