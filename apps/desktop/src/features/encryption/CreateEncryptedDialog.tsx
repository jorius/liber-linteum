import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../stores/messages';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { PassphraseFields } from './PassphraseFields';
import { RecoveryCodeStep } from './RecoveryCodeStep';
import styles from './Encryption.module.css';
import { strength } from './strength';

/** New encrypted vault at `path` (E4): passphrase, creating, recovery code.
 *  The vault is open behind the dialog from the moment it is created, so the
 *  dialog can't be dismissed until the code is confirmed. Neither secret is
 *  kept after its step: the passphrase is cleared when the call returns, the
 *  code goes with the dialog. */
export function CreateEncryptedDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const valid = strength(pass) !== 'tooShort' && pass === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || creating) return;
    setError(null);
    setCreating(true);
    const res = await useVaultStore.getState().createEncrypted(path, pass);
    setCreating(false);
    // Neither outcome keeps the passphrase.
    setPass('');
    setConfirm('');
    if (res.ok) {
      setCode(res.value.recovery);
    } else {
      setError(errorMessage(res.error));
      // The form mounts again: the keyboard returns to the first field.
      setTimeout(() =>
        document.querySelector<HTMLElement>('[role="dialog"] [data-autofocus]')?.focus(),
      );
    }
  };

  const title = code ? t('encryption.recoveryTitle') : t('encryption.createTitle');
  return (
    <Dialog title={title} onClose={() => !code && !creating && onClose()}>
      <span className={styles.beta}>{t('encryption.beta')}</span>
      {code ? (
        <RecoveryCodeStep
          code={code}
          onDone={() => {
            setCode(null);
            onClose();
          }}
        />
      ) : creating ? (
        <p role="status" className={dialogs.text}>
          {t('encryption.creating')}
        </p>
      ) : (
        <form className={styles.form} onSubmit={(e) => void submit(e)}>
          <PassphraseFields
            pass={pass}
            confirm={confirm}
            onPass={setPass}
            onConfirm={setConfirm}
            error={error}
          />
          <div className={dialogs.buttons}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t('dialogs.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!valid}>
              {t('encryption.continue')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
