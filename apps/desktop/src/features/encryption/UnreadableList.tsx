import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { vaultRevealUnreadable, vaultUnreadable, type UnreadableEntry } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import dialogs from '../dialogs/Dialogs.module.css';
import { revealLabel } from '../preview/ExternalFile';
import styles from './Encryption.module.css';

/** "Couldn't read" (E4): files in an encrypted vault folder whose names
 *  can't be decrypted. Shown only when there are any. */
export function UnreadableList() {
  const { t } = useTranslation();
  const [list, setList] = useState<UnreadableEntry[]>([]);
  useEffect(() => {
    let live = true;
    void vaultUnreadable().then((res) => {
      if (live && res.ok && Array.isArray(res.value)) setList(res.value);
    });
    return () => {
      live = false;
    };
  }, []);
  if (list.length === 0) return null;
  const reveal = async (osPath: string) => {
    const res = await vaultRevealUnreadable(osPath);
    if (!res.ok) useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
  };
  return (
    <div>
      <p className={dialogs.sectionTitle}>{t('encryption.unreadable.title')}</p>
      <p className={dialogs.hint}>{t('encryption.unreadable.hint')}</p>
      <ul className={styles.unreadable}>
        {list.map((e) => (
          <li key={e.osPath}>
            <span>{e.reason}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void reveal(e.osPath)}
            >
              {revealLabel(t)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
