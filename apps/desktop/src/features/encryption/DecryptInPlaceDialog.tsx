import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  destroyWindow,
  onDecryptProgress,
  vaultDecryptCancel,
  vaultDecryptPreflight,
  type DecryptPreflight,
  type EncryptProgressPayload,
} from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { quietly } from '../scratchpad/ScratchpadHost';
import { folderName } from './encryptInPlace';
import styles from './Encryption.module.css';

type Step = 'intro' | 'blocked' | 'secrets' | 'beginning' | 'decrypting' | 'done' | 'failed';

/** Which secret the backend said opens no slot (`decryptWrongSecret`). */
type Wrong = 'passphrase' | 'recovery' | 'both';

/** Decrypt the encrypted vault at `root` in place (encryption UX §10.2):
 *  intro (what it means, the warnings) or the blocked list, the passphrase
 *  AND the recovery key (each checked on its own), progress with Stop and
 *  undo, done. Held from begin until done or an error. Both secrets live
 *  only in this dialog's state and are cleared as soon as begin answers. */
export function DecryptInPlaceDialog({ root, onClose }: { root: string; onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const name = folderName(root);
  const [step, setStep] = useState<Step>('intro');
  const [pre, setPre] = useState<DecryptPreflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState<Wrong | null>(null);
  const [pass, setPass] = useState('');
  const [code, setCode] = useState('');
  const [shown, setShown] = useState(false);
  const [progress, setProgress] = useState<EncryptProgressPayload | null>(null);
  const [stopping, setStopping] = useState(false);
  const [announced, setAnnounced] = useState('');
  /** Where the old keys and ciphertext still are, if cleaning up didn't finish. */
  const [keysLeft, setKeysLeft] = useState<string | null>(null);
  const lastSaid = useRef({ at: 0, share: -1 });
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void vaultDecryptPreflight().then((res) => {
      if (!live) return;
      if (!res.ok) {
        setError(errorMessage(res.error));
        setStep('failed');
      } else {
        setPre(res.value);
        if (res.value.blocked.length) setStep('blocked');
      }
    });
    return () => {
      live = false;
    };
  }, [root]);

  useEffect(() => () => useUiStore.getState().hold(false), []);

  const started = progress !== null;
  const quitAsked = useUiStore((s) => s.quitAsked);
  const beforeQuit = useRef<HTMLElement | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!quitAsked) return;
    beforeQuit.current = document.activeElement as HTMLElement | null;
    keep.current?.focus();
  }, [quitAsked]);
  const keepDecrypting = () => {
    useUiStore.setState({ quitAsked: false });
    const back = beforeQuit.current;
    setTimeout(() =>
      (back?.isConnected
        ? back
        : body.current?.querySelector<HTMLElement>('[data-autofocus]')
      )?.focus(),
    );
  };
  // Each step's content replaces the last: the keyboard goes to its first control.
  useEffect(() => {
    body.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [step, pre, started, wrong]);

  const busy = step === 'beginning' || step === 'decrypting';
  const ready = pass !== '' && code.trim() !== '';
  const passWrong = wrong === 'passphrase' || wrong === 'both';
  const codeWrong = wrong === 'recovery' || wrong === 'both';

  const onProgress = (p: EncryptProgressPayload) => {
    setProgress(p);
    const share = p.total ? p.done / p.total : 1;
    const now = Date.now();
    const said = lastSaid.current;
    if (share - said.share >= 0.1 || now - said.at >= 5000 || p.done === p.total) {
      lastSaid.current = { at: now, share };
      setAnnounced(t('decryptInPlace.announce', { done: p.done, total: p.total }));
    }
  };

  const begin = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || step !== 'secrets') return;
    setError(null);
    setWrong(null);
    setStep('beginning');
    useUiStore.getState().hold(true);
    const res = await useVaultStore.getState().decryptBegin(pass, code);
    if (res?.ok) {
      setPass('');
      setCode('');
      await run();
      return;
    }
    useUiStore.getState().hold(false);
    if (res && res.error.kind === 'decryptWrongSecret') {
      const which = (['passphrase', 'recovery', 'both'] as const).find(
        (w) => w === res.error.message,
      );
      setWrong(which ?? 'both');
      // Only the wrong one is cleared: the user retypes that one.
      if (which !== 'recovery') setPass('');
      if (which !== 'passphrase') setCode('');
      setStep('secrets');
      return;
    }
    setPass('');
    setCode('');
    // `null`: a page couldn't be saved, and a toast says which.
    if (res) setError(errorMessage(res.error));
    // Still open: try again from here; closed meanwhile: nothing to retry.
    setStep(useVaultStore.getState().status === 'open' ? 'secrets' : 'failed');
  };

  const run = async () => {
    lastSaid.current = { at: 0, share: -1 };
    // Listening before the step shows: Stop waits for the first file.
    const stop = await onDecryptProgress(onProgress).catch(() => null);
    setStep('decrypting');
    const res = await useVaultStore.getState().decryptRun();
    if (stop) quietly(stop);
    useUiStore.getState().hold(false);
    if (res.ok) {
      setKeysLeft(res.value.keysLeft ?? null);
      setStep('done');
    } else {
      setError(errorMessage(res.error));
      setStep('failed');
    }
  };

  const count = progress?.total ?? pre?.files ?? 0;
  const closeOnly = (
    <div className={dialogs.buttons}>
      <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
        {t('dialogs.close')}
      </button>
    </div>
  );
  const type = shown ? 'text' : 'password';

  return (
    <Dialog
      title={t('decryptInPlace.title', { name })}
      onClose={() => !busy && onClose()}
      badge={<span className="liber-chip">{t('encryption.beta')}</span>}
    >
      <div ref={body} className={styles.form}>
        {quitAsked && (
          <div role="alert" className={styles.warning}>
            <p>{t('decryptInPlace.quitWhile', { name })}</p>
            <div className={dialogs.buttons}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void destroyWindow()}
              >
                {t('encryptInPlace.quitAnyway')}
              </button>
              <button ref={keep} type="button" className="btn btn-primary" onClick={keepDecrypting}>
                {t('decryptInPlace.keepDecrypting')}
              </button>
            </div>
          </div>
        )}
        {step === 'intro' && (
          <>
            <p className={dialogs.text}>
              {t('decryptInPlace.intro', { name })}{' '}
              {pre ? t('encryptInPlace.files', { count: pre.files }) : t('encryptInPlace.counting')}
            </p>
            <div className={styles.warning}>
              <p>{t('decryptInPlace.warning')}</p>
              <p>{t('decryptInPlace.sync')}</p>
              <p>{t('decryptInPlace.keys')}</p>
              {!!pre?.archives.length && (
                <p>{t('decryptInPlace.archives', { names: pre.archives.join(', ') })}</p>
              )}
            </div>
            <div className={dialogs.buttons}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('dialogs.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-autofocus
                disabled={!pre}
                onClick={() => setStep('secrets')}
              >
                {t('encryption.continue')}
              </button>
            </div>
          </>
        )}
        {step === 'blocked' && pre && (
          <>
            <p className={dialogs.text} id={`${id}-blocked`}>
              {t('decryptInPlace.blocked')}
            </p>
            <ul className={styles.unreadable} aria-labelledby={`${id}-blocked`}>
              {pre.blocked.map((b) => (
                <li key={`${b.reason}:${b.path}`}>
                  <span className={styles.path}>{b.path}</span>
                  <span>{t('decryptInPlace.reason', { reason: b.reason })}</span>
                </li>
              ))}
            </ul>
            <p className={dialogs.text}>{t('decryptInPlace.blockedHint')}</p>
            {closeOnly}
          </>
        )}
        {step === 'secrets' && (
          <form className={styles.form} onSubmit={(e) => void begin(e)}>
            <p className={dialogs.text}>{t('decryptInPlace.secretsIntro')}</p>
            <label className={dialogs.field}>
              {t('encryption.passphrase')}
              <input
                type={type}
                className="field-control"
                autoComplete="off"
                spellCheck={false}
                data-autofocus={codeWrong && !passWrong ? undefined : true}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                aria-invalid={passWrong ? true : undefined}
                aria-describedby={passWrong ? `${id}-pass-error` : undefined}
              />
            </label>
            {passWrong && (
              <p id={`${id}-pass-error`} role="alert" className={styles.error}>
                {t('decryptInPlace.wrongPassphrase')}
              </p>
            )}
            <label className={dialogs.field}>
              {t('unlock.recoveryKey')}
              <input
                type="text"
                className="field-control"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('unlock.recoveryPlaceholder')}
                data-autofocus={codeWrong && !passWrong ? true : undefined}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={codeWrong ? true : undefined}
                aria-describedby={codeWrong ? `${id}-code-error` : undefined}
              />
            </label>
            {codeWrong && (
              <p id={`${id}-code-error`} role="alert" className={styles.error}>
                {t('decryptInPlace.wrongRecovery')}
              </p>
            )}
            <label className={styles.check}>
              <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
              {t('encryption.show')}
            </label>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            <div className={dialogs.buttons}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('dialogs.cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={!ready}>
                {t('decryptInPlace.decrypt')}
              </button>
            </div>
          </form>
        )}
        {step === 'beginning' && (
          <p role="status" className={dialogs.text} tabIndex={-1} data-autofocus>
            {t('decryptInPlace.checking')}
          </p>
        )}
        {step === 'decrypting' && (
          <>
            <progress
              className={styles.progress}
              max={progress?.total || 1}
              value={progress?.done ?? 0}
              aria-label={t('decryptInPlace.progressLabel')}
            />
            <p className={dialogs.text}>
              {t('decryptInPlace.progress', {
                done: progress?.done ?? 0,
                total: progress?.total ?? pre?.files ?? 0,
              })}
            </p>
            <div className={dialogs.buttons}>
              <button
                type="button"
                className="btn btn-secondary"
                data-autofocus
                // Past the last file nothing can be stopped any more (review L9).
                disabled={stopping || !started || (progress?.done ?? 0) >= (progress?.total ?? 1)}
                onClick={() => {
                  setStopping(true);
                  void vaultDecryptCancel();
                }}
              >
                {t('encryptInPlace.stop')}
              </button>
            </div>
            <p role="status" className={dialogs.srOnly}>
              {announced}
            </p>
          </>
        )}
        {step === 'done' && (
          <>
            <p role="status" className={dialogs.text}>
              {keysLeft
                ? t('decryptInPlace.doneLeft', { count, name })
                : t('decryptInPlace.done', { count, name })}
            </p>
            {keysLeft && <p className={styles.path}>{keysLeft}</p>}
            {!!pre?.archives.length && (
              <p className={dialogs.text}>
                {t('decryptInPlace.archives', { names: pre.archives.join(', ') })}
              </p>
            )}
            <div className={dialogs.buttons}>
              <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
                {t('encryptInPlace.open')}
              </button>
            </div>
          </>
        )}
        {step === 'failed' && (
          <>
            <p role="alert" className={styles.error}>
              {error}
            </p>
            {closeOnly}
          </>
        )}
      </div>
    </Dialog>
  );
}
