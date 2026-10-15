import type { EditorView } from '@codemirror/view';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { PickedFile } from '../../ipc';
import { attachPaths, fileLinkFor, insertAtCursor } from './attachments';
import styles from './Editor.module.css';
import { placePopup } from './placePopup';

const SHOWN = 3;

/** "Copy or link" for files picked outside the vault (M4b part 3 §7), at the
 *  cursor: Copy into the vault (as a drop does) or Link to where it is
 *  (`file:` URLs). Enter copies, Escape cancels; the keyboard goes back to
 *  the editor either way. */
export function AttachChoice({
  view,
  files,
  onClose,
}: {
  view: EditorView;
  files: PickedFile[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const at = view.coordsAtPos(view.state.selection.main.head);
    if (!at) return;
    const el = box.current;
    const size = { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
    const { top, left } = placePopup(at, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    setPlace((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  }, [view]);
  useLayoutEffect(reposition, [reposition]);
  useEffect(() => {
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  const close = () => {
    onClose();
    view.focus();
  };
  const copy = () => {
    close();
    attachPaths(
      view,
      files.map((f) => f.path),
    );
  };
  const link = () => {
    close();
    insertAtCursor(view, files.map((f) => fileLinkFor(f.name, f.url)).join('\n'));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const more = files.length - SHOWN;
  return (
    <div
      ref={box}
      role="dialog"
      aria-labelledby={titleId}
      className={styles.attachChoice}
      style={place ?? undefined}
      onKeyDown={onKeyDown}
    >
      <p id={titleId} className={styles.attachTitle}>
        {t('editor.attach.title', { count: files.length })}
      </p>
      <ul className={styles.attachFiles}>
        {files.slice(0, SHOWN).map((f) => (
          <li key={f.path} title={f.path}>
            {f.name}
          </li>
        ))}
        {more > 0 && <li>{t('editor.attach.more', { count: more })}</li>}
      </ul>
      <p className={styles.attachExplain}>{t('editor.attach.explain')}</p>
      <div className={styles.attachButtons}>
        <button type="button" className="btn btn-secondary" onClick={close}>
          {t('editor.attach.cancel')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={link}>
          {t('editor.attach.link')}
        </button>
        <button type="button" className="btn btn-primary" autoFocus onClick={copy}>
          {t('editor.attach.copy')}
        </button>
      </div>
    </div>
  );
}
