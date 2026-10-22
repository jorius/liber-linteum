import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { UnsavedChoice } from '../../stores/uiStore';
import { shownName } from '../../stores/tree';
import { useShowExtensions } from '../explorer/TreeRow';
import { Dialog } from './Dialog';
import styles from './Dialogs.module.css';

/** "Save changes to …?" (M5b §6). Closing it any other way — Escape, or
 *  another question taking its place — is Cancel. */
export function UnsavedDialog({
  paths,
  answer,
  onClose,
}: {
  paths: string[];
  answer: (c: UnsavedChoice) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const extensions = useShowExtensions();
  const bodyId = useId();
  const answered = useRef(false);
  const reply = (c: UnsavedChoice) => {
    if (answered.current) return;
    answered.current = true;
    answer(c);
  };
  useEffect(
    () => () => {
      if (!answered.current) {
        answered.current = true;
        answer('cancel');
      }
    },
    [answer],
  );
  const choose = (c: UnsavedChoice) => {
    reply(c);
    onClose();
  };
  const title =
    paths.length === 1
      ? t('dialogs.unsaved.titleOne', { name: shownName(paths[0], extensions) })
      : t('dialogs.unsaved.titleMany', { count: paths.length });
  return (
    <Dialog
      title={title}
      alert
      describedBy={bodyId}
      onClose={() => choose('cancel')}
      onConfirm={() => choose('save')}
    >
      <p id={bodyId} className={styles.text}>
        {t('dialogs.unsaved.body')}
      </p>
      {paths.length > 1 && (
        <ul className={styles.text} aria-label={t('dialogs.unsaved.list')}>
          {paths.map((p) => (
            <li key={p}>{shownName(p, extensions)}</li>
          ))}
        </ul>
      )}
      <div className={styles.buttons}>
        <button type="button" className="btn btn-secondary" onClick={() => choose('discard')}>
          {t('dialogs.unsaved.discard')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => choose('cancel')}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          onClick={() => choose('save')}
        >
          {paths.length === 1 ? t('dialogs.unsaved.save') : t('dialogs.unsaved.saveAll')}
        </button>
      </div>
    </Dialog>
  );
}
