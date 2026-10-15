import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { useToastStore } from '../../stores/toastStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { installScratchpadSync, useScratchpadStore } from './scratchpadStore';

type Handler = (args: Record<string, unknown>) => unknown;

function backend(handlers: Record<string, Handler>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push([cmd, a]);
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const report = { pages: 0, warnings: [] };
const vault = { name: 'Worlds', root: '/v/Worlds', report, scratchpad: false };
const scratch = { name: 'Scratchpad', root: '/d/Scratchpad', report, scratchpad: true };
const tree: TreeNode[] = [
  { path: 'Scratchpad', kind: 'folder' },
  { path: 'Scratchpad/Quick note 1.md', kind: 'page' },
];

let stop: () => void = () => undefined;

beforeEach(() => {
  usePageStore.getState().clear();
  useToastStore.getState().clear();
  stop = installScratchpadSync();
});

afterEach(async () => {
  stop();
  await resetVaultStore();
  useScratchpadStore.getState().reset();
  clearMocks();
});

describe('the Scratchpad vault (M4c §2)', () => {
  it('opens through scratchpad_open with no path and is named "Quick notes"', async () => {
    const calls = backend({
      scratchpad_open: () => scratch,
      vault_tree: () => [],
      quick_notes_state: () => ({ folder: null, autoNamed: [] }),
    });
    const res = await useVaultStore.getState().openScratchpad();
    expect(res.ok).toBe(true);
    const s = useVaultStore.getState();
    expect(s.status).toBe('open');
    expect(s.info?.name).toBe('Quick notes');
    expect(s.info?.scratchpad).toBe(true);
    expect(calls.find(([c]) => c === 'scratchpad_open')?.[1]).toEqual({});
  });

  it('an ordinary vault keeps its own name', async () => {
    backend({
      vault_open: () => vault,
      vault_tree: () => [],
      quick_notes_state: () => ({ folder: 'Scratchpad', autoNamed: [] }),
    });
    await useVaultStore.getState().open('/v/Worlds');
    expect(useVaultStore.getState().info?.name).toBe('Worlds');
  });
});

describe('scratchpadStore', () => {
  it('loads the scratch folder and the auto-named notes when a vault opens, and clears on close', async () => {
    backend({
      vault_open: () => vault,
      vault_tree: () => tree,
      vault_close: () => null,
      quick_notes_state: () => ({
        folder: 'Scratchpad',
        autoNamed: ['Scratchpad/Quick note 1.md'],
      }),
    });
    await useVaultStore.getState().open('/v/Worlds');
    await expect.poll(() => useScratchpadStore.getState().folder).toBe('Scratchpad');
    expect([...useScratchpadStore.getState().autoNamed]).toEqual(['Scratchpad/Quick note 1.md']);
    useScratchpadStore.getState().moved('Scratchpad/Quick note 1.md', 'Scratchpad/Trip.md');
    expect([...useScratchpadStore.getState().autoNamed]).toEqual(['Scratchpad/Trip.md']);
    useScratchpadStore.getState().drop('Scratchpad/Trip.md');
    expect(useScratchpadStore.getState().autoNamed.size).toBe(0);
    await useVaultStore.getState().close();
    await expect.poll(() => useScratchpadStore.getState().folder).toBeNull();
  });

  it('a backend without quick notes leaves the store empty', async () => {
    backend({ vault_open: () => vault, vault_tree: () => [] });
    await useVaultStore.getState().open('/v/Worlds');
    expect(useScratchpadStore.getState().folder).toBeNull();
    expect(useScratchpadStore.getState().autoNamed.size).toBe(0);
  });
});

describe('vaultStore.applyRename (shared by rename and the auto-name)', () => {
  it('follows the selection and the tree, and stays quiet about links when asked', async () => {
    let nodes: TreeNode[] = [{ path: 'Q.md', kind: 'page' }];
    backend({
      vault_open: () => vault,
      vault_tree: () => nodes,
      quick_notes_state: () => ({ folder: 'Scratchpad', autoNamed: [] }),
    });
    await useVaultStore.getState().open('/v/Worlds');
    useVaultStore.getState().select('Q.md');
    nodes = [{ path: 'Trip.md', kind: 'page' }];
    const outcome = {
      moved: [['Q.md', 'Trip.md']] as [string, string][],
      updatedFiles: ['Other.md'],
      updatedLinks: 1,
      failed: [],
    };
    await useVaultStore.getState().applyRename('Q.md', 'Trip.md', outcome, { quiet: true });
    expect(useVaultStore.getState().selected).toBe('Trip.md');
    expect(useVaultStore.getState().nodes.map((n) => n.path)).toEqual(['Trip.md']);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    await useVaultStore.getState().applyRename('Trip.md', 'Trip 2.md', outcome);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
