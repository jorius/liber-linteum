import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  destroyWindow,
  onEncryptProgress,
  onLockRequest,
  vaultEncryptCancel,
  vaultEncryptUndoElsewhere,
  vaultEncryptPreflight,
  vaultRevealOriginals,
  vaultTrashOriginals,
  type EncryptPreflight,
  type EncryptProgressPayload,
} from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import { revealLabel } from '../preview/ExternalFile';
import { quietly } from '../scratchpad/ScratchpadHost';
import { folderName, useEncryptRecovered } from './encryptInPlace';
import { PassphraseFields } from './PassphraseFields';
import { afterCode, RecoveryCodeStep } from './RecoveryCodeStep';
import styles from './Encryption.module.css';
import { strength } from './strength';

type Step =
  'intro' | 'blocked' | 'passphrase' | 'beginning' | 'key' | 'encrypting' | 'done' | 'failed';

/** Moves the originals the Trash refused (§8.8); `true` once they're gone. */
async function trashOriginals(): Promise<boolean> {
  const res = await vaultTrashOriginals();
  if (!res.ok) {
    useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    return false;
  }
  useVaultStore.setState((s) => ({ info: s.info && { ...s.info, originalsPending: false } }));
  return true;
}

async function revealOriginals() {
  const res = await vaultRevealOriginals();
  if (!res.ok) useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
}

/** Encrypt the plain vault at `root` in place (encryption UX §4.2 with §8):
 *  intro (file count, warnings) or the blocked list, passphrase, the recovery
 *  key typed back BEFORE any file is copied (§8.1), progress with Stop and
 *  undo, done. Held from begin until done or an error: nothing replaces it,
 *  and it outlives a lock or Close. The passphrase is cleared when begin
 *  returns; the code lives only in RecoveryCodeStep until it is confirmed. */
export function EncryptInPlaceDialog({ root, onClose }: { root: string; onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const name = folderName(root);
  const [step, setStep] = useState<Step>('intro');
  const [pre, setPre] = useState<EncryptPreflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [progress, setProgress] = useState<EncryptProgressPayload | null>(null);
  const [stopping, setStopping] = useState(false);
  const [pending, setPending] = useState(false);
  /** The progress read out (M1): every 10 % or 5 s, not every file. */
  const [announced, setAnnounced] = useState('');
  const lastSaid = useRef({ at: 0, share: -1 });
  const body = useRef<HTMLDivElement>(null);

  // Idle, sleep and screen lock still count while the key shows and the
  // files are copied (the shell that listens for them may be gone): the
  // vault locks as soon as it opens (final review I2).
  const converting = step === 'beginning' || step === 'key' || step === 'encrypting';
  useEffect(() => {
    if (!converting) return;
    // A plain vault still open (its pages being saved) has nothing to lock.
    const lock = (reason: 'idle' | 'sleep' | 'screenLock') => {
      const vault = useVaultStore.getState();
      if (vault.status !== 'open' || vault.info?.encrypted) void vault.lock(reason);
    };
    const minutes = useSettingsStore.getState().settings.autoLockMinutes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (minutes != null) timer = setTimeout(() => lock('idle'), minutes * 60_000);
    };
    arm();
    window.addEventListener('keydown', arm);
    window.addEventListener('pointerdown', arm);
    let stopped = false;
    let stop: (() => void) | null = null;
    onLockRequest(lock)
      .then((s) => (stopped ? quietly(s) : (stop = s)))
      .catch(() => undefined);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('keydown', arm);
      window.removeEventListener('pointerdown', arm);
      if (stop) quietly(stop);
    };
  }, [converting]);

  useEffect(() => {
    let live = true;
    void vaultEncryptPreflight(root).then((res) => {
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

  // Each step's content replaces the last: the keyboard goes to its first control.
  const started = progress !== null;
  const quitAsked = useUiStore((s) => s.quitAsked);
  /** What had the keyboard when the quit question took it. */
  const beforeQuit = useRef<HTMLElement | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!quitAsked) return;
    beforeQuit.current = document.activeElement as HTMLElement | null;
    keep.current?.focus();
  }, [quitAsked]);
  const keepEncrypting = () => {
    useUiStore.setState({ quitAsked: false });
    const back = beforeQuit.current;
    setTimeout(() =>
      (back?.isConnected
        ? back
        : body.current?.querySelector<HTMLElement>('[data-autofocus]')
      )?.focus(),
    );
  };
  useEffect(() => {
    body.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [step, pre, started]);

  const busy = step === 'beginning' || step === 'key' || step === 'encrypting';
  const valid = strength(pass) !== 'tooShort' && pass === confirm;

  const begin = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || step !== 'passphrase') return;
    setError(null);
    setStep('beginning');
    useUiStore.getState().hold(true);
    const res = await useVaultStore.getState().encryptBegin(root, pass, !!pre?.closesOpen);
    // No outcome keeps the passphrase.
    setPass('');
    setConfirm('');
    if (res?.ok) {
      setCode(res.value.recovery);
      setStep('key');
      return;
    }
    useUiStore.getState().hold(false);
    // `null`: a page couldn't be saved, and a toast says which.
    if (res) setError(errorMessage(res.error));
    setStep('passphrase');
  };

  const onProgress = (p: EncryptProgressPayload) => {
    setProgress(p);
    const share = p.total ? p.done / p.total : 1;
    const now = Date.now();
    const said = lastSaid.current;
    if (share - said.share >= 0.1 || now - said.at >= 5000 || p.done === p.total) {
      lastSaid.current = { at: now, share };
      setAnnounced(t('encryptInPlace.announce', { done: p.done, total: p.total }));
    }
  };

  const run = async () => {
    // Listening before the step shows (M3): Stop waits for the first file.
    const stop = await onEncryptProgress(onProgress).catch(() => null);
    setCode(null);
    setStep('encrypting');
    const res = await useVaultStore.getState().encryptRun();
    if (stop) quietly(stop);
    useUiStore.getState().hold(false);
    if (res.ok) {
      setPending(!!res.value.originalsPending);
      setStep('done');
    } else {
      setError(errorMessage(res.error));
      setStep('failed');
    }
  };

  /** Cancel at the recovery-key step: the begin undone before any copy. */
  const cancel = async () => {
    setCode(null);
    setStep('beginning');
    const res = await useVaultStore.getState().encryptCancel();
    useUiStore.getState().hold(false);
    setError(res.ok ? t('errors.cancelled') : errorMessage(res.error));
    setStep('failed');
  };

  const count = progress?.total ?? pre?.files ?? 0;
  const closeOnly = (
    <div className={dialogs.buttons}>
      <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
        {t('dialogs.close')}
      </button>
    </div>
  );

  return (
    <Dialog
      title={t('encryptInPlace.title', { name })}
      onClose={() => !busy && onClose()}
      returnFocus={afterCode}
      badge={<span className="liber-chip">{t('encryption.beta')}</span>}
    >
      <div ref={body} className={styles.form}>
        {quitAsked && (
          <div role="alert" className={styles.warning}>
            <p>{t('encryptInPlace.quitWhile', { name })}</p>
            <div className={dialogs.buttons}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void destroyWindow()}
              >
                {t('encryptInPlace.quitAnyway')}
              </button>
              <button ref={keep} type="button" className="btn btn-primary" onClick={keepEncrypting}>
                {t('encryptInPlace.keepEncrypting')}
              </button>
            </div>
          </div>
        )}
        {step === 'intro' && (
          <>
            <p className={dialogs.text}>
              {t('encryptInPlace.intro')}{' '}
              {pre ? t('encryptInPlace.files', { count: pre.files }) : t('encryptInPlace.counting')}
            </p>
            <div className={styles.warning}>
              <p>{t('encryptInPlace.warning')}</p>
              <p>{t('encryptInPlace.pauseSync')}</p>
              <p>{t('encryptInPlace.syncthing')}</p>
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
                onClick={() => setStep('passphrase')}
              >
                {t('encryptInPlace.choosePassphrase')}
              </button>
            </div>
          </>
        )}
        {step === 'blocked' && pre && (
          <>
            <p className={dialogs.text} id={`${id}-blocked`}>
              {t('encryptInPlace.blocked')}
            </p>
            <ul className={styles.unreadable} aria-labelledby={`${id}-blocked`}>
              {pre.blocked.map((b) => (
                <li key={b.path}>
                  <span className={styles.path}>{b.path}</span>
                  <span>{t('encryptInPlace.reason', { reason: b.reason })}</span>
                </li>
              ))}
            </ul>
            <p className={dialogs.text}>{t('encryptInPlace.blockedHint')}</p>
            {closeOnly}
          </>
        )}
        {step === 'passphrase' && (
          <form className={styles.form} onSubmit={(e) => void begin(e)}>
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
        {step === 'beginning' && (
          <p role="status" className={dialogs.text} tabIndex={-1} data-autofocus>
            {t('encryption.creating')}
          </p>
        )}
        {step === 'key' && code && (
          <RecoveryCodeStep code={code} onDone={() => void run()} onCancel={() => void cancel()} />
        )}
        {step === 'encrypting' && (
          <>
            <progress
              className={styles.progress}
              max={progress?.total || 1}
              value={progress?.done ?? 0}
              aria-label={t('encryptInPlace.progressLabel')}
            />
            <p className={dialogs.text}>
              {t('encryptInPlace.progress', {
                done: progress?.done ?? 0,
                total: progress?.total ?? pre?.files ?? 0,
              })}
            </p>
            <div className={dialogs.buttons}>
              <button
                type="button"
                className="btn btn-secondary"
                data-autofocus
                disabled={stopping || !started}
                onClick={() => {
                  setStopping(true);
                  void vaultEncryptCancel();
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
              {t(pending ? 'encryptInPlace.donePending' : 'encryptInPlace.done', { count, name })}
            </p>
            <div className={dialogs.buttons}>
              {pending && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void revealOriginals()}
                  >
                    {revealLabel(t)}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void trashOriginals().then((gone) => gone && setPending(false))}
                  >
                    {t('encryptInPlace.moveToTrash')}
                  </button>
                </>
              )}
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

/** Another device's conversion of `path`, still copying: undone here once
 *  confirmed (spec §8.11), then the folder opens. */
function UndoElsewhereDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const undo = async () => {
    setWorking(true);
    const res = await vaultEncryptUndoElsewhere(path);
    setWorking(false);
    if (!res.ok) return setError(errorMessage(res.error));
    onClose();
    await useVaultStore.getState().open(path);
  };
  return (
    <Dialog title={t('encryptInPlace.undoTitle')} onClose={onClose} alert describedBy={id}>
      <p id={id} className={dialogs.text}>
        {t('encryptInPlace.undoBody')}
      </p>
      <p className={styles.path}>{path}</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={dialogs.buttons}>
        <button type="button" className="btn btn-secondary" data-autofocus onClick={onClose}>
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={working}
          onClick={() => void undo()}
        >
          {t('encryptInPlace.undoConfirm')}
        </button>
      </div>
    </Dialog>
  );
}

/** The dialogs on every screen (a lock or Close leaves the encrypt dialog
 *  up), and the toasts for a conversion an open recovered. */
export function EncryptInPlaceHost() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);
  useEncryptRecovered();
  if (dialog?.type === 'undoElsewhere')
    return <UndoElsewhereDialog path={dialog.path} onClose={close} />;
  if (dialog?.type !== 'encryptInPlace') return null;
  return <EncryptInPlaceDialog key={dialog.root} root={dialog.root} onClose={close} />;
}

/** Roots whose banner was dismissed: back on the next app start. */
const dismissed = new Set<string>();

/** §8.8: the readable originals are still in the open vault's folder. */
export function OriginalsBanner() {
  const { t } = useTranslation();
  const root = useVaultStore((s) => (s.info?.originalsPending ? s.info.root : null));
  const [, rerender] = useState(0);
  if (!root || dismissed.has(root)) return null;
  return (
    <div className={styles.banner} data-banner="originals">
      <p role="status">{t('encryptInPlace.banner')}</p>
      <div className={styles.bannerActions}>
        <button type="button" className="btn btn-secondary" onClick={() => void revealOriginals()}>
          {revealLabel(t)}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void trashOriginals()}>
          {t('encryptInPlace.moveToTrash')}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            dismissed.add(root);
            rerender((n) => n + 1);
          }}
        >
          {t('toasts.dismiss')}
        </button>
      </div>
    </div>
  );
}
