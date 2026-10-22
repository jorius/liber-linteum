import { useEffect } from 'react';
import { pickFolder } from '../../ipc';
import { goBack, goForward } from '../../stores/navigate';
import { dirFor } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { refuseWhileConverting, useVaultStore } from '../../stores/vaultStore';
import { findableView, openFindInPage } from '../editor/findInPage';
import { useFavoritesStore } from '../favorites/favoritesStore';
import { openSearch } from '../search/searchMenu';
import { usePageStore } from '../../stores/pageStore';
import { toggleSidebar } from './shellMenu';

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

const MAC = /Mac/i.test(navigator.platform);

/** Outside macOS, Ctrl+F never opens the webview's own find bar (WebView2),
 *  also where Search doesn't open (a dialog, the Welcome screen; final review
 *  M12); nor does F3, find in page's next match (find in page). Returns the
 *  uninstall. */
export function installNoFindBar(mac = MAC): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (mac) return;
    if ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'f') || e.key === 'F3') {
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** ⌘F or ⌘⇧F (Ctrl+F, Ctrl+Shift+F), find in page or Search (M5 §4, M5b
 *  §7.3): the F key, or the physical one on layouts without a Latin F. */
export function isSearchKey(e: KeyboardEvent, mac = MAC): boolean {
  // On macOS only ⌘: Ctrl+F is "forward one character" in text (final review M12).
  if (!(mac ? e.metaKey : e.metaKey || e.ctrlKey) || e.altKey) return false;
  const key = e.key.toLowerCase();
  return key === 'f' || (!/^[a-z]$/.test(key) && e.code === 'KeyF');
}

/** Where the F key goes (find in page): `find` in the page while the editor
 *  shows one, `search` the vault-wide Search (⇧ always, and ⌘F anywhere
 *  else: the Global View, the Trash, no page open), `null` not the key. */
export function searchKeyTarget(
  e: KeyboardEvent,
  editorShowing: boolean,
  mac = MAC,
): 'find' | 'search' | null {
  if (!isSearchKey(e, mac)) return null;
  return editorShowing && !e.shiftKey ? 'find' : 'search';
}

/** ⌘F / Ctrl+F in a single-file window (no vault, no Search, no global
 *  shortcuts): find in the file. Returns the uninstall. */
export function installFindKey(mac = MAC): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (searchKeyTarget(e, findableView() !== null, mac) !== 'find') return;
    e.preventDefault();
    openFindInPage();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** ⌘ (macOS) / Ctrl shortcuts (spec §3.5): F find in page (Search outside
 * the editor) or ⇧F search, ⇧E explorer, O open vault,
 * J the floating button's actions and \ the sidebar (M5b §2.2, §2.5),
 * ⇧D Favorites (M5b §19), , settings, N new page ( ⇧N is New Quick Note since M4c §7.9, handled by
 * `ScratchpadHost`), [ / ] back and forward along the
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
      const find = searchKeyTarget(e, findableView() !== null);
      if (screen) {
        useUiStore.getState().setScreen(screen);
      } else if (find) {
        if (find === 'find') openFindInPage();
        else openSearch();
      } else if (key === ',') {
        useUiStore.getState().openDialog({ type: 'settings' });
      } else if (key === 'o' && !e.shiftKey) {
        if (refuseWhileConverting()) return;
        void pickFolder()
          .catch(() => null)
          .then((path) => (path ? vault.open(path) : undefined));
      } else if (key === 'n' && !e.shiftKey) {
        void vault.createPage(dirFor(vault.nodes, vault.selected));
      } else if (key === 'j' && !e.shiftKey) {
        // M5b §2.2: the floating button's actions.
        const ui = useUiStore.getState();
        // Closing from inside the group gives the keyboard to its button (final review M5).
        const inside = document.activeElement?.closest('[data-place]');
        ui.setActionsOpen(!ui.actionsOpen);
        if (ui.actionsOpen && inside) {
          inside.querySelector<HTMLElement>(':scope > button[aria-expanded]')?.focus();
        }
      } else if (
        // The D key, or where it sits on layouts without Latin letters (round-2 review M6).
        (key === 'd' || (!/^[a-z]$/.test(key) && e.code === 'KeyD')) &&
        e.shiftKey &&
        (!MAC || e.metaKey)
      ) {
        // M5b §19: the open page in or out of Favorites.
        const page = usePageStore.getState();
        const editing = useUiStore.getState().screen === 'edit';
        if (!editing || page.state !== 'ready' || !page.path) return;
        if (page.path.startsWith('.archive/')) return;
        // Pages only: Favorites doesn't show text files (round-2 review M7).
        if (vault.nodes.find((n) => n.path === page.path)?.kind !== 'page') return;
        void useFavoritesStore.getState().toggle(page.path);
      } else if ((e.key === '\\' || e.code === 'Backslash') && !e.shiftKey) {
        toggleSidebar(); // M5b §2.5
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
