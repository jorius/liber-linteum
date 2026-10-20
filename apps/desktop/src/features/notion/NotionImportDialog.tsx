import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  notionCancel,
  notionPickParent,
  notionPickZip,
  notionPreview,
  notionRevealPartial,
  onNotionProgress,
  type NotionPreview,
} from '../../ipc';
import { openPage } from '../../stores/navigate';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { formatSize } from '../bin/BinView';
import { revealLabel } from '../preview/ExternalFile';
import { quietly } from '../scratchpad/ScratchpadHost';
import { Dialog } from '../dialogs/Dialog';
import dialogs from '../dialogs/Dialogs.module.css';
import styles from './Notion.module.css';

/** Characters a vault name can't hold (the app's name rules). */
const REFUSED = /[/\\#|^[\]:*"<>?]/;
/** Windows device names, alone or before a dot (`CON`, `nul.txt`). */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
/** A trailing Notion id, which Rust strips (so the name would change). */
const NOTION_ID = / [0-9a-f]{32}$/;

/** The name rules `notion_import` applies (Rust's `vault_name`), checked here
 *  so a refused name is said before the export is read again. */
export function validVaultName(name: string): boolean {
  const n = name.trim();
  return (
    n !== '' &&
    !n.startsWith('.') &&
    !n.endsWith('.') &&
    !REFUSED.test(n) &&
    !DEVICE.test(n) &&
    !NOTION_ID.test(n) &&
    new TextEncoder().encode(n).length <= 200
  );
}

type Step =
  | { kind: 'idle' }
  | { kind: 'reading' }
  /** `error`: a name refused (taken, invalid); the preview stays. */
  | { kind: 'ready'; preview: NotionPreview; error?: string }
  | { kind: 'importing'; done: number; total: number; preview: NotionPreview }
  | { kind: 'failed'; message: string }
  /** The import stopped part-way: its vault is at `root`, not open. */
  | { kind: 'partial'; message: string; root: string; report: string };

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
  const reading = step.kind === 'reading';
  const stopButton = useRef<HTMLButtonElement>(null);

  // The name field is disabled while importing: focus goes to Stop, so
  // Escape (and the keyboard) still reach the dialog.
  useEffect(() => {
    if (importing) stopButton.current?.focus();
  }, [importing]);

  useEffect(() => {
    if (!importing) return;
    let stop: (() => unknown) | null = null;
    let gone = false;
    void onNotionProgress((p) => setStep((s) => (s.kind === 'importing' ? { ...s, ...p } : s)))
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
    const p = step.preview;
    // Every file the import writes: pages, rows, attachments, each
    // database's index page, and the report.
    const total = p.pages + p.rows + p.attachments + p.databases + 1;
    setStep({ kind: 'importing', done: 0, total, preview: p });
    const res = await useVaultStore.getState().importNotion(name.trim());
    if (!res.ok) {
      // A taken or refused name: pick another without reading the export again.
      const nameProblem = res.error.kind === 'alreadyExists' || res.error.kind === 'invalidName';
      setStep(
        nameProblem
          ? { kind: 'ready', preview: p, error: errorMessage(res.error) }
          : { kind: 'failed', message: errorMessage(res.error) },
      );
      return;
    }
    if (res.value.failed) {
      setStep({
        kind: 'partial',
        message: res.value.failed,
        root: res.value.root,
        report: res.value.report,
      });
      return;
    }
    onClose();
    if (res.value.cancelled) {
      useToastStore.getState().push({ message: t('notion.cancelled') });
    }
    await openPage(res.value.report);
  };

  const openPartial = async (report: string) => {
    const res = await useVaultStore.getState().openPartialImport();
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error) });
      return;
    }
    onClose();
    await openPage(report);
  };

  // A running import isn't closed from under itself: Stop stops it. Closing
  // while the export is read also asks the reading to stop.
  const close = () => {
    if (importing) return void notionCancel();
    if (reading) void notionCancel();
    onClose();
  };

  const preview = step.kind === 'ready' ? step.preview : null;
  return (
    <Dialog title={t('notion.title')} onClose={close} onConfirm={() => void start()} wide>
      <p className={dialogs.text}>{t('notion.intro')}</p>

      <div className={styles.place} role="group" aria-labelledby={exportId}>
        <span className={styles.label} id={exportId}>
          {t('notion.export')}
        </span>
        <span className={`field-control ${styles.value}`}>{zip ?? t('notion.noExport')}</span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={importing || reading}
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
        <span className={`field-control ${styles.value}`}>{parent ?? t('notion.noLocation')}</span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={importing || reading}
          onClick={() => void chooseParent()}
        >
          {t('notion.chooseLocation')}
        </button>
      </div>

      <label className={dialogs.field} htmlFor={nameId}>
        {t('notion.name')}
        <input
          id={nameId}
          className={`field-control ${dialogs.textInput}`}
          value={name}
          placeholder={t('notion.namePlaceholder')}
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
                  <p className={dialogs.hint}>
                    {t('notion.moreWarnings', { count: preview.moreWarnings })}
                  </p>
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
        {step.kind === 'ready' && step.error && (
          <p className={dialogs.error} role="alert">
            {step.error}
          </p>
        )}
        {step.kind === 'failed' && (
          <p className={dialogs.error} role="alert">
            {step.message}
          </p>
        )}
        {step.kind === 'partial' && (
          <>
            <p className={dialogs.error} role="alert">
              {t('notion.partial', { message: step.message, root: step.root })}
            </p>
            <div className={dialogs.buttons}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void notionRevealPartial()}
              >
                {revealLabel(t)}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void openPartial(step.report)}
              >
                {t('notion.openAnyway')}
              </button>
            </div>
          </>
        )}
      </section>

      <div className={dialogs.buttons}>
        <button type="button" className="btn btn-secondary" ref={stopButton} onClick={close}>
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
