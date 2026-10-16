import { confirmUnsaved, needsUnsavedPrompt } from '../features/editor/unsavedPrompt';
import { fileFollow, fileWindowName, isTauri, onMenuNavigate } from '../ipc';
import { errorMessage } from './messages';
import { usePageStore } from './pageStore';
import { useToastStore } from './toastStore';
import { useTrailStore, type TrailEntry } from './trailStore';
import { useUiStore } from './uiStore';
import { parentOf } from './tree';
import { useVaultStore } from './vaultStore';

/** How a page was reached (M2b §3): following an internal link adds the page
 *  you were on to the trail; a direct navigation (explorer, toast, ⌘O) starts
 *  a fresh trail; walking the trail itself changes nothing else. */
export type Via = 'link' | 'direct' | 'trail';

/** Opens a page the app just created (the watcher doesn't report our own
 *  writes, so the tree is refreshed first). */
export async function openNewPage(path: string, via: Via = 'direct'): Promise<void> {
  // A single-file window's file written again ("Save again"): shown already.
  if (fileWindowName() !== null) return;
  await useVaultStore.getState().refreshTree();
  await openPage(path, null, via);
}

/** Opens a page from anywhere (links, toasts): reveals and selects it in the
 *  explorer and shows it, scrolled to `heading` if given. In a single-file
 *  window (M4c §3) another file opens in a window of its own. */
export async function openPage(
  path: string,
  heading?: string | null,
  via: Via = 'direct',
): Promise<void> {
  const own = fileWindowName();
  if (own !== null) {
    if (path === own) {
      usePageStore.getState().reveal(heading ?? null);
      return;
    }
    const res = await fileFollow(path);
    if (!res.ok) {
      useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
    }
    return;
  }
  // Ask before anything moves: Cancel leaves the screen, selection and trail
  // as they were (M5b final review M1).
  if (!(await mayLeaveFor(path))) return;
  const current = here();
  const trail = useTrailStore.getState();
  if (via === 'link') {
    if (current && current.path !== path) trail.followed(current);
  } else if (via === 'direct') {
    trail.reset();
  }
  // Wherever it was opened from (Global View, explorer), the page is shown.
  useUiStore.getState().setScreen('edit');
  const vault = useVaultStore.getState();
  const dir = parentOf(path);
  if (dir) vault.expand(dir);
  vault.select(path);
  await usePageStore.getState().load(path);
  usePageStore.getState().reveal(heading ?? null);
}

/** Opens a page with the cursor on `from` and `from`–`to` flashing (an atom
 *  in the Global View, M4b part 3 §6). */
export async function openPageAt(path: string, from: number, to: number): Promise<void> {
  await openPage(path);
  usePageStore.getState().requestJump(path, from, to);
}

/** With auto save off and text unsaved, leaving the page asks first. */
async function mayLeaveFor(path: string | null): Promise<boolean> {
  if (path === usePageStore.getState().path || !needsUnsavedPrompt()) return true;
  return confirmUnsaved();
}

/** The page on screen and the heading it was opened at. */
function here(): TrailEntry | null {
  const { path, anchor } = usePageStore.getState();
  return path ? { path, heading: anchor?.heading ?? null } : null;
}

/** ← / ⌘[: back along the link trail. False when there is nowhere to go. */
export async function goBack(): Promise<boolean> {
  const current = here();
  if (!current || !useTrailStore.getState().back.length) return false;
  if (!(await mayLeaveFor(null))) return false;
  const to = useTrailStore.getState().goBack(current);
  if (!to) return false;
  await openPage(to.path, to.heading, 'trail');
  return true;
}

/** ⌘]: forward along the link trail (after going back). */
export async function goForward(): Promise<boolean> {
  const current = here();
  if (!current || !useTrailStore.getState().forward.length) return false;
  if (!(await mayLeaveFor(null))) return false;
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
