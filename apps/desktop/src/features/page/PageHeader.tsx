import { useTranslation } from 'react-i18next';
import { FormatIcon } from '../../app/icons';
import type { EditorMode, Page } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { goBack } from '../../stores/navigate';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTrailStore } from '../../stores/trailStore';
import { nameOf } from '../../stores/tree';
import { Breadcrumb } from './Breadcrumb';
import { Cover } from './Cover';
import { ModeToggle } from './ModeToggle';
import { PageSubtitle } from './PageSubtitle';
import { PageTitle } from './PageTitle';
import styles from './PageView.module.css';

/** Breadcrumb, cover, title, subtitle, tags, link counts, the mode toggle and
 *  the save status (M2a §5); cover and subtitle are editable (M2c §2–3). */
export function PageHeader({ page, mode }: { page: Page; mode: EditorMode }) {
  const { t } = useTranslation();
  const status = useEditorStore((s) => s.status);
  const hasDoc = useEditorStore((s) => s.doc !== null);
  const large = useEditorStore((s) => s.large);
  const toolbar = useSettingsStore((s) => s.settings.toolbar);
  const previous = useTrailStore((s) => s.back.at(-1) ?? null);
  const editable = useEditorStore((s) => s.doc !== null && s.path === page.path);
  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <div className={styles.where}>
          {previous && (
            <button
              type="button"
              className={styles.back}
              aria-label={t('trail.back', { name: nameOf(previous.path).replace(/\.md$/i, '') })}
              title={t('trail.back', { name: nameOf(previous.path).replace(/\.md$/i, '') })}
              onClick={() => void goBack()}
            >
              <span aria-hidden="true">←</span>
            </button>
          )}
          <Breadcrumb path={page.path} />
        </div>
        <div className={styles.controls}>
          {hasDoc && (
            <span role="status" aria-label={t('editor.saveStatus')} className={styles.status}>
              {t(`editor.${status}`)}
            </span>
          )}
          {hasDoc && (
            <button
              type="button"
              className={styles.toolbarToggle}
              aria-pressed={toolbar}
              aria-label={t('toolbar.toggle')}
              title={t(toolbar ? 'toolbar.hide' : 'toolbar.show')}
              onClick={() => void useSettingsStore.getState().update({ toolbar: !toolbar })}
            >
              <FormatIcon />
              <span aria-hidden="true">{t('toolbar.short')}</span>
            </button>
          )}
          <ModeToggle mode={mode} />
        </div>
      </div>
      <Cover page={page} editable={editable} />
      <PageTitle page={page} />
      <PageSubtitle page={page} editable={editable} />
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
        <span>{t('page.meta', { links: page.links, backlinks: page.backlinks })}</span>
        {large && mode === 'livePreview' && <span>{t('editor.largeNote')}</span>}
      </p>
    </header>
  );
}
