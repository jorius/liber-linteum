import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  destroyWindow,
  onEncryptProgress,
  onLockRequest,
  vaultEncryptCancel,
  vaultEncryptPickBackup,
  vaultEncryptUndoElsewhere,
  vaultEncryptPreflight,
  vaultRevealBackup,
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
import { DecryptInPlaceDialog } from './DecryptInPlaceDialog';
import { useDecryptRecovered } from './decryptInPlace';
import { folderName, useEncryptRecovered } from './encryptInPlace';
import { PassphraseFields } from './PassphraseFields';
import { afterCode, RecoveryCodeStep } from './RecoveryCodeStep';
import styles from './Encryption.module.css';
import { strength } from './strength';

type Step =
  | 'intro'
  | 'blocked'
  | 'backup'
  | 'passphrase'
  | 'beginning'
  | 'backingUp'
  | 'key'
  | 'encrypting'
  | 'done'
  | 'failed';

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

async function revealBackup() {
  const res = await vaultRevealBackup();
  if (!res.ok) useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
}

/** Encrypt the plain vault at `root` in place (encryption UX §4.2 with §8):
 *  intro (file count, warnings) or the blocked list, whether to keep a
 *  readable copy (§9), passphrase, the copy written and checked, the
 *  recovery key typed back BEFORE any file is encrypted (§8.1), progress
 *  with Stop and undo, done. Held from begin until done or an error: nothing
 *  replaces it, and it outlives a lock or Close. The passphrase is cleared
 *  when begin returns; the code lives only in this dialog until confirmed. */
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
  /** §9: keep a readable copy (`keep`), or not (`skip`); no default. */
  const [copy, setCopy] = useState<'keep' | 'skip' | null>(null);
  /** The folder Rust picked and checked for the copy. */
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** The copy was made: the done screen says where. */
  const [backedUp, setBackedUp] = useState(false);

  // Idle, sleep and screen lock still count while the key shows and the
  // files are copied (the shell that listens for them may be gone): the
  // vault locks as soon as it opens (final review I2).
  const converting =
    step === 'beginning' || step === 'backingUp' || step === 'key' || step === 'encrypting';
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

  const busy = converting;
  const valid = strength(pass) !== 'tooShort' && pass === confirm;
  const backupChosen = copy === 'skip' || (copy === 'keep' && !!backupPath);

  /** Choose… on the backup step: Rust's folder dialog, then its checks. */
  const pickBackup = async () => {
    setPicking(true);
    const res = await vaultEncryptPickBackup(root);
    setPicking(false);
    if (!res.ok) {
      setBackupPath(null);
      setBackupError(errorMessage(res.error));
    } else if (res.value) {
      setBackupPath(res.value);
      setBackupError(null);
    }
  };

  const begin = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || step !== 'passphrase') return;
    setError(null);
    setStep('beginning');
    useUiStore.getState().hold(true);
    const withCopy = copy === 'keep';
    const res = await useVaultStore
      .getState()
      .encryptBegin(root, pass, !!pre?.closesOpen, withCopy);
    // No outcome keeps the passphrase.
    setPass('');
    setConfirm('');
    if (res?.ok) {
      setCode(res.value.recovery);
      if (withCopy) await backup();
      else setStep('key');
      return;
    }
    useUiStore.getState().hold(false);
    // `null`: a page couldn't be saved, and a toast says which.
    if (res) setError(errorMessage(res.error));
    setStep('passphrase');
  };

  /** §9.1: the readable copy, written and checked before the key shows. */
  const backup = async () => {
    const stop = await onEncryptProgress(onProgress('encryptInPlace.backupAnnounce')).catch(
      () => null,
    );
    setStep('backingUp');
    const res = await useVaultStore.getState().encryptBackup();
    if (stop) quietly(stop);
    setProgress(null);
    setStopping(false);
    if (res.ok) {
      setBackedUp(true);
      setStep('key');
      return;
    }
    setCode(null);
    useUiStore.getState().hold(false);
    setError(errorMessage(res.error));
    setStep('failed');
  };

  /** Progress, read out with `key` (the backup's or the encryption's). */
  const onProgress = (key: string) => (p: EncryptProgressPayload) => {
    setProgress(p);
    const share = p.total ? p.done / p.total : 1;
    const now = Date.now();
    const said = lastSaid.current;
    if (share - said.share >= 0.1 || now - said.at >= 5000 || p.done === p.total) {
      lastSaid.current = { at: now, share };
      setAnnounced(t(key, { done: p.done, total: p.total }));
    }
  };

  const run = async () => {
    lastSaid.current = { at: 0, share: -1 };
    // Listening before the step shows (M3): Stop waits for the first file.
    const stop = await onEncryptProgress(onProgress('encryptInPlace.announce')).catch(() => null);
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
                onClick={() => setStep('backup')}
              >
                {t('encryption.continue')}
              </button>
            </div>
          </>
        )}
        {step === 'backup' && (
          <>
            <fieldset className={styles.cards}>
              <legend>{t('encryptInPlace.backupQuestion')}</legend>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name={`${id}-backup`}
                  checked={copy === 'keep'}
                  onChange={() => setCopy('keep')}
                  aria-labelledby={`${id}-keep`}
                  aria-describedby={`${id}-keep-hint`}
                  data-autofocus
                />
                <span className={styles.cardText}>
                  <strong id={`${id}-keep`}>{t('encryptInPlace.backupKeep')}</strong>
                  <span id={`${id}-keep-hint`}>{t('encryptInPlace.backupKeepHint')}</span>
                </span>
              </label>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name={`${id}-backup`}
                  checked={copy === 'skip'}
                  onChange={() => setCopy('skip')}
                  aria-labelledby={`${id}-skip`}
                  aria-describedby={`${id}-skip-hint`}
                />
                <span className={styles.cardText}>
                  <strong id={`${id}-skip`}>{t('encryptInPlace.backupSkip')}</strong>
                  <span id={`${id}-skip-hint`}>{t('encryptInPlace.backupSkipHint', { name })}</span>
                </span>
              </label>
            </fieldset>
            {copy === 'keep' && (
              <>
                <div className={dialogs.field} role="group" aria-labelledby={`${id}-folder`}>
                  <span id={`${id}-folder`}>{t('encryptInPlace.backupFolder')}</span>
                  <div className={styles.where}>
                    <span className={styles.path} data-empty={backupPath ? undefined : true}>
                      {backupPath ?? t('newVault.noFolder')}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={picking}
                      aria-describedby={backupError ? `${id}-backup-error` : undefined}
                      onClick={() => void pickBackup()}
                    >
                      {t('newVault.choose')}
                    </button>
                  </div>
                </div>
                {backupError && (
                  <p id={`${id}-backup-error`} role="alert" className={styles.error}>
                    {backupError}
                  </p>
                )}
                <div className={styles.warning}>
                  <p>{t('encryptInPlace.backupWarning')}</p>
                  <p>{t('encryptInPlace.backupChecked')}</p>
                </div>
              </>
            )}
            <div className={dialogs.buttons}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('dialogs.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!backupChosen}
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
        {step === 'backingUp' && (
          <>
            <progress
              className={styles.progress}
              max={progress?.total || 1}
              value={progress?.done ?? 0}
              aria-label={t('encryptInPlace.backupProgressLabel')}
            />
            <p className={dialogs.text}>
              {t('encryptInPlace.backupProgress', {
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
            {backedUp && backupPath && (
              <>
                <p className={dialogs.text}>{t('encryptInPlace.doneBackup')}</p>
                <p className={styles.path}>{backupPath}</p>
              </>
            )}
            <div className={dialogs.buttons}>
              {backedUp && backupPath && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void revealBackup()}
                >
                  {revealLabel(t)}
                </button>
              )}
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
function UndoElsewhereDialog({
  path,
  decrypt,
  onClose,
}: {
  path: string;
  decrypt?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ns = decrypt ? 'decryptInPlace' : 'encryptInPlace';
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
    <Dialog title={t(`${ns}.undoTitle`)} onClose={onClose} alert describedBy={id}>
      <p id={id} className={dialogs.text}>
        {t(`${ns}.undoBody`)}
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
          {t(`${ns}.undoConfirm`)}
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
  useDecryptRecovered();
  if (dialog?.type === 'undoElsewhere')
    return <UndoElsewhereDialog path={dialog.path} decrypt={dialog.decrypt} onClose={close} />;
  if (dialog?.type === 'decryptInPlace')
    return <DecryptInPlaceDialog key={dialog.root} root={dialog.root} onClose={close} />;
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
