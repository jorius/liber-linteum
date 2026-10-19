import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  notionCancel,
  notionPickParent,
  notionPickZip,
  notionPreview,
  onNotionProgress,
  type NotionPreview,
} from '../../ipc';
import { openPage } from '../../stores/navigate';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { formatSize } from '../bin/BinView';
import { quietly } from '../scratchpad/ScratchpadHost';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import styles from './Notion.module.css';

/** Characters a vault name can't hold (the app's name rules). */
const REFUSED = /[/\\#|^[\]:*"<>?]/;

export function validVaultName(name: string): boolean {
  const n = name.trim();
  return n !== '' && !n.startsWith('.') && !REFUSED.test(n);
}

type Step =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'ready'; preview: NotionPreview }
  | { kind: 'importing'; done: number; total: number }
  | { kind: 'failed'; message: string };

/** Import from Notion (M7 §3): the export and the new vault's place, picked
 *  in dialogs Rust opens; a dry-run preview; then the import, which opens
 *  the new vault at its report page. */
export function NotionImportDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [zip, setZip] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const exportId = useId();
  const placeId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const importing = step.kind === 'importing';

  useEffect(() => {
    if (!importing) return;
    let stop: (() => unknown) | null = null;
    let gone = false;
    void onNotionProgress((p) => setStep({ kind: 'importing', ...p }))
      .then((un) => (gone ? quietly(un) : (stop = un)))
      .catch(() => undefined); // no event runtime (plain browser)
    return () => {
      gone = true;
      if (stop) quietly(stop);
    };
  }, [importing]);

  const chooseZip = async () => {
    const res = await notionPickZip();
    if (!res.ok || !res.value) return;
    const picked = res.value;
    setZip(picked.name);
    setName((n) => n || picked.suggestedName);
    setStep({ kind: 'reading' });
    const preview = await notionPreview();
    setStep(
      preview.ok
        ? { kind: 'ready', preview: preview.value }
        : { kind: 'failed', message: errorMessage(preview.error) },
    );
  };

  const chooseParent = async () => {
    const res = await notionPickParent();
    if (res.ok && res.value) setParent(res.value);
  };

  const nameOk = validVaultName(name);
  const canImport = step.kind === 'ready' && parent !== null && nameOk;

  const start = async () => {
    if (step.kind !== 'ready' || !canImport) return;
    const total = step.preview.pages + step.preview.rows + step.preview.attachments + 2;
    setStep({ kind: 'importing', done: 0, total });
    const res = await useVaultStore.getState().importNotion(name.trim());
    if (!res.ok) {
      setStep({ kind: 'failed', message: errorMessage(res.error) });
      return;
    }
    onClose();
    if (res.value.cancelled) {
      useToastStore.getState().push({ message: t('notion.cancelled') });
    }
    await openPage(res.value.report);
  };

  // A running import isn't closed from under itself: Cancel stops it.
  const close = () => (importing ? void notionCancel() : onClose());

  const preview = step.kind === 'ready' ? step.preview : null;
  return (
    <Dialog title={t('notion.title')} onClose={close} onConfirm={() => void start()} wide>
      <p className={dialogs.text}>{t('notion.intro')}</p>

      <div className={styles.place} role="group" aria-labelledby={exportId}>
        <span className={styles.label} id={exportId}>
          {t('notion.export')}
        </span>
        <span className={styles.value}>{zip ?? t('notion.noExport')}</span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={importing}
          data-autofocus
          onClick={() => void chooseZip()}
        >
          {t('notion.chooseExport')}
        </button>
      </div>

      <div className={styles.place} role="group" aria-labelledby={placeId}>
        <span className={styles.label} id={placeId}>
          {t('notion.location')}
        </span>
        <span className={styles.value}>{parent ?? t('notion.noLocation')}</span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={importing}
          onClick={() => void chooseParent()}
        >
          {t('notion.chooseLocation')}
        </button>
      </div>

      <label className={dialogs.field} htmlFor={nameId}>
        {t('notion.name')}
        <input
          id={nameId}
          className={dialogs.textInput}
          value={name}
          disabled={importing}
          aria-invalid={name !== '' && !nameOk}
          aria-describedby={name !== '' && !nameOk ? nameErrorId : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {name !== '' && !nameOk && (
        <p className={dialogs.error} id={nameErrorId}>
          {t('notion.nameInvalid')}
        </p>
      )}

      <section className={styles.preview} aria-live="polite" aria-label={t('notion.previewLabel')}>
        {step.kind === 'reading' && <p className={dialogs.hint}>{t('notion.reading')}</p>}
        {preview && (
          <>
            <p className={dialogs.text}>
              {t('notion.counts', {
                pages: preview.pages,
                databases: preview.databases,
                rows: preview.rows,
                attachments: preview.attachments,
              })}{' '}
              <span className={styles.size}>{formatSize(preview.bytes, i18n.language)}</span>
            </p>
            {preview.warnings.length > 0 && (
              <details className={styles.warnings}>
                <summary>
                  {t('notion.warnings', { count: preview.warnings.length + preview.moreWarnings })}
                </summary>
                <ul>
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                {preview.moreWarnings > 0 && (
                  <p className={dialogs.hint}>{t('notion.moreWarnings', { count: preview.moreWarnings })}</p>
                )}
              </details>
            )}
          </>
        )}
        {step.kind === 'importing' && (
          <>
            <progress
              className={styles.progress}
              max={step.total}
              value={step.done}
              aria-label={t('notion.progressLabel')}
            />
            <p className={dialogs.hint}>
              {t('notion.progress', { done: step.done, total: step.total })}
            </p>
          </>
        )}
        {step.kind === 'failed' && (
          <p className={dialogs.error} role="alert">
            {step.message}
          </p>
        )}
      </section>

      <div className={dialogs.buttons}>
        <button type="button" className="btn btn-secondary" onClick={close}>
          {importing ? t('notion.stop') : t('dialogs.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={!canImport || importing}
          onClick={() => void start()}
        >
          {t('notion.import')}
        </button>
      </div>
    </Dialog>
  );
}
