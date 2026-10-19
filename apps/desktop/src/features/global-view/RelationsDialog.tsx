import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RelatedChange } from '../../markdown/related';
import { relationsOf, removeRelation, updateRelation, type Relation } from '../../stores/relations';
import { nameOf } from '../../stores/tree';
import { Dialog } from '../dialogs/Dialog';
import styles from '../dialogs/Dialogs.module.css';
import { cardButtonFor, useGvStore } from './gvStore';

/** The label limit (M3b §9.6). */
export const LABEL_MAX = 40;

const pageName = (path: string) => nameOf(path).replace(/\.md$/i, '');

/** A row's label and arrow, changed and not saved yet. */
interface Draft {
  relation: Relation;
  change: RelatedChange;
}

/** A page's relationships, or those between two pages (`other`), each with
 *  its label, arrow, Save and Delete (M3b §3). Changes are written to the
 *  relationship's own page; the Global View re-reads its edges. Close saves
 *  the changes not saved yet; Escape discards them, as the dialog says
 *  (final review m13). */
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
  const [closing, setClosing] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  /** Each row's changes not saved yet, by row key. */
  const drafts = useRef(new Map<string, Draft>());
  const setDraft = useCallback((key: string, draft: Draft | null) => {
    if (draft) drafts.current.set(key, draft);
    else drafts.current.delete(key);
  }, []);

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

  // A re-read (after a delete, or an edit refused because the list moved)
  // can take away the row the keyboard was on: it stays in the dialog.
  useLayoutEffect(() => {
    const dialog = list.current?.closest<HTMLElement>('[role="dialog"]');
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>('input, button')?.focus();
    }
  }, [rows]);

  const changed = async () => {
    await reload();
    if (useGvStore.getState().loaded) void useGvStore.getState().load();
  };

  /** Close: the changes not saved yet are saved first. One refused (the
   *  list moved, the page changed on disk) keeps the dialog open on the list
   *  as it is now, so nothing is lost without a word. */
  const close = async () => {
    const pending = [...drafts.current.values()];
    if (pending.length === 0) return onClose();
    setClosing(true);
    let saved = true;
    for (const d of pending) saved = (await updateRelation(d.relation, d.change)) && saved;
    if (saved) {
      if (useGvStore.getState().loaded) void useGvStore.getState().load();
      onClose();
      return;
    }
    await changed();
    setClosing(false);
  };

  const title = other
    ? t('gv.relations.between', { a: pageName(page), b: pageName(other) })
    : t('gv.relations.of', { name: pageName(page) });

  return (
    <Dialog title={title} onClose={onClose} returnFocus={() => cardButtonFor(page)}>
      <div ref={list}>
        {rows === null ? (
          <p className={styles.text}>{t('gv.relations.loading')}</p>
        ) : rows.length === 0 ? (
          <p className={styles.text}>{t('gv.relations.none')}</p>
        ) : (
          rows.map((r) => {
            const key = `${r.source}:${r.index}:${r.link}`;
            return (
              <RelationRow
                key={key}
                draftKey={key}
                relation={r}
                onChanged={changed}
                onDraft={setDraft}
              />
            );
          })
        )}
      </div>
      {rows !== null && rows.length > 0 && (
        <p className={styles.hint}>{t('gv.relations.closeHint')}</p>
      )}
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.button}
          disabled={closing}
          onClick={() => void close()}
        >
          {t('dialogs.close')}
        </button>
      </div>
    </Dialog>
  );
}

function RelationRow({
  draftKey,
  relation,
  onChanged,
  onDraft,
}: {
  draftKey: string;
  relation: Relation;
  onChanged: () => Promise<void>;
  onDraft: (key: string, draft: Draft | null) => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(relation.label ?? '');
  const [directed, setDirected] = useState(relation.directed);
  const [busy, setBusy] = useState(false);
  const target = relation.path ? pageName(relation.path) : relation.target;
  const dirty = label.trim() !== (relation.label ?? '') || directed !== relation.directed;

  // The dialog's Close saves what's changed here and not saved yet.
  useEffect(() => {
    onDraft(
      draftKey,
      dirty ? { relation, change: { label: label.trim() || null, directed } } : null,
    );
  }, [draftKey, dirty, relation, label, directed, onDraft]);
  useEffect(() => () => onDraft(draftKey, null), [draftKey, onDraft]);

  // Re-read whether or not the change went through: one refused because the
  // list moved shows the list as it is now (§10.7, final review m5).
  const save = async () => {
    setBusy(true);
    await updateRelation(relation, { label: label.trim() || null, directed });
    await onChanged();
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    await removeRelation(relation);
    await onChanged();
    setBusy(false);
  };

  return (
    <fieldset className={styles.fieldset}>
      <legend>{t('gv.relations.edge', { from: pageName(relation.source), to: target })}</legend>
      <label className={styles.field}>
        <span>{t('gv.relations.label')}</span>
        <input
          className={styles.textInput}
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
