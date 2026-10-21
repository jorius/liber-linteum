import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { securityChangePassphrase, securityNewRecovery, type CommandError } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import styles from './Encryption.module.css';
import { PassphraseFields } from './PassphraseFields';
import { afterCode, RecoveryCodeStep } from './RecoveryCodeStep';
import { strength } from './strength';

const MINUTES = [1, 5, 15, 30, 60];

/** Why a passphrase was refused, in words. */
function problem(t: (k: string) => string, error: CommandError): string {
  if (error.kind === 'wrongSecret') return t('unlock.wrongPassphrase');
  if (error.kind === 'conflict') return t('encryption.security.conflict');
  return errorMessage(error);
}

/** A new recovery key (E4): asks for the passphrase, then shows the code and
 *  checks it was written down. Neither secret outlives its step: the
 *  passphrase is cleared when the call returns, the code goes with the dialog.
 *  From the moment the key is being replaced it holds the screen (uiStore
 *  `held`): nothing dismisses or replaces it, and a lock leaves it up. */
export function NewRecoveryDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const errorId = useId();
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => useUiStore.getState().hold(false), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pass === '' || busy) return;
    setError(null);
    setBusy(true);
    // The old key stops working during this call: from now on the new one must reach the screen.
    useUiStore.getState().hold(true);
    const res = await securityNewRecovery(pass);
    setBusy(false);
    setPass('');
    if (res.ok) setCode(res.value);
    else {
      useUiStore.getState().hold(false);
      setError(problem(t, res.error));
      input.current?.focus();
    }
  };

  return (
    <Dialog
      title={t('encryption.security.newRecoveryTitle')}
      onClose={() => !code && !busy && onClose()}
      returnFocus={afterCode}
    >
      <span className={styles.beta}>{t('encryption.beta')}</span>
      {code ? (
        <RecoveryCodeStep
          code={code}
          onDone={() => {
            setCode(null);
            onDone();
          }}
        />
      ) : (
        <form className={styles.form} onSubmit={(e) => void submit(e)}>
          <p className={dialogs.text}>{t('encryption.security.newRecoveryBody')}</p>
          <label className={dialogs.field}>
            {t('encryption.security.current')}
            <input
              ref={input}
              className="field-control"
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              value={pass}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setPass(e.target.value)}
            />
          </label>
          {error && (
            <p id={errorId} role="alert" className={dialogs.error}>
              {error}
            </p>
          )}
          <div className={dialogs.buttons}>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
              {t('dialogs.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={pass === '' || busy}>
              {t('encryption.continue')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ChangePassphrase() {
  const { t } = useTranslation();
  const errorId = useId();
  const [current, setCurrent] = useState('');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [wrong, setWrong] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const valid = current !== '' && strength(pass) !== 'tooShort' && pass === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setWrong(null);
    setOther(null);
    setBusy(true);
    const res = await securityChangePassphrase(current, pass);
    setBusy(false);
    setCurrent('');
    setPass('');
    setConfirm('');
    if (res.ok) {
      useToastStore.getState().push({ message: t('encryption.security.changed') });
    } else if (res.error.kind === 'wrongSecret') {
      setWrong(problem(t, res.error));
      input.current?.focus();
    } else {
      setOther(problem(t, res.error));
      input.current?.focus();
    }
  };

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)}>
      <p className={dialogs.sectionTitle}>{t('encryption.security.changeTitle')}</p>
      <label className={dialogs.field}>
        {t('encryption.security.current')}
        <input
          ref={input}
          className="field-control"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={current}
          aria-invalid={wrong ? true : undefined}
          aria-describedby={wrong ? errorId : undefined}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      {wrong && (
        <p id={errorId} role="alert" className={dialogs.error}>
          {wrong}
        </p>
      )}
      <PassphraseFields
        pass={pass}
        confirm={confirm}
        onPass={setPass}
        onConfirm={setConfirm}
        error={other}
        label={t('encryption.security.new')}
        autoFocus={false}
      />
      <div className={dialogs.buttons}>
        <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
          {t('encryption.security.change')}
        </button>
      </div>
    </form>
  );
}

/** Settings → Security (E4): auto-lock, and, with an encrypted vault open,
 *  its passphrase and recovery key. Each child is a row for Settings search. */
export function SecuritySettings() {
  const { t } = useTranslation();
  const minutes = useSettingsStore((s) => s.settings.autoLockMinutes);
  const update = useSettingsStore((s) => s.update);
  const encrypted = useVaultStore((s) => s.info?.encrypted === true);
  const choices = MINUTES.includes(minutes ?? 15)
    ? MINUTES
    : [...MINUTES, minutes!].sort((a, b) => a - b);
  return (
    <>
      <label className={dialogs.field}>
        <span>{t('encryption.security.autoLock')}</span>
        <select
          className="field-control"
          value={minutes === null ? 'never' : String(minutes)}
          onChange={(e) =>
            void update({
              autoLockMinutes: e.target.value === 'never' ? null : Number(e.target.value),
            })
          }
        >
          <option value="never">{t('encryption.security.never')}</option>
          {choices.map((m) => (
            <option key={m} value={m}>
              {t('encryption.security.minutes', { count: m })}
            </option>
          ))}
        </select>
      </label>
      <p className={dialogs.hint}>{t('encryption.security.autoLockHint')}</p>
      {encrypted ? (
        <>
          <ChangePassphrase />
          <div className={styles.form}>
            <p className={dialogs.sectionTitle}>{t('encryption.security.newRecoveryTitle')}</p>
            <p className={dialogs.hint}>{t('encryption.security.newRecoveryHint')}</p>
            <div>
              <button
                type="button"
                className="btn btn-secondary"
                // In place of Settings, hosted by the app: the code outlives Settings and a lock.
                onClick={() => useUiStore.getState().openDialog({ type: 'newRecovery' })}
              >
                {t('encryption.security.newRecoveryButton')}
              </button>
            </div>
          </div>
        </>
      ) : (
        <p className={dialogs.hint}>{t('encryption.security.noVault')}</p>
      )}
    </>
  );
}
