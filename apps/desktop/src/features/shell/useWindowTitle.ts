import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { windowTitleSet } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { nameOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Names the window after what it shows (M5b §2.3, §11.8): "Page — Vault" in
 *  the editor, "Global view — Vault" there, else the vault. The page's name
 *  is its file's, as the title field shows it. */
export function useWindowTitle() {
  const { t } = useTranslation();
  const vault = useVaultStore((s) => s.info?.name ?? '');
  const screen = useUiStore((s) => s.screen);
  const path = usePageStore((s) => s.path);
  const what =
    screen === 'global' ? t('shell.globalView') : path ? nameOf(path).replace(/\.md$/i, '') : null;
  const title = what ? `${what} — ${vault}` : vault;
  useEffect(() => {
    // Outside the app the call simply fails (ipcCall answers an error).
    if (title) void windowTitleSet(title);
  }, [title]);
}
