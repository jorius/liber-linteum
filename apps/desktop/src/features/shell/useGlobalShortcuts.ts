import { useEffect } from 'react';
import { pickFolder } from '../../ipc';
import { dirFor } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

/** ⌘ (macOS) / Ctrl shortcuts (spec §3.5): ⇧E explorer, O open vault,
 * , settings, N new page, ⇧N new folder. Ignored while a dialog is open. */
export function useGlobalShortcuts(menuOpen: boolean) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (menuOpen || useUiStore.getState().dialog) return;
      const vault = useVaultStore.getState();
      const key = e.key.toLowerCase();
      if (key === ',') {
        useUiStore.getState().openDialog({ type: 'settings' });
      } else if (key === 'o' && !e.shiftKey) {
        void pickFolder()
          .catch(() => null)
          .then((path) => (path ? vault.open(path) : undefined));
      } else if (key === 'n') {
        const dir = dirFor(vault.nodes, vault.selected);
        void (e.shiftKey ? vault.createFolder(dir) : vault.createPage(dir));
      } else if (key === 'e' && e.shiftKey) {
        document
          .querySelector<HTMLElement>('[role="tree"] [role="treeitem"][tabindex="0"]')
          ?.focus();
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);
}
