import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Page } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { usePageStore } from '../../stores/pageStore';
import { nameOf, parentOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import { validateName } from '../explorer/nameRules';
import styles from './PageView.module.css';

/** `Notes/My page.md` → `My page` and `.md`. */
function split(path: string): { stem: string; ext: string } {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/** The page title, editable in place (M2b §2): it is the file name, so Enter
 *  or leaving the field renames the file (links updated as for any rename);
 *  Escape puts the name back. The note's own title (first heading or
 *  `title:`) is shown under it when it differs. */
export function PageTitle({ page }: { page: Page }) {
  const { t } = useTranslation();
  const { stem, ext } = split(page.path);
  const [draft, setDraft] = useState(stem);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(stem);
    setError(null);
  }, [stem]);
  // A page just made from the Global View: ready to be named (M3a §5).
  const focusRequest = usePageStore((s) => s.titleFocus);
  useEffect(() => {
    if (focusRequest?.path !== page.path || !input.current) return;
    input.current.focus();
    input.current.select();
    usePageStore.getState().clearTitleFocus();
  }, [focusRequest, page.path]);

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
    const dir = parentOf(page.path);
    const to = dir ? `${dir}/${name}${ext}` : `${name}${ext}`;
    const same = (p: string) => p.toLowerCase() === to.toLowerCase();
    const clash = useVaultStore
      .getState()
      .nodes.some((n) => same(n.path) && n.path.toLowerCase() !== page.path.toLowerCase());
    if (clash) {
      setError(taken());
      return;
    }
    setBusy(true);
    // Reported inline under the title, so no toast as well (final review m4).
    const res = await useVaultStore.getState().rename(page.path, to, { quiet: true });
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
          className={styles.titleInput}
          aria-label={t('page.titleLabel')}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          spellCheck={false}
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
      </h1>
      {error && (
        <p id={errorId} role="alert" className={styles.titleError}>
          {error}
        </p>
      )}
      {page.title && page.title !== stem && (
        <p className={styles.noteTitle}>{t('page.titleInNote', { title: page.title })}</p>
      )}
    </>
  );
}
