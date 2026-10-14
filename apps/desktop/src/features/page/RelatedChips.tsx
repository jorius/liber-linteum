import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Page } from '../../ipc';
import { openPage } from '../../stores/navigate';
import { relate, relationsOf, removeRelation, type Relation } from '../../stores/relations';
import { useToastStore } from '../../stores/toastStore';
import { nameOf } from '../../stores/tree';
import { PickerPopup, type PickerOption } from '../editor/PickerPopup';
import styles from './PageView.module.css';

const pageName = (r: Relation) =>
  r.path ? nameOf(r.path).replace(/\.md$/i, '') : r.target.replace(/^.*\//, '');

/** The page's own relationships (`related:`) as chips in the header band
 *  (M4b §6): a chip opens its page (as a followed link), × removes it, "+ Related page" adds one
 *  through the page picker. Incoming ones show in the Global View. */
export function RelatedChips({ page, editable }: { page: Page; editable: boolean }) {
  const { t } = useTranslation();
  const [relations, setRelations] = useState<Relation[]>([]);
  const [picking, setPicking] = useState(false);
  const add = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    setRelations(await relationsOf(page.path));
  }, [page.path]);
  // Re-read whenever the page is refreshed (a save, a change from outside).
  useEffect(() => {
    let live = true;
    void relationsOf(page.path).then((r) => {
      if (live) setRelations(r);
    });
    return () => {
      live = false;
    };
  }, [page]);

  const anchor = useCallback(() => {
    const r = add.current?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom, left: r.left } : null;
  }, []);
  const close = (refocus: boolean) => {
    setPicking(false);
    if (refocus) add.current?.focus();
  };
  const pick = async (o: PickerOption) => {
    if (o.kind !== 'page') return;
    close(true);
    const res = await relate(page.path, o.page.path);
    if (res.status === 'exists') {
      useToastStore.getState().push({
        message: t('page.alreadyRelated', { name: nameOf(o.page.path).replace(/\.md$/i, '') }),
      });
    }
    await reload();
  };
  const remove = async (r: Relation) => {
    await removeRelation(r);
    await reload();
  };

  if (!relations.length && !editable) return null;
  return (
    <>
      <ul className={styles.related} aria-label={t('page.related')}>
        {relations.map((r) => {
          const name = pageName(r);
          const label = r.directed ? `${name} →` : name;
          return (
            <li
              key={`${r.index}:${r.link}`}
              className={r.path ? styles.relatedChip : `${styles.relatedChip} ${styles.missing}`}
              title={r.path ? undefined : t('page.relatedMissing')}
            >
              {r.path ? (
                <button
                  type="button"
                  className={styles.relatedOpen}
                  title={r.label ?? undefined}
                  // Followed like a link: the back arrow returns here.
                  onClick={() => void openPage(r.path!, null, 'link')}
                >
                  {label}
                </button>
              ) : (
                <span className={styles.relatedOpen}>{label}</span>
              )}
              {editable && (
                <button
                  type="button"
                  className={styles.relatedRemove}
                  aria-label={t('page.removeRelated', { name })}
                  title={t('page.removeRelated', { name })}
                  onClick={() => void remove(r)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {editable && (
        <button
          ref={add}
          type="button"
          className={styles.relatedAdd}
          aria-label={t('page.addRelated')}
          aria-expanded={picking}
          onClick={() => setPicking(true)}
        >
          <span aria-hidden="true">+</span> {t('page.relatedPage')}
        </button>
      )}
      {picking && (
        <PickerPopup
          source={page.path}
          anchor={anchor}
          allowUrl={false}
          label={t('page.relatedPage')}
          placeholder={t('page.relatedPlaceholder')}
          onPick={(o) => void pick(o)}
          onClose={close}
        />
      )}
    </>
  );
}
