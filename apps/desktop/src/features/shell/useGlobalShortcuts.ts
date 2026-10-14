import { useEffect } from 'react';
import { pickFolder } from '../../ipc';
import { goBack, goForward } from '../../stores/navigate';
import { dirFor } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';

/** Keys a layout may put where US keyboards have [ and ]; any other plain
 *  character there (Dvorak's / and =) keeps its own meaning. */
const SHORTCUT_CHAR = /^[a-z0-9/=\-,.;']$/i;

/** ⌘[ / ⌘] along the link trail, on any layout (final review m5): the key
 *  that types [ / ], with or without ⌥ (Spanish, German and French Macs need
 *  ⌥ to type brackets), or ⌘ + the physical key where US keyboards have them
 *  (German ⌘ü, French dead ^). Ctrl+Alt is AltGr on Windows/Linux — typing a
 *  bracket there must stay typing. */
function trailKey(e: KeyboardEvent): 'back' | 'forward' | null {
  if (e.shiftKey || (e.altKey && !e.metaKey)) return null;
  const byCode = e.metaKey && !SHORTCUT_CHAR.test(e.key);
  if (e.key === '[' || (byCode && e.code === 'BracketLeft')) return 'back';
  if (e.key === ']' || (byCode && e.code === 'BracketRight')) return 'forward';
  return null;
}

/** ⌘1 Edit, ⌘2 Global View (M3a §2): the digit key, or the physical one
 *  on layouts where digits need ⇧ (French). */
function screenKey(e: KeyboardEvent): 'edit' | 'global' | null {
  if (e.key === '1' || (e.shiftKey && e.code === 'Digit1')) return 'edit';
  if (e.key === '2' || (e.shiftKey && e.code === 'Digit2')) return 'global';
  return null;
}

/** ⌘ (macOS) / Ctrl shortcuts (spec §3.5): ⇧E explorer, O open vault,
 * , settings, N new page, ⇧N new folder, [ / ] back and forward along the
 * link trail (M2b §3), 1 / 2 Edit and Global View (M3a §2). Ignored while a
 * dialog is open. */
export function useGlobalShortcuts(menuOpen: boolean) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (menuOpen || useUiStore.getState().dialog) return;
      const trail = trailKey(e);
      if (trail) {
        e.preventDefault();
        void (trail === 'back' ? goBack() : goForward());
        return;
      }
      if (e.altKey) return;
      const vault = useVaultStore.getState();
      const key = e.key.toLowerCase();
      const screen = screenKey(e);
      if (screen) {
        useUiStore.getState().setScreen(screen);
      } else if (key === ',') {
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
