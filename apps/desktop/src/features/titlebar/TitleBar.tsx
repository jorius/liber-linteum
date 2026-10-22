import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAppVersion } from '../../app/useAppVersion';
import {
  menuActivate,
  onWindowResized,
  windowCloseRequest,
  windowMaximized,
  windowMinimize,
  windowStartDrag,
  windowToggleFullscreen,
  windowToggleMaximize,
} from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { Dialog } from '../dialogs/Dialog';
import { keyLabel } from '../dialogs/shortcuts';
import { runEdit, type EditAction } from './editActions';
import { buildMenus, type LocalAction, type MenuDef, type MenuItemEntry } from './menus';
import dialogStyles from '../dialogs/Dialogs.module.css';
import styles from './TitleBar.module.css';

/** Whether the app draws its own title bar (custom title bar §1): everywhere
 *  but macOS, which keeps the system's frame and its app menu. */
export const ownTitleBar = (): boolean =>
  !/Mac/i.test(navigator.platform) && !/Mac OS X/.test(navigator.userAgent);

const onWindows = (): boolean => /^Win/i.test(navigator.platform);

/** The page's title (`useWindowTitle` keeps it as the window's), followed live. */
function useDocumentTitle(): string {
  const [title, setTitle] = useState(document.title);
  useEffect(() => {
    const observer = new MutationObserver(() => setTitle(document.title));
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return title;
}

/** Whether the window is maximized, followed as it changes. */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    const read = () =>
      void windowMaximized().then((r) => {
        if (r.ok && !gone) setMaximized(r.value);
      });
    read();
    onWindowResized(read)
      .then((unlisten) => (gone ? unlisten() : (stop = unlisten)))
      .catch(() => undefined);
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  return maximized;
}

type Item = MenuItemEntry;
const items = (menu: MenuDef): Item[] =>
  menu.items.filter((i): i is Item => i.kind === 'item' && !i.disabled);

/** The window's frame outside macOS (custom title bar §2): the menus of the
 *  macOS app menu on the left, the page's title in the middle, the window
 *  buttons on the right; the bar itself moves the window, and a double click
 *  maximizes it. `main`: the vault window (file windows have no Vault menu). */
export function TitleBar({ main }: { main: boolean }) {
  const { t } = useTranslation();
  const title = useDocumentTitle();
  const maximized = useMaximized();
  const status = useVaultStore((s) => s.status);
  const info = useVaultStore((s) => s.info);
  const settings = useSettingsStore((s) => s.settings);
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const [about, setAbout] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const entries = useRef<(HTMLButtonElement | null)[]>([]);
  /** The menu the pointer opened by moving onto its name: the click that
   *  follows keeps it open. */
  const hovered = useRef<number | null>(null);
  /** What had the keyboard before a menu opened: Edit acts on it, Escape returns to it. */
  const before = useRef<Element | null>(null);
  const windows = onWindows();

  const menus = buildMenus(t, {
    main,
    vault:
      main && status === 'open' && info
        ? { name: info.name, encrypted: !!info.encrypted, scratchpad: !!info.scratchpad }
        : null,
    toggles: {
      sidebar: !settings.sidebarCollapsed,
      toolbar: settings.toolbar,
      lineNumbers: settings.lineNumbers,
      outline: settings.outline,
    },
    maximized,
    windows,
  });

  /** Opens menu `n`; `focus` (the keyboard opened it) takes the keyboard into it. */
  const show = (n: number, focus: boolean) => {
    if (open === null) before.current = document.activeElement;
    setOpen(n);
    setActive(focus ? 0 : -1);
    if (focus) setTimeout(() => entries.current[0]?.focus());
  };
  const close = (refocus: boolean) => {
    setOpen(null);
    setActive(-1);
    const target = before.current;
    if (refocus && target instanceof HTMLElement) target.focus();
  };

  const runLocal = (action: LocalAction, target: Element | null) => {
    if (action === 'about') setAbout(true);
    else if (action === 'fullscreen') void windowToggleFullscreen();
    else if (action === 'minimize') void windowMinimize();
    else if (action === 'maximize') void windowToggleMaximize();
    else if (action === 'closeWindow') void windowCloseRequest();
    else void runEdit(action as EditAction, target);
  };
  const choose = (entry: Item) => {
    const target = before.current;
    close(false);
    if (target instanceof HTMLElement) target.focus();
    if ('id' in entry) void menuActivate(entry.id);
    else runLocal(entry.action, target);
  };

  // Keys while a menu is open, wherever the keyboard is (a menu opened with
  // the pointer leaves it in the editor): arrows, Enter, Escape.
  useEffect(() => {
    if (open === null) return;
    const list = items(menus[open]);
    const onKeyDown = (e: KeyboardEvent) => {
      const move = (to: number) => {
        setActive(to);
        entries.current[to]?.focus();
      };
      if (e.key === 'Escape') close(true);
      else if (e.key === 'ArrowDown') move((active + 1) % list.length);
      else if (e.key === 'ArrowUp') move((active - 1 + list.length) % list.length);
      else if (e.key === 'Home') move(0);
      else if (e.key === 'End') move(list.length - 1);
      else if (e.key === 'ArrowRight') show((open + 1) % menus.length, true);
      else if (e.key === 'ArrowLeft') show((open - 1 + menus.length) % menus.length, true);
      else if ((e.key === 'Enter' || e.key === ' ') && list[active]) choose(list[active]);
      else if (e.key === 'Tab') close(false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onDown = (e: globalThis.MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) close(false);
    };
    // Another app taking the focus closes the menu, as a native one.
    const onBlur = () => close(false);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  });

  // The keys macOS gives its menu's accelerators, where only this menu has
  // them: Ctrl+Q, Alt+Ctrl+W, F11; F10 takes the keyboard to the menus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const ctrl = e.ctrlKey && !e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && !e.altKey && !e.shiftKey && (key === 'q' || e.code === 'KeyQ')) {
        void menuActivate('liber-quit');
      } else if (main && ctrl && e.altKey && !e.shiftKey && e.code === 'KeyW') {
        void menuActivate('liber-vault-close');
      } else if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        void windowToggleFullscreen();
      } else if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.shiftKey && open === null) {
        show(0, true);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  /** A press on the bar itself (not a button) moves the window; a double click maximizes it. */
  const onBarDown = (e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('button, [role="menu"]')) return;
    e.preventDefault();
    if (e.detail === 2) void windowToggleMaximize();
    else void windowStartDrag();
  };

  let index = -1;
  return (
    <>
      {/* A named region (axe: all content in landmarks); not a banner. */}
      <section
        ref={bar}
        aria-label={t('titlebar.region')}
        className={styles.bar}
        data-titlebar
        data-platform={windows ? 'windows' : 'linux'}
        onMouseDown={onBarDown}
      >
        <div role="menubar" aria-label={t('titlebar.menubar')} className={styles.menubar}>
          {menus.map((menu, n) => (
            <div key={menu.key} className={styles.slot}>
              <button
                ref={(el) => {
                  buttons.current[n] = el;
                }}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open === n}
                className={n === 0 ? `${styles.top} ${styles.appName}` : styles.top}
                // The pointer leaves the keyboard where it was (the editor).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (open === n && hovered.current !== n) close(false);
                  else show(n, false);
                  hovered.current = null;
                }}
                onMouseEnter={() => {
                  if (open === null || open === n) return;
                  hovered.current = n;
                  show(n, false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    show(n, true);
                  }
                }}
              >
                {menu.label}
              </button>
              {open === n && (
                <div role="menu" aria-label={menu.label} className={`liber-menu ${styles.menu}`}>
                  {menu.items.map((entry) => {
                    if (entry.kind === 'separator') return <div key={entry.key} role="separator" />;
                    const at = entry.disabled ? -1 : ++index;
                    const current = at >= 0 && at === active;
                    return (
                      <button
                        key={entry.key}
                        ref={(el) => {
                          if (at >= 0) entries.current[at] = el;
                        }}
                        type="button"
                        role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                        aria-checked={entry.checked}
                        aria-disabled={entry.disabled || undefined}
                        tabIndex={current ? 0 : -1}
                        className={styles.entry}
                        data-active={current || undefined}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => at >= 0 && setActive(at)}
                        onClick={() => !entry.disabled && choose(entry)}
                      >
                        <span className={styles.check} aria-hidden>
                          {entry.checked ? '✓' : ''}
                        </span>
                        <span className={styles.label}>{entry.label}</span>
                        {entry.keys && (
                          <kbd className={styles.keys}>{keyLabel(entry.keys, false)}</kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className={styles.title} title={title}>
          {title}
        </div>
        <div className={styles.controls}>
          <WindowButton label={t('titlebar.items.minimize')} onClick={() => void windowMinimize()}>
            <path d="M3 8h10" />
          </WindowButton>
          <WindowButton
            label={t(maximized ? 'titlebar.items.restore' : 'titlebar.items.maximize')}
            onClick={() => void windowToggleMaximize()}
          >
            {maximized ? (
              <>
                <rect x="3.5" y="5.5" width="7" height="7" />
                <path d="M5.5 5.5V3.5h7v7h-2" />
              </>
            ) : (
              <rect x="3.5" y="3.5" width="9" height="9" />
            )}
          </WindowButton>
          <WindowButton
            label={t('titlebar.items.closeWindow')}
            close
            onClick={() => void windowCloseRequest()}
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </WindowButton>
        </div>
      </section>
      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </>
  );
}

function WindowButton({
  label,
  close = false,
  onClick,
  children,
}: {
  label: string;
  close?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={close ? `${styles.control} ${styles.close}` : styles.control}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

/** Liber Linteum → About (macOS shows its standard About panel). */
function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const version = useAppVersion();
  return createPortal(
    <Dialog title={t('titlebar.about.title')} onClose={onClose} onConfirm={onClose} dismissible>
      <p className={styles.aboutName}>{t('app.name')}</p>
      {version && <p className={styles.aboutMuted}>{t('app.version', { version })}</p>}
      <p>{t('app.tagline')}</p>
      <p className={styles.aboutMuted}>{t('titlebar.about.license')}</p>
      <p className={styles.aboutMuted}>{t('app.credits')}</p>
      <div className={dialogStyles.buttons}>
        <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
          {t('dialogs.close')}
        </button>
      </div>
    </Dialog>,
    document.body,
  );
}
