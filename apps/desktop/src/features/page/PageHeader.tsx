import { useTranslation } from 'react-i18next';
import { FormatIcon, WidthIcon } from '../../app/icons';
import type { EditorMode, Page } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { goBack } from '../../stores/navigate';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePageWidth, usePageWidthStore } from '../../stores/pageWidthStore';
import { useTrailStore } from '../../stores/trailStore';
import { nameOf } from '../../stores/tree';
import { Breadcrumb } from './Breadcrumb';
import { Cover } from './Cover';
import { ModeToggle } from './ModeToggle';
import { NoteTitle } from './NoteTitle';
import { RelatedChips } from './RelatedChips';
import styles from './PageView.module.css';

/** The header band (M4b §1): first row, the back arrow and breadcrumb, then
 *  the save status, Format and the mode switch; second row, tags, link
 *  counts and the note's own title, with the cover's controls at the right.
 *  With a cover the rows sit on it in veiled pills. The title and subtitle
 *  are in the top bar. */
export function PageHeader({ page, mode }: { page: Page; mode: EditorMode }) {
  const { t } = useTranslation();
  const status = useEditorStore((s) => s.status);
  const copying = useEditorStore((s) => s.copying > 0);
  const hasDoc = useEditorStore((s) => s.doc !== null);
  const large = useEditorStore((s) => s.large);
  const toolbar = useSettingsStore((s) => s.settings.toolbar);
  const previous = useTrailStore((s) => s.back[s.back.length - 1] ?? null);
  const editable = useEditorStore((s) => s.doc !== null && s.path === page.path);
  const backName = previous ? nameOf(previous.path).replace(/\.md$/i, '') : '';
  const full = usePageWidth(page.path) === 'full';
  return (
    <Cover page={page} editable={editable}>
      {({ addCover, controls }) => (
        <>
          <div className={styles.bar}>
            <div className={`${styles.where} ${styles.pill}`}>
              {previous && (
                <button
                  type="button"
                  className={styles.back}
                  aria-label={t('trail.back', { name: backName })}
                  title={t('trail.back', { name: backName })}
                  onClick={() => void goBack()}
                >
                  <span aria-hidden="true">←</span>
                </button>
              )}
              <Breadcrumb path={page.path} />
            </div>
            <div className={styles.controls}>
              {addCover}
              {hasDoc && (
                <span
                  role="status"
                  aria-label={t('editor.saveStatus')}
                  className={`${styles.status} ${styles.pill}`}
                >
                  {copying ? t('editor.copying') : t(`editor.${status}`)}
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
              {hasDoc && (
                <button
                  type="button"
                  className={styles.toolbarToggle}
                  aria-pressed={full}
                  aria-label={t('page.fullWidth')}
                  title={t(full ? 'page.fullWidthOff' : 'page.fullWidthOn')}
                  onClick={() => void usePageWidthStore.getState().toggle(page.path)}
                >
                  <WidthIcon />
                </button>
              )}
              <ModeToggle mode={mode} />
            </div>
          </div>
          <div className={styles.bandFoot}>
            <div className={`${styles.facts} ${styles.pill}`}>
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
              <RelatedChips page={page} editable={editable} />
              <NoteTitle page={page} />
            </div>
            {controls}
          </div>
        </>
      )}
    </Cover>
  );
}
