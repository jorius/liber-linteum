// E4 final review: every module-level holder of a vault's text, paths or
// titles registers to be emptied when the vault's UI goes.
import { expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => [] as string[]);
vi.mock('./leaveVault', () => ({
  onLeaveVault: () => void registered.push(new Error().stack ?? ''),
  clearVaultCaches: () => undefined,
}));

it.each([
  ['linkComplete.ts', () => import('../features/editor/linkComplete')],
  ['livePreview.ts', () => import('../features/editor/livePreview')],
  ['spell.ts', () => import('../features/editor/spell')],
  ['MermaidView.tsx', () => import('../features/preview/MermaidView')],
  ['pageModel.ts', () => import('../features/editor/pageModel')],
  ['blockCommands.ts', () => import('../features/editor/blockCommands')],
  ['ItemIcon.tsx', () => import('../features/icons/ItemIcon')],
  ['gvStore.ts', () => import('../features/global-view/gvStore')],
])('%s registers its cache', async (file, load) => {
  await load();
  expect(registered.some((stack) => stack.includes(file))).toBe(true);
});
