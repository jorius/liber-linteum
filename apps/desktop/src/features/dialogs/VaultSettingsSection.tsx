import type { TFunction } from 'i18next';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { vaultSettingsGet, vaultSettingsSet, type AttachmentMode } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { usePageWidthStore } from '../../stores/pageWidthStore';
import { validateName } from '../explorer/nameRules';
import styles from './Dialogs.module.css';

const MODES: AttachmentMode[] = ['subfolder', 'same', 'vault', 'folder'];

/** Plain words for an Obsidian `attachmentFolderPath` value. */
function obsidianPlace(value: string, t: TFunction): string {
  const v = value.trim();
  if (v === '/' || v === '') return t('vault.obsidianRoot');
  if (v === './' || v === '.') return t('vault.obsidianSame');
  if (v.startsWith('./'))
    return t('vault.obsidianSubfolder', { name: v.slice(2).replace(/\/$/, '') });
  return t('vault.obsidianFolder', { name: v.replace(/^\/|\/$/g, '') });
}

/** "This vault" (M2c §5.4): where new attachments go, stored in
 *  `.nimw/vault.json`. When Obsidian has its own setting, it applies unless
 *  "Use a different place in Notes In My Way" is on (M4b §5); Obsidian's file
 *  is never written. */
export function VaultSettingsSection() {
  const { t } = useTranslation();
  const id = useId();
  const errorId = useId();
  const [mode, setMode] = useState<AttachmentMode>('subfolder');
  const [path, setPath] = useState('attachments');
  const [obsidian, setObsidian] = useState<string | null>(null);
  const [own, setOwn] = useState(false);
  const vaultWidth = usePageWidthStore((s) => s.vault);
  const widthId = useId();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What `.nimw/vault.json` holds (as loaded, then as last saved): saving the
  // same again would create `.nimw/` for nothing (final review M5).
  const stored = useRef<{ mode: AttachmentMode; path: string } | null>(null);

  useEffect(() => {
    let live = true;
    void vaultSettingsGet().then((res) => {
      if (!live || !res.ok || !res.value?.attachments) return;
      stored.current = res.value.attachments;
      setMode(res.value.attachments.mode);
      setPath(res.value.attachments.path);
      setObsidian(res.value.obsidian);
      setOwn(res.value.overrideObsidian === true);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const save = async (nextMode: AttachmentMode, nextPath: string) => {
    const was = stored.current;
    if (was && was.mode === nextMode && was.path === nextPath) return;
    const res = await vaultSettingsSet({ attachments: { mode: nextMode, path: nextPath } });
    if (!res.ok) setError(errorMessage(res.error));
    else {
      stored.current = { mode: nextMode, path: nextPath };
      setError(null);
    }
  };
  const problem = (value: string): string | null => {
    const parts = mode === 'folder' ? value.split('/') : [value];
    for (const part of parts) {
      const bad = validateName(part);
      if (bad) {
        return t(
          `explorer.nameErrors.${bad.key}`,
          bad.key === 'forbidden' ? { char: bad.char } : {},
        );
      }
    }
    return null;
  };
  const changeMode = (next: AttachmentMode) => {
    setMode(next);
    setError(null);
    if (next === 'vault' || next === 'same') void save(next, '');
    else if (next === 'subfolder') {
      setPath('attachments');
      void save(next, 'attachments');
    } else setPath(''); // a folder is saved once it is typed
  };
  const commitPath = () => {
    const value = path.trim().replace(/^\/+|\/+$/g, '');
    const why = problem(value);
    if (why) {
      setError(why);
      return;
    }
    void save(mode, value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitPath();
    }
  };

  /** The override switch: on stores NIMW's current place with it; off keeps
   *  the place for next time. */
  const toggleOwn = async (on: boolean) => {
    const res = await vaultSettingsSet(
      on ? { attachments: { mode, path }, overrideObsidian: true } : { overrideObsidian: false },
    );
    if (!res.ok) {
      setError(errorMessage(res.error));
      return;
    }
    stored.current = res.value.attachments;
    setOwn(res.value.overrideObsidian === true);
    setError(null);
  };

  const locked = obsidian !== null && !own;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {t('settings.sections.vault')}
      </h3>
      <label className={styles.field}>
        <span>{t('vault.attachmentsLabel')}</span>
        <select
          className={styles.select}
          value={mode}
          disabled={locked || !loaded}
          onChange={(e) => changeMode(e.target.value as AttachmentMode)}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(`vault.modes.${m}`)}
            </option>
          ))}
        </select>
      </label>
      {obsidian !== null && (
        <>
          <p className={styles.hint}>
            {t('vault.obsidianSet', { value: obsidian, place: obsidianPlace(obsidian, t) })}
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={own}
              disabled={!loaded}
              onChange={(e) => void toggleOwn(e.target.checked)}
            />
            {t('vault.override')}
          </label>
        </>
      )}
      {(mode === 'subfolder' || mode === 'folder') && !locked && (
        <label className={styles.field}>
          <span>{t(mode === 'subfolder' ? 'vault.subfolderName' : 'vault.folderPath')}</span>
          <input
            className={styles.hexInput}
            value={path}
            spellCheck={false}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            onBlur={commitPath}
          />
        </label>
      )}
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {locked && <p className={styles.hint}>{t('vault.obsidianHint')}</p>}
      <label className={styles.field} htmlFor={widthId}>
        <span>{t('vault.pageWidth')}</span>
        <select
          id={widthId}
          className={styles.select}
          value={vaultWidth ?? 'default'}
          disabled={!loaded}
          onChange={(e) =>
            void usePageWidthStore
              .getState()
              .setVault(e.target.value as 'readable' | 'full' | 'default')
          }
        >
          <option value="default">{t('vault.pageWidthDefault')}</option>
          <option value="readable">{t('settings.pageWidthReadable')}</option>
          <option value="full">{t('settings.pageWidthFull')}</option>
        </select>
      </label>
    </section>
  );
}
