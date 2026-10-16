import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Page } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import styles from './PageView.module.css';

/** The subtitle, editable in place (M2c §3): frontmatter `subtitle:`. Enter or
 *  a click elsewhere saves, Escape restores, empty removes the key; switching
 *  apps mid-edit saves nothing (as for the title). */
export function PageSubtitle({ page, editable }: { page: Page; editable: boolean }) {
  const { t } = useTranslation();
  const current = page.subtitle ?? '';
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);

  // A subtitle longer than its line ends in an ellipsis; the tooltip has
  // it whole (final review M9).
  if (!editable) {
    return current ? (
      <p className={styles.subtitle} title={current}>
        {current}
      </p>
    ) : null;
  }

  const commit = () => {
    const value = draft.replace(/\s*\n\s*/g, ' ').trim();
    if (value === current.trim()) {
      setDraft(current);
      return;
    }
    void useEditorStore.getState().editFrontmatter({ subtitle: value || null });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(current);
    }
  };
  return (
    <input
      className={styles.subtitleInput}
      aria-label={t('page.subtitleLabel')}
      placeholder={t('page.subtitlePlaceholder')}
      title={draft || undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (document.hasFocus()) commit();
      }}
    />
  );
}
