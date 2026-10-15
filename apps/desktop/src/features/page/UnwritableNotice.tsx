import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../stores/editorStore';
import { isTextPath } from '../../stores/textFiles';
import styles from './PageView.module.css';

/** Unsaved text that can no longer be saved to its file (final review I3):
 *  says why above the editor, which keeps the text. A file rewritten outside
 *  as something the app can't edit is never merged or written over; the text
 *  can be saved as a new file instead. */
export function UnwritableNotice() {
  const { t } = useTranslation();
  const why = useEditorStore((s) => (s.dirty ? s.unwritable : null));
  const path = useEditorStore((s) => s.path);
  if (!why || !path) return null;
  const textFile = isTextPath(path);
  const message =
    why === 'text' ? t('editor.tooLarge') : t(textFile ? 'editor.notText' : 'editor.notTextPage');
  return (
    <div className={styles.orphan}>
      <p className={styles.notice}>{message}</p>
      {why === 'disk' && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void useEditorStore.getState().saveAsNew()}
        >
          {t(textFile ? 'editor.saveAsNewFile' : 'editor.saveAsNew')}
        </button>
      )}
    </div>
  );
}
