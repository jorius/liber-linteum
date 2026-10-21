import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { LockIcon } from '../../app/icons';
import { securityResetRollbackMemory, type CommandError } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import styles from './Encryption.module.css';

type Mode = 'passphrase' | 'recovery';
const ERROR_ID = 'unlock-error';

/** The locked vault's door (E4). The secret lives only in the input's DOM
 *  value, never in React state or a store: a wrong secret leaves the text
 *  selected for editing; success or any other outcome empties the field. */
export function UnlockScreen() {
  const { t } = useTranslation();
  const lockedPath = useVaultStore((s) => s.lockedPath);
  const unlocking = useVaultStore((s) => s.unlocking);
  // A recovery code still on screen keeps the keyboard (it outlived a lock).
  const held = useUiStore((s) => s.held);
  const [mode, setMode] = useState<Mode>('passphrase');
  const [error, setError] = useState<{ error: CommandError; mode: Mode } | null>(null);
  const [filesDamaged, setFilesDamaged] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const name = lockedPath?.split(/[\\/]/).filter(Boolean).pop() ?? '';

  const message = (): string | null => {
    if (filesDamaged) return t('unlock.filesDamaged');
    if (!error) return null;
    switch (error.error.kind) {
      case 'wrongSecret':
        // E3 #11: a damaged key file (its MAC) reads as a wrong secret too.
        return `${t(error.mode === 'recovery' ? 'unlock.wrongRecovery' : 'unlock.wrongPassphrase')} ${t('unlock.maybeDamaged')}`;
      case 'rollback':
        return t('unlock.rollback');
      case 'invalidInput':
        return t('unlock.badRecovery');
      default:
        return errorMessage(error.error);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const el = input.current;
    if (!el || unlocking) return;
    setError(null);
    setFilesDamaged(false);
    setResetDone(false);
    // The exact typed text: the backend decides how loosely a code is read.
    const res = await useVaultStore.getState().unlock({ kind: mode, value: el.value });
    if (res.ok) {
      el.value = '';
      return;
    }
    setError({ error: res.error, mode });
    if (res.error.kind === 'wrongSecret') {
      el.focus();
      el.select();
    } else {
      el.value = '';
      el.focus();
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    const res = await securityResetRollbackMemory();
    // The reset link goes either way: the keyboard returns to the field.
    setTimeout(() => input.current?.focus());
    if (res.ok) {
      setError(null);
      setResetDone(true);
    } else if (res.error.kind === 'notPermitted') {
      // The memory was fine: the vault's own files are the problem.
      setFilesDamaged(true);
    } else {
      setError({ error: res.error, mode });
    }
  };

  const switchMode = () => {
    setMode(mode === 'passphrase' ? 'recovery' : 'passphrase');
    setError(null);
    setFilesDamaged(false);
  };

  const shown = message();
  const label = t(mode === 'recovery' ? 'unlock.recoveryKey' : 'unlock.passphrase');
  return (
    <main className={styles.page} data-testid="unlock-screen">
      <form className={styles.card} onSubmit={(e) => void submit(e)}>
        <div className={styles.head}>
          <LockIcon />
          <h1 className={styles.name}>{name}</h1>
          <span className={styles.beta}>{t('unlock.beta')}</span>
        </div>
        <label className={styles.field}>
          {label}
          <input
            key={mode}
            ref={input}
            className="field-control"
            type={mode === 'recovery' ? 'text' : 'password'}
            placeholder={mode === 'recovery' ? t('unlock.recoveryPlaceholder') : undefined}
            autoFocus={!held}
            autoComplete="off"
            spellCheck={false}
            readOnly={unlocking}
            aria-invalid={shown ? true : undefined}
            aria-describedby={shown ? ERROR_ID : undefined}
          />
        </label>
        {shown && (
          <p id={ERROR_ID} role="alert" className={styles.error}>
            {shown}
          </p>
        )}
        {error?.error.kind === 'damaged' && !filesDamaged && (
          <button type="button" className={styles.link} onClick={() => setConfirmReset(true)}>
            {t('unlock.resetLink')}
          </button>
        )}
        {/* One live region, always mounted, so its changes are announced. */}
        <p role="status" className={styles.working}>
          {unlocking ? (
            <>
              <span className={styles.spinner} aria-hidden="true" />
              {t('unlock.working')}
            </>
          ) : resetDone ? (
            t('unlock.resetDone')
          ) : null}
        </p>
        <button type="submit" className="btn btn-primary" disabled={unlocking}>
          {t('unlock.submit')}
        </button>
        <button type="button" className={styles.link} disabled={unlocking} onClick={switchMode}>
          {t(mode === 'recovery' ? 'unlock.usePassphrase' : 'unlock.useRecovery')}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={unlocking}
          onClick={() => useVaultStore.getState().cancelUnlock()}
        >
          {t('unlock.back')}
        </button>
      </form>
      {confirmReset && (
        <Dialog
          alert
          title={t('unlock.resetTitle')}
          describedBy="unlock-reset-body"
          onClose={() => setConfirmReset(false)}
        >
          <p id="unlock-reset-body" className={dialogs.text}>
            {t('unlock.resetBody')}
          </p>
          <div className={dialogs.buttons}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmReset(false)}
            >
              {t('dialogs.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-autofocus
              onClick={() => void reset()}
            >
              {t('unlock.resetConfirm')}
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
