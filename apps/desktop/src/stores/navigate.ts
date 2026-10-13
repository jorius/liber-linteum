import { isTauri, onMenuNavigate } from '../ipc';
import { usePageStore } from './pageStore';
import { useTrailStore, type TrailEntry } from './trailStore';
import { parentOf } from './tree';
import { useVaultStore } from './vaultStore';

/** How a page was reached (M2b §3): following an internal link adds the page
 *  you were on to the trail; a direct navigation (explorer, toast, ⌘O) starts
 *  a fresh trail; walking the trail itself changes nothing else. */
export type Via = 'link' | 'direct' | 'trail';

/** Opens a page the app just created (the watcher doesn't report our own
 *  writes, so the tree is refreshed first). */
export async function openNewPage(path: string, via: Via = 'direct'): Promise<void> {
  await useVaultStore.getState().refreshTree();
  await openPage(path, null, via);
}

/** Opens a page from anywhere (links, toasts): reveals and selects it in the
 *  explorer and shows it, scrolled to `heading` if given. */
export async function openPage(
  path: string,
  heading?: string | null,
  via: Via = 'direct',
): Promise<void> {
  const current = here();
  const trail = useTrailStore.getState();
  if (via === 'link') {
    if (current && current.path !== path) trail.followed(current);
  } else if (via === 'direct') {
    trail.reset();
  }
  const vault = useVaultStore.getState();
  const dir = parentOf(path);
  if (dir) vault.expand(dir);
  vault.select(path);
  await usePageStore.getState().load(path);
  usePageStore.getState().reveal(heading ?? null);
}

/** The page on screen and the heading it was opened at. */
function here(): TrailEntry | null {
  const { path, anchor } = usePageStore.getState();
  return path ? { path, heading: anchor?.heading ?? null } : null;
}

/** ← / ⌘[: back along the link trail. False when there is nowhere to go. */
export async function goBack(): Promise<boolean> {
  const current = here();
  if (!current) return false;
  const to = useTrailStore.getState().goBack(current);
  if (!to) return false;
  await openPage(to.path, to.heading, 'trail');
  return true;
}

/** ⌘]: forward along the link trail (after going back). */
export async function goForward(): Promise<boolean> {
  const current = here();
  if (!current) return false;
  const to = useTrailStore.getState().goForward(current);
  if (!to) return false;
  await openPage(to.path, to.heading, 'trail');
  return true;
}

/** Follows View → Back / Forward from the app menu; returns the unsubscribe. */
export async function installMenuNavigation(): Promise<() => void> {
  return onMenuNavigate((direction) => void (direction === 'back' ? goBack() : goForward()));
}

export function installMenuNavigationIfTauri(): void {
  if (isTauri()) void installMenuNavigation().catch(() => undefined);
}
