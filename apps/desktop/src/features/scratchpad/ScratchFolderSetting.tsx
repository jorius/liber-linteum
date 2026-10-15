import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { scratchFolderSet } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useVaultStore } from '../../stores/vaultStore';
import dialogs from '../dialogs/Dialogs.module.css';
import { validateName } from '../explorer/nameRules';
import { useScratchpadStore } from './scratchpadStore';

/** Settings → This vault: the name of the vault's scratch folder (M4c §7.1,
 *  §7.8). Saved on Enter or blur; an existing folder is renamed on disk.
 *  Absent in the global Scratchpad, whose root is the scratch place. */
export function ScratchFolderSetting() {
  const { t } = useTranslation();
  const folder = useScratchpadStore((s) => s.folder);
  const [value, setValue] = useState(folder ?? '');
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  useEffect(() => setValue(folder ?? ''), [folder]);

  if (folder === null) return null;

  const commit = async () => {
    const name = value.trim();
    if (name === folder) return;
    const bad = validateName(name);
    if (bad) {
      setError(
        t(`explorer.nameErrors.${bad.key}`, bad.key === 'forbidden' ? { char: bad.char } : {}),
      );
      return;
    }
    const res = await scratchFolderSet(name);
    if (!res.ok) {
      setError(errorMessage(res.error));
      return;
    }
    const { from, outcome } = res.value;
    if (from && outcome) {
      await useVaultStore.getState().applyRename(from, res.value.folder, outcome);
    }
    await useScratchpadStore.getState().load();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    }
  };

  return (
    <>
      <label className={dialogs.field}>
        <span>{t('scratchpad.folderSetting')}</span>
        <input
          className={dialogs.hexInput}
          value={value}
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => void commit()}
        />
      </label>
      {error && (
        <p id={errorId} role="alert" className={dialogs.error}>
          {error}
        </p>
      )}
    </>
  );
}
