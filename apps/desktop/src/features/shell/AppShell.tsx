import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SidebarIcon } from '../../app/icons';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { BinView } from '../bin/BinView';
import { DialogHost } from '../dialogs/DialogHost';
import { useAutoLock } from '../encryption/autoLock';
import { ContextMenu, type MenuState } from '../explorer/ContextMenu';
import { requestTrash } from '../explorer/trashAction';
import { GlobalView } from '../global-view/GlobalView';
import { PageView } from '../page/PageView';
import { ActionButton } from './ActionButton';
import { toggleSidebar } from './shellMenu';
import { Sidebar } from './Sidebar';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import { useWindowTitle } from './useWindowTitle';
import styles from './Shell.module.css';

/** The open-vault layout (spec §3.4; M5b §2): the sidebar explorer (it
 *  collapses), the page view or the Global View, the floating Edit / Global
 *  view / Search button, plus the context menu, dialogs and global shortcuts.
 *  No top bar: the title is in the page header, Settings and Close vault in
 *  the vault menu and the app menu. */
export function AppShell() {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => {
    const path = menu?.path;
    setMenu(null);
    if (path) document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  }, [menu]);
  useGlobalShortcuts(menu !== null);
  useWindowTitle();
  useAutoLock();
  const current = useUiStore((s) => s.screen);
  const collapsed = useSettingsStore((s) => s.settings.sidebarCollapsed);
  return (
    <div className={styles.shell}>
      {!collapsed && (
        <Sidebar
          onRequestDelete={requestTrash}
          onRequestMenu={(path, anchor) => setMenu({ path, anchor })}
        />
      )}
      <div className={styles.main} data-screen={current} data-collapsed={collapsed || undefined}>
        {collapsed && (
          <button
            type="button"
            className={`${styles.iconButtonLight} ${styles.reopen}`}
            aria-label={t('shell.showSidebar')}
            data-sidebar-toggle
            aria-keyshortcuts="Meta+\ Control+\"
            title={t('shell.showSidebar')}
            onClick={toggleSidebar}
          >
            <SidebarIcon />
          </button>
        )}
        <main className={styles.content}>
          {/* The editor stays mounted while the Global View shows, so text,
              selection and undo survive switching (M3a §2). */}
          <div className={styles.screen} hidden={current !== 'edit'}>
            <PageView />
          </div>
          {current === 'global' && <GlobalView />}
          {current === 'trash' && <BinView />}
        </main>
        <ActionButton />
      </div>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      <DialogHost />
    </div>
  );
}
