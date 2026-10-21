import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { TreeNode, VaultInfo } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { childrenByParent } from '../../stores/tree';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from '../editor/Editor';
import { PageDoc } from '../editor/pageDoc';
import { ExplorerTree } from '../explorer/ExplorerTree';
import { useFavoritesStore } from '../favorites/favoritesStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';

const CANARY = 'Canary-7f3a';
const nodes: TreeNode[] = [{ path: `${CANARY}.md`, kind: 'page' }];
const info = { name: 'enc', root: '/enc', encrypted: true } as VaultInfo;

afterEach(async () => {
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
  localStorage.clear();
});

/** E4 §16: nothing in the UI's own storage names a page of an encrypted vault. */
describe('no_canary_in_localStorage', () => {
  it('holds no entry naming the page after it is favourited, collapsed and outlined', async () => {
    mockIPC((cmd) => (cmd === 'favorites_get' ? [`${CANARY}.md`] : null));
    useVaultStore.setState({
      status: 'open',
      info,
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(),
      selected: null,
      renaming: null,
    });
    const { unmount } = render(<ExplorerTree />);
    const section = await screen.findByRole('region', { name: 'Favorites' });
    expect(useFavoritesStore.getState().paths).toEqual([`${CANARY}.md`]);
    const heading = within(section).getByRole('button', { name: 'Favorites' });
    await userEvent.click(heading);
    // Still collapsed for the session, with nothing written.
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    unmount();
    clearMocks();

    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, outline: true } });
    fakeDisk({ [`${CANARY}.md`]: `# ${CANARY}\n\nBody.\n` });
    const res = await PageDoc.load(`${CANARY}.md`, {
      onChange: () => undefined,
      onConflictCopy: () => undefined,
    });
    if (!res.ok) throw new Error(res.error.message);
    render(<Editor doc={res.value} mode="livePreview" label={CANARY} />);
    const edge = screen.getByRole('separator', { name: 'Outline width' });
    edge.focus();
    await userEvent.keyboard('{ArrowLeft}');

    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      all.push(k, localStorage.getItem(k) ?? '');
    }
    expect(all.join('\n')).not.toContain(CANARY);
    expect(all.join('\n')).not.toContain('/enc');
  });

  it('an encrypted vault never reads the Favorites collapse key, and drops a stale one', async () => {
    // Left by an earlier session when the vault was still plain.
    localStorage.setItem('liber.favoritesCollapsed:/enc', '1');
    mockIPC((cmd) => (cmd === 'favorites_get' ? [`${CANARY}.md`] : null));
    useVaultStore.setState({
      status: 'open',
      info,
      nodes,
      children: childrenByParent(nodes),
      expanded: new Set(),
      selected: null,
      renaming: null,
    });
    render(<ExplorerTree />);
    const section = await screen.findByRole('region', { name: 'Favorites' });
    expect(within(section).getByRole('button', { name: 'Favorites' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(localStorage.getItem('liber.favoritesCollapsed:/enc')).toBeNull();
  });
});
