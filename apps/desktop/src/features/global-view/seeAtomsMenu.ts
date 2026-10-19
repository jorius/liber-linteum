// View → See Atoms of This Page (M4b part 3 §6): the menu says `atoms` on
// `menu:screen`; the Global View (not the stores layer) answers it.
import { isTauri, onMenuScreen } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { isTextPath } from '../../stores/textFiles';
import { nameOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useGvStore } from './gvStore';

/** The open page's atoms in the Global View; nothing without an open
 *  Markdown page. */
export function seeOpenPageAtoms(): void {
  const { path, page } = usePageStore.getState();
  if (!path || isTextPath(path)) return;
  useGvStore.getState().seeAtoms(path, page?.title ?? nameOf(path).replace(/\.md$/i, ''));
  useUiStore.getState().setScreen('global');
}

/** Follows the menu item; returns the unsubscribe. */
export async function installSeeAtomsMenu(): Promise<() => void> {
  return onMenuScreen((screen) => {
    if (screen === 'atoms') seeOpenPageAtoms();
  });
}

export function installSeeAtomsMenuIfTauri(): void {
  if (!isTauri()) return;
  void installSeeAtomsMenu().catch(() => undefined);
}
