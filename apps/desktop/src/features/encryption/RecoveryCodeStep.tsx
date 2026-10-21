import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import dialogs from '../dialogs/Dialogs.module.css';
import styles from './Encryption.module.css';

/** Groups are numbered from 1 after `LIBER-` (the format has 14 of 4). */
export const groupsOf = (code: string) => code.split('-').slice(1);

/** The backend's Crockford reading: case, spaces, O as 0, I and L as 1. */
const norm = (s: string) => s.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');

/** Two distinct group numbers, ascending. */
function pickTwo(count: number): [number, number] {
  const a = 1 + Math.floor(Math.random() * count);
  let b = 1 + Math.floor(Math.random() * (count - 1));
  if (b >= a) b += 1;
  return a < b ? [a, b] : [b, a];
}

/** Shows the recovery code once, then asks for two of its groups (so it is
 *  known to be written down). The code lives only in props: the dialog
 *  drops it with `onDone`. */
export function RecoveryCodeStep({ code, onDone }: { code: string; onDone: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [asked] = useState(() => pickTwo(Math.max(groupsOf(code).length, 2)));
  const [typed, setTyped] = useState<[string, string]>(['', '']);
  const groups = groupsOf(code);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false); // the code stays on screen to copy by hand
    }
  };

  if (!confirming) {
    return (
      <>
        <p className={dialogs.text}>{t('encryption.recoveryBody')}</p>
        <code className={styles.code} data-testid="recovery-code">
          {code}
        </code>
        <div className={dialogs.buttons}>
          <button type="button" className="btn btn-secondary" autoFocus onClick={() => void copy()}>
            {t('encryption.copy')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>
            {t('encryption.saved')}
          </button>
        </div>
        <p role="status" className={styles.hint}>
          {copied ? t('encryption.copied') : ''}
        </p>
      </>
    );
  }

  const ok = asked.every((n, i) => norm(typed[i]) === norm(groups[n - 1] ?? ''));
  return (
    <>
      <p className={dialogs.text}>{t('encryption.confirmIntro', { a: asked[0], b: asked[1] })}</p>
      {asked.map((n, i) => (
        <label key={n} className={dialogs.field} htmlFor={`${id}-${n}`}>
          {t('encryption.group', { n })}
          <input
            id={`${id}-${n}`}
            className="field-control"
            autoComplete="off"
            spellCheck={false}
            autoFocus={i === 0}
            value={typed[i]}
            onChange={(e) =>
              setTyped((v) => (i === 0 ? [e.target.value, v[1]] : [v[0], e.target.value]))
            }
          />
        </label>
      ))}
      <div className={dialogs.buttons}>
        <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
          {t('encryption.back')}
        </button>
        <button type="button" className="btn btn-primary" disabled={!ok} onClick={onDone}>
          {t('encryption.done')}
        </button>
      </div>
    </>
  );
}
