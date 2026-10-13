import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../ipc/testing';
import { followLink } from './links';
import { goBack, goForward, installMenuNavigation, openPage } from './navigate';
import { usePageStore } from './pageStore';
import { useTrailStore } from './trailStore';
import { resetVaultStore } from './vaultStore';

const page = (path: string) => ({
  path,
  title: path.replace(/\.md$/, ''),
  subtitle: null,
  cover: null,
  tags: [],
  links: 0,
  backlinks: 0,
  text: '',
  truncated: false,
  binary: false,
});

beforeEach(() => {
  useTrailStore.getState().reset();
  mockIPC(
    (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (cmd === 'page_get') return page(args.path as string);
      if (cmd === 'page_read') return { text: '', hash: 'h' };
      return null;
    },
    { shouldMockEvents: true },
  );
});
afterEach(async () => {
  usePageStore.getState().clear();
  await resetVaultStore();
  clearMocks();
});

const at = () => usePageStore.getState().path;

describe('navigation and the link trail (M2b §3)', () => {
  it('links add to the trail; direct opens start a fresh one; back/forward walk it', async () => {
    await openPage('A.md');
    await openPage('B.md', null, 'link');
    await openPage('C.md', 'Part', 'link');
    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['A.md', 'B.md']);
    await goBack();
    expect(at()).toBe('B.md');
    await goBack();
    expect(at()).toBe('A.md');
    expect(await goBack()).toBe(false);
    await goForward();
    await goForward();
    expect(at()).toBe('C.md');
    expect(usePageStore.getState().anchor?.heading).toBe('Part');
    await openPage('D.md');
    expect(useTrailStore.getState().back).toEqual([]);
  });

  it('a link to the page you are on does not grow the trail', async () => {
    await openPage('A.md');
    await openPage('A.md', 'Heading', 'link');
    expect(useTrailStore.getState().back).toEqual([]);
  });

  it('followLink is a link navigation', async () => {
    await openPage('A.md');
    followLink({
      type: 'page',
      kind: 'wiki',
      target: 'B',
      heading: null,
      resolved: 'B.md',
      source: 'A.md',
    });
    await vi.waitFor(() => expect(at()).toBe('B.md'));
    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['A.md']);
  });

  it('View → Back / Forward in the app menu walk the trail (menu:navigate)', async () => {
    const stop = await installMenuNavigation();
    await openPage('A.md');
    await openPage('B.md', null, 'link');
    await emit('menu:navigate', 'back');
    await vi.waitFor(() => expect(at()).toBe('A.md'));
    await emit('menu:navigate', 'forward');
    await vi.waitFor(() => expect(at()).toBe('B.md'));
    stop();
  });
});
