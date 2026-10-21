import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { folderKind, pickFolder, type FolderKind } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { CreateEncryptedDialog } from './CreateEncryptedDialog';
import { openEncryptInPlace } from './encryptInPlace';
import styles from './Encryption.module.css';

/** After Continue: E4's encrypted steps, or a question about the folder. */
type Step = 'choose' | 'passphrase' | 'hasNotes' | 'isEncrypted';

/** New vault (UX round §2): where, and plain or encrypted. The folder picker
 *  opens at once; what the folder holds decides what Continue does. */
export function NewVaultDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [path, setPath] = useState<string | null>(null);
  const [kind, setKind] = useState<FolderKind | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [step, setStep] = useState<Step>('choose');
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  const picked = useRef(false);

  const choose = async () => {
    const chosen = await pickFolder().catch(() => null);
    if (!chosen) return; // a cancelled picker keeps what was there
    latest.current = chosen;
    setPath(chosen);
    setKind(null);
    setError(null);
    const res = await folderKind(chosen);
    if (latest.current !== chosen) return; // another folder was chosen meanwhile
    if (!res.ok) setError(errorMessage(res.error));
    else if (res.value === 'damaged') setError(t('errors.damaged'));
    else setKind(res.value);
  };

  useEffect(() => {
    // Once, StrictMode's second run included.
    if (picked.current) return;
    picked.current = true;
    void choose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A question replaces the form (and back): the keyboard goes to its answer.
  useEffect(() => {
    if (step === 'passphrase') return;
    document.querySelector<HTMLElement>('[role="dialog"] [data-autofocus]')?.focus();
  }, [step]);

  const leave = (then: () => unknown) => {
    onClose();
    void then();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!path || !kind) return;
    if (kind === 'encrypted') return setStep('isEncrypted');
    if (encrypted) return setStep(kind === 'plain' ? 'hasNotes' : 'passphrase');
    const vault = useVaultStore.getState();
    // A folder with files is opened as a vault; an empty or new one is created.
    leave(() => (kind === 'plain' ? vault.open(path) : vault.create(path)));
  };

  if (step === 'passphrase' && path) return <CreateEncryptedDialog path={path} onClose={onClose} />;

  const question = (text: string, action: string, run: () => unknown) => (
    <>
      <p className={dialogs.text}>{text}</p>
      <p className={styles.path}>{path}</p>
      <div className={dialogs.buttons}>
        <button type="button" className="btn btn-secondary" onClick={() => setStep('choose')}>
          {t('newVault.back')}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => leave(run)}>
          {action}
        </button>
      </div>
    </>
  );

  return (
    <Dialog title={t('newVault.title')} onClose={onClose}>
      {step === 'hasNotes' && path ? (
        question(t('newVault.hasNotes'), t('newVault.encryptInPlace'), () =>
          openEncryptInPlace(path),
        )
      ) : step === 'isEncrypted' && path ? (
        question(t('newVault.isEncrypted'), t('newVault.openIt'), () =>
          useVaultStore.getState().open(path),
        )
      ) : (
        <form className={styles.form} onSubmit={submit}>
          <div className={dialogs.field} role="group" aria-labelledby={`${id}-where`}>
            <span id={`${id}-where`}>{t('newVault.where')}</span>
            <div className={styles.where}>
              <span className={styles.path} data-empty={path ? undefined : true}>
                {path ?? t('newVault.noFolder')}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                data-autofocus
                aria-describedby={error ? `${id}-error` : undefined}
                onClick={() => void choose()}
              >
                {t('newVault.choose')}
              </button>
            </div>
          </div>
          {error && (
            <p id={`${id}-error`} role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <fieldset className={styles.cards}>
            <legend>{t('newVault.protection')}</legend>
            <label className={styles.card}>
              <input
                type="radio"
                name={`${id}-protection`}
                checked={!encrypted}
                onChange={() => setEncrypted(false)}
              />
              <span className={styles.cardText}>
                <strong>{t('newVault.plain')}</strong>
                {t('newVault.plainHint')}
              </span>
            </label>
            <label className={styles.card}>
              <input
                type="radio"
                name={`${id}-protection`}
                checked={encrypted}
                onChange={() => setEncrypted(true)}
              />
              <span className={styles.cardText}>
                <strong>
                  {t('newVault.encrypted')}{' '}
                  <span className="liber-chip">{t('encryption.beta')}</span>
                </strong>
                {t('newVault.encryptedHint')}
              </span>
            </label>
          </fieldset>
          <div className={dialogs.buttons}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t('dialogs.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!path || !kind}>
              {t('encryption.continue')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
