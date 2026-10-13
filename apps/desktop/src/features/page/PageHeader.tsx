import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormatIcon } from '../../app/icons';
import { assetUrl, linksResolve, type EditorMode, type Page } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { goBack } from '../../stores/navigate';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTrailStore } from '../../stores/trailStore';
import { nameOf } from '../../stores/tree';
import { Breadcrumb } from './Breadcrumb';
import { ModeToggle } from './ModeToggle';
import { PageTitle } from './PageTitle';
import styles from './PageView.module.css';

/** The cover's vault path (`null`: none, remote or missing). */
function useCover(page: Page): string | null {
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    setCover(null);
    if (!page.cover || /^[a-z][a-z0-9+.-]*:/i.test(page.cover)) return;
    let live = true;
    void linksResolve(page.path, [{ kind: 'cover', target: page.cover }]).then((res) => {
      if (live && res.ok) setCover(res.value[0] ?? null);
    });
    return () => {
      live = false;
    };
  }, [page.path, page.cover]);
  return cover;
}

/** Breadcrumb, cover (read-only), title, subtitle, tags, link counts, the mode
 *  toggle and the save status (M2a §5). */
export function PageHeader({ page, mode }: { page: Page; mode: EditorMode }) {
  const { t } = useTranslation();
  const status = useEditorStore((s) => s.status);
  const hasDoc = useEditorStore((s) => s.doc !== null);
  const large = useEditorStore((s) => s.large);
  const toolbar = useSettingsStore((s) => s.settings.toolbar);
  const previous = useTrailStore((s) => s.back.at(-1) ?? null);
  const cover = useCover(page);
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
      {cover && (
        <img data-cover className={styles.cover} src={assetUrl(cover)} alt="" loading="lazy" />
      )}
      <PageTitle page={page} />
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
        <span>{t('page.meta', { links: page.links, backlinks: page.backlinks })}</span>
        {large && mode === 'livePreview' && <span>{t('editor.largeNote')}</span>}
      </p>
    </header>
  );
}
