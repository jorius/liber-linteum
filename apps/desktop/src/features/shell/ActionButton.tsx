import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionsIcon, GraphIcon, PencilIcon, SearchIcon } from '../../app/icons';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import styles from './Shell.module.css';

const MAC = /Mac/i.test(navigator.platform);
const keys = (k: string) => (MAC ? `⌘${k}` : `Ctrl+${k}`);

/** The floating Edit / Global view / Search button (M5b §2.2): a disclosure
 *  (§11.4) whose group opens over the page. ↑ / ↓ move through it, Escape
 *  closes it and gives the keyboard back to the button, a click elsewhere
 *  closes it; ⌘J toggles it (useGlobalShortcuts). */
export function ActionButton() {
  const { t } = useTranslation();
  const place = useSettingsStore((s) => s.settings.actionButton);
  const open = useUiStore((s) => s.actionsOpen);
  const screen = useUiStore((s) => s.screen);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const setOpen = useUiStore.getState().setActionsOpen;

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLButtonElement>('[role="group"] button')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);

  /** Runs an action; the keyboard goes to the screen it shows (the editor),
   *  else back to the button, never to nothing (final review M5). */
  const run = (action: () => void, target?: string) => {
    setOpen(false);
    action();
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now && now !== document.body) return; // a dialog took it
      const to = target ? document.querySelector<HTMLElement>(target) : null;
      (to ?? button.current)?.focus({ preventScroll: true });
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(box.current?.querySelectorAll<HTMLButtonElement>('[role="group"] button') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      setOpen(false);
      button.current?.focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && at >= 0) {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const { setScreen, openDialog } = useUiStore.getState();
  return (
    <div
      ref={box}
      className={styles.fab}
      data-place={place}
      onKeyDown={onKeyDown}
      // Tab out of the group closes it (final review M5).
      onBlur={(e) => {
        if (open && !box.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {open && (
        <div
          id="nimw-actions"
          role="group"
          aria-label={t('shell.actions')}
          className={styles.fabStack}
        >
          <button
            type="button"
            className={styles.fabItem}
            aria-keyshortcuts="Meta+F Control+F"
            onClick={() => run(() => openDialog({ type: 'search' }))}
          >
            <SearchIcon />
            {t('search.button')}
            <kbd className={styles.kbd} aria-hidden="true">
              {keys('F')}
            </kbd>
          </button>
          <button
            type="button"
            className={styles.fabItem}
            aria-pressed={screen === 'global'}
            aria-keyshortcuts="Meta+2 Control+2"
            onClick={() => run(() => setScreen('global'), '[data-gv-card]')}
          >
            <GraphIcon />
            {t('shell.globalView')}
            <kbd className={styles.kbd} aria-hidden="true">
              {keys('2')}
            </kbd>
          </button>
          <button
            type="button"
            className={styles.fabItem}
            aria-pressed={screen === 'edit'}
            aria-keyshortcuts="Meta+1 Control+1"
            onClick={() => run(() => setScreen('edit'), '.cm-content')}
          >
            <PencilIcon />
            {t('shell.edit')}
            <kbd className={styles.kbd} aria-hidden="true">
              {keys('1')}
            </kbd>
          </button>
        </div>
      )}
      <button
        ref={button}
        type="button"
        className={styles.fabButton}
        aria-label={t('shell.actions')}
        aria-expanded={open}
        aria-controls={open ? 'nimw-actions' : undefined}
        aria-keyshortcuts="Meta+J Control+J"
        title={`${t('shell.actions')} (${keys('J')})`}
        onClick={() => setOpen(!open)}
      >
        <ActionsIcon />
      </button>
    </div>
  );
}
