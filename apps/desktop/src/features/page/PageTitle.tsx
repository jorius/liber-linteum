import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { IpcResult } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { usePageStore } from '../../stores/pageStore';
import { isArchived, nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { validateName } from '../explorer/nameRules';
import styles from './PageView.module.css';

/** `Notes/My page.md` → `My page`. */
export const stemOf = (path: string): string => split(path).stem;

/** `Notes/My page.md` → `My page` and `.md`. */
function split(path: string): { stem: string; ext: string } {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/** The page title, editable in place (M2b §2): it is the file name, so Enter
 *  or leaving the field renames the file (links updated as for any rename);
 *  Escape puts the name back. It sits at the top of the page (M5b §2.3); the note's own
 *  title, when it differs, shows in the header band (`NoteTitle`). A text
 *  file (M4b part 2 §6) shows its extension after the field; it is kept. */
export function PageTitle({
  path,
  rename,
}: {
  path: string;
  /** Renames to the new name (same folder); a single-file window renames
   *  its own file (M4c §3). Default: the vault's rename, links updated. */
  rename?: (to: string) => Promise<IpcResult<unknown>>;
}) {
  const { t } = useTranslation();
  const { stem, ext } = split(path);
  const text = ext.toLowerCase() !== '.md';
  const [draft, setDraft] = useState(stem);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // A rename from elsewhere (a quick note named after its first line)
    // mustn't reset a name being typed (M4c final review I3).
    if (document.activeElement === input.current) return;
    setDraft(stem);
    setError(null);
  }, [stem]);
  // A page just made from the Global View: ready to be named (M3a §5).
  const focusRequest = usePageStore((s) => s.titleFocus);
  useEffect(() => {
    if (focusRequest?.path !== path || !input.current) return;
    input.current.focus();
    input.current.select();
    usePageStore.getState().clearTitleFocus();
  }, [focusRequest, path]);

  const taken = () => t('page.titleTaken', { name: draft.trim() });

  const commit = async () => {
    const name = draft.trim();
    if (busy || name === stem) {
      setError(null);
      return;
    }
    const invalid = validateName(name);
    if (invalid) {
      setError(
        t(
          `explorer.nameErrors.${invalid.key}`,
          invalid.key === 'forbidden' ? { char: invalid.char } : {},
        ),
      );
      return;
    }
    const dir = parentOf(path);
    const to = dir ? `${dir}/${name}${ext}` : `${name}${ext}`;
    const same = (p: string) => p.toLowerCase() === to.toLowerCase();
    const clash = useVaultStore
      .getState()
      .nodes.some((n) => same(n.path) && n.path.toLowerCase() !== path.toLowerCase());
    if (clash) {
      setError(taken());
      return;
    }
    setBusy(true);
    // Reported inline under the title, so no toast as well (final review m4).
    const res = rename
      ? await rename(to)
      : await useVaultStore.getState().rename(path, to, { quiet: true });
    setBusy(false);
    if (!res.ok) setError(res.error.kind === 'alreadyExists' ? taken() : errorMessage(res.error));
    else setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(stem);
      setError(null);
    }
  };

  return (
    <>
      <h1 className={styles.title}>
        <input
          ref={input}
          data-page-title
          className={styles.titleInput}
          aria-label={t(text ? 'page.fileNameLabel' : 'page.titleLabel')}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
          // Archived pages are read-only (M5b round 2).
          readOnly={isArchived(path)}
          // As wide as its text, so the heading's pill fits it (Safari 15 has no field-sizing).
          size={Math.max(8, draft.length + 1)}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // The window lost focus (switching apps mid-edit): keep the edit;
            // Enter or a real blur inside the app commits it (final review m6).
            if (document.hasFocus()) void commit();
          }}
        />
        {text && ext && <span className={styles.titleExt}>{ext}</span>}
      </h1>
      {error && (
        <p id={errorId} role="alert" className={styles.titleError}>
          {error}
        </p>
      )}
    </>
  );
}
