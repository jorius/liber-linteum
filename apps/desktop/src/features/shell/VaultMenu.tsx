import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../stores/vaultStore';
import { openNewVault } from '../encryption/CreateEncryptedHost';
import { newQuickNote } from '../scratchpad/quickNote';
import {
  closeVault,
  decryptThisVault,
  encryptThisVault,
  openAnotherVault,
  openSettings,
} from './shellMenu';
import styles from './Shell.module.css';

/** The vault's name in the sidebar, as a menu button (M5b §11.1). Windows and
 *  Linux have no app menu bar, so every vault action lives here too: New vault…,
 *  Open another vault…, a new scratchpad note, Encrypt "<name>"… (a plain
 *  vault) or Decrypt "<name>"… and Lock vault (an encrypted one), Settings…,
 *  Close vault. */
export function VaultMenu({ name }: { name: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const plain = useVaultStore((s) => !!s.info && !s.info.encrypted && !s.info.scratchpad);
  const encrypted = useVaultStore((s) => !!s.info?.encrypted);
  const decryptable = useVaultStore((s) => !!s.info?.encrypted && !s.info.scratchpad);
  const button = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.brand}
        aria-haspopup="menu"
        aria-expanded={open}
        data-vault-menu
        title={name}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown') return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        <span className={styles.brandName}>{name}</span>
      </button>
      {open && button.current && (
        <Menu
          anchor={button.current}
          label={name}
          items={[
            [t('shell.newVault'), () => void openNewVault()],
            [t('shell.openAnother'), openAnotherVault],
            [t('shell.newScratchpad', { name }), () => void newQuickNote()],
            ...(plain
              ? [[t('shell.encryptVault', { name }), encryptThisVault] as [string, () => void]]
              : []),
            ...(decryptable
              ? [[t('shell.decryptVault', { name }), decryptThisVault] as [string, () => void]]
              : []),
            ...(encrypted
              ? [
                  [t('shell.lockVault'), () => void useVaultStore.getState().lock('menu')] as [
                    string,
                    () => void,
                  ],
                ]
              : []),
            [t('shell.settingsItem'), openSettings],
            [t('shell.closeVault'), closeVault],
          ]}
          onClose={close}
        />
      )}
    </>
  );
}

function Menu({
  anchor,
  label,
  items,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  items: [string, () => void][];
  onClose: (refocus: boolean) => void;
}) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  useEffect(() => {
    refs.current[active]?.focus();
  }, [active]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = items.length;
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % n);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + n) % n);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      className="liber-menu"
      style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4, minWidth: 220 }}
      onKeyDown={onKeyDown}
    >
      {items.map(([text, run], i) => (
        <button
          key={text}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onMouseMove={() => setActive(i)}
          onClick={() => {
            onClose(false);
            run();
          }}
        >
          {text}
        </button>
      ))}
    </div>,
    document.body,
  );
}
