import { useCallback, useState } from 'react';
import { DialogHost } from '../dialogs/DialogHost';
import { ContextMenu, type MenuState } from '../explorer/ContextMenu';
import { requestDelete } from '../explorer/deleteFlow';
import { GlobalView } from '../global-view/GlobalView';
import { PageView } from '../page/PageView';
import { useUiStore } from '../../stores/uiStore';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useGlobalShortcuts } from './useGlobalShortcuts';
import styles from './Shell.module.css';

/** The open-vault layout (spec §3.4): sidebar explorer + top bar + page view,
 * plus the context menu, dialogs and global shortcuts. */
export function AppShell() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => {
    const path = menu?.path;
    setMenu(null);
    if (path) document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  }, [menu]);
  useGlobalShortcuts(menu !== null);
  const current = useUiStore((s) => s.screen);
  return (
    <div className={styles.shell}>
      <Sidebar
        onRequestDelete={requestDelete}
        onRequestMenu={(path, anchor) => setMenu({ path, anchor })}
      />
      <div className={styles.main}>
        <TopBar />
        <main className={styles.content}>
          {/* The editor stays mounted while the Global View shows, so text,
              selection and undo survive switching (M3a §2). */}
          <div className={styles.screen} hidden={current !== 'edit'}>
            <PageView />
          </div>
          {current === 'global' && <GlobalView />}
        </main>
      </div>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      <DialogHost />
    </div>
  );
}
