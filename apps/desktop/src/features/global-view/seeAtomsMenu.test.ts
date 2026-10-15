import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { usePageStore } from '../../stores/pageStore';
import { useUiStore } from '../../stores/uiStore';
import { useGvStore } from './gvStore';
import { installSeeAtomsMenu } from './seeAtomsMenu';

beforeEach(() => {
  mockIPC(() => null, { shouldMockEvents: true });
  useUiStore.setState({ screen: 'edit' });
  useGvStore.getState().reset();
  usePageStore.setState({ path: null, page: null });
});
afterEach(() => clearMocks());

describe('View → See Atoms of This Page (M4b part 3 §6)', () => {
  it("shows the open page's atoms in the Global View; nothing without a Markdown page", async () => {
    const stop = await installSeeAtomsMenu();
    await emit('menu:screen', 'atoms');
    await new Promise((r) => setTimeout(r, 10));
    expect(useUiStore.getState().screen).toBe('edit');
    expect(useGvStore.getState().atoms).toBeNull();
    // A text file has no atoms either.
    usePageStore.setState({ path: 'notes.txt', page: null });
    await emit('menu:screen', 'atoms');
    await new Promise((r) => setTimeout(r, 10));
    expect(useGvStore.getState().atoms).toBeNull();
    usePageStore.setState({ path: 'Folder/Rex.md', page: null });
    await emit('menu:screen', 'atoms');
    await vi.waitFor(() => expect(useUiStore.getState().screen).toBe('global'));
    expect(useGvStore.getState().atoms).toEqual({ path: 'Folder/Rex.md', title: 'Rex' });
    // The other screens are the stores' (menuToggles.ts).
    await emit('menu:screen', 'edit');
    await new Promise((r) => setTimeout(r, 10));
    expect(useUiStore.getState().screen).toBe('global');
    stop();
  });
});
