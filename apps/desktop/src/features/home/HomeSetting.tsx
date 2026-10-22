import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { LinkSuggestion } from '../../ipc';
import { isArchived, nameOf } from '../../stores/tree';
import { useVaultStore } from '../../stores/vaultStore';
import dialogs from '../dialogs/Dialogs.module.css';
import { HomeIcon } from '../../app/icons';
import styles from './Home.module.css';
import { PickerPopup } from '../editor/PickerPopup';
import { homeOffered, homePageOf, useHomeStore } from './homeStore';

type Choice = 'none' | 'globalView' | 'page';

/** Archived pages can't be a home. Kept stable: the picker reads again when
 *  its filter changes. */
const notArchived = (s: LinkSuggestion) => !isArchived(s.path);

/** Settings → This vault → Home: Nothing (pick a page) / Global View / A
 *  page…, the page found with the editor's page picker. */
export function HomeSetting() {
  const { t } = useTranslation();
  const id = useId();
  const hintId = useId();
  const pageId = useId();
  const nameId = useId();
  const home = useHomeStore((s) => s.home);
  const offered = useVaultStore((s) => homeOffered(s.info));
  // "A page…" chosen, its page not picked yet.
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const anchor = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom, left: r.left } : null;
  }, []);
  if (!offered) return null;

  const page = homePageOf(home);
  const choice: Choice =
    page || pending ? 'page' : home?.kind === 'globalView' ? 'globalView' : 'none';
  const change = (next: Choice) => {
    if (next === 'page') {
      setPending(true);
      setPicking(true);
      return;
    }
    setPending(false);
    setPicking(false);
    void useHomeStore.getState().set(next === 'globalView' ? { kind: 'globalView' } : null);
  };
  const close = (refocus: boolean) => {
    setPicking(false);
    // Nothing picked: the choice goes back to what is stored.
    setPending(false);
    if (refocus) button.current?.focus();
  };
  // Escape closes the picker, not Settings.
  const keepEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') e.stopPropagation();
  };

  return (
    <div className={styles.setting} role="group" aria-labelledby={id} data-home-setting>
      <label className={dialogs.field}>
        <span id={id}>{t('home.setting')}</span>
        <select
          className="field-control"
          value={choice}
          aria-describedby={hintId}
          onChange={(e) => change(e.target.value as Choice)}
        >
          {(['none', 'globalView', 'page'] as const).map((c) => (
            <option key={c} value={c}>
              {t(`home.choices.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <p id={hintId} className={dialogs.hint}>
        {t('home.settingHint')}
      </p>
      {choice === 'page' && (
        <div className={styles.pageRow}>
          <span id={pageId}>{t('home.page')}</span>
          <span
            id={nameId}
            className={styles.pageName}
            data-home-page
            data-empty={page ? undefined : true}
          >
            {page && <HomeIcon size={14} />}
            {page ? nameOf(page).replace(/\.md$/i, '') : t('home.noPage')}
          </span>
          <button
            ref={button}
            type="button"
            className="btn btn-secondary"
            aria-haspopup="listbox"
            aria-expanded={picking}
            aria-describedby={`${pageId} ${nameId}`}
            onClick={() => setPicking(true)}
          >
            {t(page ? 'home.change' : 'home.choose')}
          </button>
        </div>
      )}
      {picking && (
        <div onKeyDown={keepEscape}>
          <PickerPopup
            // Any page will do: only the picked page's path is used.
            source={page ?? 'index.md'}
            anchor={anchor}
            allowUrl={false}
            label={t('home.pickerLabel')}
            placeholder={t('home.pickerPlaceholder')}
            filter={notArchived}
            onPick={(o) => {
              if (o.kind !== 'page') return;
              setPicking(false);
              setPending(false);
              void useHomeStore.getState().set({ kind: 'page', path: o.page.path });
              button.current?.focus();
            }}
            onClose={close}
          />
        </div>
      )}
    </div>
  );
}
