import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { usePageStore } from '../../stores/pageStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { nameOf } from '../../stores/tree';
import { Editor } from '../editor/Editor';
import { isTextPath } from '../../stores/textFiles';
import { PageHeader } from './PageHeader';
import { TextView } from './TextView';
import { UnwritableNotice } from './UnwritableNotice';
import styles from './PageView.module.css';

/** The open page: header and editor (M2a §3, §5). */
export function PageView() {
  const { t } = useTranslation();
  const state = usePageStore((s) => s.state);
  const page = usePageStore((s) => s.page);
  const path = usePageStore((s) => s.path);
  const doc = useEditorStore((s) => s.doc);
  const editorError = useEditorStore((s) => s.error);
  const orphaned = useEditorStore((s) => s.orphaned);
  // Unsaved text its file can no longer take (final review I3): shown with
  // its notice, even though the file now reads as binary.
  const kept = useEditorStore((s) => s.unwritable !== null && s.dirty);
  const mode = useSettingsStore((s) => s.settings.editorMode);

  if (state === 'empty') {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.muted}>{t('page.empty')}</p>
      </section>
    );
  }
  if (state === 'loading') {
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.muted} role="status">
          {t('page.loading')}
        </p>
      </section>
    );
  }
  if (state === 'ready' && path && isTextPath(path)) return <TextView path={path} />;
  // Deleted outside while it had unsaved edits: the text is kept (M2a §3.3).
  const orphanBanner = orphaned && doc && (
    <div className={styles.orphan}>
      <p className={styles.notice}>{t('editor.orphaned')}</p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void useEditorStore.getState().saveAsNew()}
      >
        {t('editor.saveAsNew')}
      </button>
    </div>
  );
  if (state === 'deleted' || !page) {
    if (orphaned && doc) {
      return (
        <section className={styles.page} aria-label={t('page.region')}>
          {orphanBanner}
          <Editor doc={doc} mode={mode} label={nameOf(doc.path)} />
        </section>
      );
    }
    return (
      <section className={styles.center} aria-label={t('page.region')}>
        <p className={styles.notice}>{t('page.deleted')}</p>
      </section>
    );
  }
  const binary = !kept && (page.binary || editorError?.kind === 'binary');
  return (
    <section className={styles.page} aria-label={t('page.region')}>
      <PageHeader page={page} mode={mode} />
      {orphanBanner}
      <UnwritableNotice />
      {binary ? (
        <p className={`${styles.notice} ${styles.inset}`}>{t('page.binary')}</p>
      ) : editorError ? (
        <p className={`${styles.notice} ${styles.inset}`}>{errorMessage(editorError)}</p>
      ) : (
        doc && <Editor doc={doc} mode={mode} label={page.title} />
      )}
    </section>
  );
}
