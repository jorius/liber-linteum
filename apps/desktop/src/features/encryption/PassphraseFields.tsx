import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import dialogs from '../dialogs/Dialogs.module.css';
import styles from './Encryption.module.css';
import { strength } from './strength';

/** A passphrase and its confirmation, hidden unless "Show passphrase" is on
 *  (spec §7). Controlled: the dialog needs both to enable Continue, and clears
 *  them as soon as the vault is created. `error`: a refusal from the backend. */
export function PassphraseFields(props: {
  pass: string;
  confirm: string;
  onPass: (v: string) => void;
  onConfirm: (v: string) => void;
  error?: string | null;
  /** Settings: "New passphrase", and no autofocus (the panel is always mounted). */
  label?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [shown, setShown] = useState(false);
  // Said once the confirmation is left or entered, not from its first character.
  const [checked, setChecked] = useState(false);
  const mismatch = checked && props.confirm !== '' && props.pass !== props.confirm;
  const level = strength(props.pass);
  const type = shown ? 'text' : 'password';
  const common = { type, autoComplete: 'off', spellCheck: false };
  return (
    <>
      <label className={dialogs.field}>
        {props.label ?? t('encryption.passphrase')}
        <input
          {...common}
          className="field-control"
          data-autofocus={props.autoFocus === false ? undefined : true}
          value={props.pass}
          onChange={(e) => props.onPass(e.target.value)}
          aria-describedby={`${id}-hint${props.error ? ` ${id}-error` : ''}`}
          aria-invalid={props.error ? true : undefined}
        />
      </label>
      <p id={`${id}-hint`} className={styles.hint}>
        {props.pass === ''
          ? t('encryption.hint')
          : t('encryption.strength', { level }) + ' ' + t('encryption.hint')}
      </p>
      <label className={dialogs.field}>
        {t('encryption.confirm')}
        <input
          {...common}
          className="field-control"
          value={props.confirm}
          onChange={(e) => props.onConfirm(e.target.value)}
          onBlur={() => setChecked(true)}
          onKeyDown={(e) => e.key === 'Enter' && setChecked(true)}
          aria-describedby={mismatch ? `${id}-mismatch` : undefined}
          aria-invalid={mismatch ? true : undefined}
        />
      </label>
      {mismatch && (
        <p id={`${id}-mismatch`} role="alert" className={styles.error}>
          {t('encryption.mismatch')}
        </p>
      )}
      {props.error && (
        <p id={`${id}-error`} role="alert" className={styles.error}>
          {props.error}
        </p>
      )}
      <label className={styles.check}>
        <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
        {t('encryption.show')}
      </label>
    </>
  );
}
