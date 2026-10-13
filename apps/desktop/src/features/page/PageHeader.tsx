import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetUrl, linksResolve, type EditorMode, type Page } from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { Breadcrumb } from './Breadcrumb';
import { ModeToggle } from './ModeToggle';
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
  const cover = useCover(page);
  return (
    <header className={styles.header}>
      <div className={styles.bar}>
        <Breadcrumb path={page.path} />
        <div className={styles.controls}>
          {hasDoc && (
            <span role="status" aria-label={t('editor.saveStatus')} className={styles.status}>
              {t(`editor.${status}`)}
            </span>
          )}
          <ModeToggle mode={mode} />
        </div>
      </div>
      {cover && (
        <img data-cover className={styles.cover} src={assetUrl(cover)} alt="" loading="lazy" />
      )}
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
        <span>{t('page.meta', { links: page.links, backlinks: page.backlinks })}</span>
        {large && mode === 'livePreview' && <span>{t('editor.largeNote')}</span>}
      </p>
    </header>
  );
}
