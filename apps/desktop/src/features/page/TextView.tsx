import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { nameOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { Editor } from '../editor/Editor';
import { onViewUpdate, useCurrentView } from '../editor/viewUpdates';
import { BackArrow } from './BackArrow';
import { Breadcrumb } from './Breadcrumb';
import styles from './PageView.module.css';
import { PageTitle } from './PageTitle';
import { UnwritableNotice } from './UnwritableNotice';
import { COUNT_DEBOUNCE_MS } from './WordCount';

/** Lines and characters of the file in the editor (in place of words). */
export function TextStats() {
  const { t } = useTranslation();
  const view = useCurrentView();
  const [stats, setStats] = useState<{ lines: number; chars: number } | null>(null);
  useEffect(() => {
    if (!view) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const doc = view.state.doc;
      setStats({ lines: doc.lines, chars: doc.length });
    };
    measure();
    const off = onViewUpdate(view, (u) => {
      if (!u) return measure();
      if (!u.docChanged) return;
      clearTimeout(timer);
      timer = setTimeout(measure, COUNT_DEBOUNCE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [view]);
  if (!stats) return null;
  return <span className={`${styles.count} ${styles.pill}`}>{t('count.lines', stats)}</span>;
}

/** A plain-text or code file (M4b part 2 §6): the breadcrumb, Saved and its
 *  line and character counts, then a Source-style editor highlighted by
 *  file type — no cover, tags, related pages, mode switch, toolbar or
 *  outline. A file that isn't eligible text says so and offers its default
 *  app. */
export function TextView({ path }: { path: string }) {
  const { t } = useTranslation();
  const doc = useEditorStore((s) => s.doc);
  const error = useEditorStore((s) => s.error);
  const status = useEditorStore((s) => s.status);
  // Rewritten outside as something it can't edit, with nothing unsaved to
  // keep: as if opened now (final review I3), never the stale text.
  const gone = useEditorStore((s) => s.unwritable === 'disk' && !s.dirty);
  const notText = gone || error?.kind === 'notAText';
  return (
    <section className={styles.page} aria-label={t('page.region')}>
      <div data-band="plain" className={styles.band}>
        <div className={styles.bandRows}>
          <div className={styles.heading}>
            <PageTitle path={path} />
          </div>
          <div className={styles.bar}>
            <div className={`${styles.where} ${styles.pill}`}>
              <BackArrow />
              <Breadcrumb path={path} />
            </div>
            {doc && !notText && (
              <div className={styles.controls}>
                <span
                  role="status"
                  aria-label={t('editor.saveStatus')}
                  data-status={status}
                  className={`${styles.status} ${styles.pill}`}
                >
                  {t(`editor.${status}`)}
                </span>
                <TextStats />
              </div>
            )}
          </div>
        </div>
      </div>
      {error || notText ? (
        <div className={`${styles.orphan}`}>
          <p className={styles.notice}>
            {error && !notText ? errorMessage(error) : t('page.textOnly')}
          </p>
          {notText && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => useUiStore.getState().openDialog({ type: 'openFile', path })}
            >
              {t('page.openDefault')}
            </button>
          )}
        </div>
      ) : (
        doc && (
          <>
            <UnwritableNotice />
            <Editor doc={doc} mode="source" label={nameOf(path)} />
          </>
        )
      )}
    </section>
  );
}
