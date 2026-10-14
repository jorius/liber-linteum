import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { relationsOf, removeRelation, updateRelation, type Relation } from '../../stores/relations';
import { nameOf } from '../../stores/tree';
import { Dialog } from '../dialogs/Dialog';
import styles from '../dialogs/Dialogs.module.css';
import { useGvStore } from './gvStore';

/** The label limit (M3b §9.6). */
export const LABEL_MAX = 40;

const pageName = (path: string) => nameOf(path).replace(/\.md$/i, '');

/** A page's relationships, or those between two pages (`other`), each with
 *  its label, arrow, Save and Delete (M3b §3). Changes are written to the
 *  relationship's own page; the Global View re-reads its edges. */
export function RelationsDialog({
  page,
  other,
  onClose,
}: {
  page: string;
  other?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Relation[] | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const lists = await Promise.all((other ? [page, other] : [page]).map(relationsOf));
    const all = lists.flat();
    setRows(
      other
        ? all.filter(
            (r) =>
              (r.source === page && r.path === other) || (r.source === other && r.path === page),
          )
        : all,
    );
  }, [page, other]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const changed = async () => {
    await reload();
    if (useGvStore.getState().loaded) void useGvStore.getState().load();
  };

  const title = other
    ? t('gv.relations.between', { a: pageName(page), b: pageName(other) })
    : t('gv.relations.of', { name: pageName(page) });

  return (
    <Dialog title={title} onClose={onClose}>
      <div ref={list}>
        {rows === null ? (
          <p className={styles.text}>{t('gv.relations.loading')}</p>
        ) : rows.length === 0 ? (
          <p className={styles.text}>{t('gv.relations.none')}</p>
        ) : (
          rows.map((r) => (
            <RelationRow
              key={`${r.source}:${r.index}:${r.link}`}
              relation={r}
              onChanged={changed}
              onDeleted={async () => {
                await changed();
                // The row's buttons are gone: keep the keyboard in the dialog.
                list.current
                  ?.closest<HTMLElement>('[role="dialog"]')
                  ?.querySelector<HTMLElement>('input, button')
                  ?.focus();
              }}
            />
          ))
        )}
      </div>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} onClick={onClose}>
          {t('dialogs.close')}
        </button>
      </div>
    </Dialog>
  );
}

function RelationRow({
  relation,
  onChanged,
  onDeleted,
}: {
  relation: Relation;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(relation.label ?? '');
  const [directed, setDirected] = useState(relation.directed);
  const [busy, setBusy] = useState(false);
  const target = relation.path ? pageName(relation.path) : relation.target;
  const dirty = label.trim() !== (relation.label ?? '') || directed !== relation.directed;

  const save = async () => {
    setBusy(true);
    if (await updateRelation(relation, { label: label.trim() || null, directed })) {
      await onChanged();
    }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    if (await removeRelation(relation)) await onDeleted();
    else setBusy(false);
  };

  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('gv.relations.edge', { from: pageName(relation.source), to: target })}</legend>
      <label className={styles.field}>
        <span>{t('gv.relations.label')}</span>
        <input
          className={styles.hexInput}
          type="text"
          maxLength={LABEL_MAX}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) void save();
          }}
        />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={directed} onChange={(e) => setDirected(e.target.checked)} />
        {t('gv.relations.arrow', { to: target })}
      </label>
      <div className={styles.buttons}>
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          disabled={busy}
          onClick={() => void remove()}
        >
          {t('gv.relations.delete')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          {t('gv.relations.save')}
        </button>
      </div>
    </fieldset>
  );
}
