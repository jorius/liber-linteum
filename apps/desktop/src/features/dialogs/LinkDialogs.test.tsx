import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { CreatePageDialog, createTarget } from './LinkDialogs';

function disk(folders: string[] = []) {
  const made: string[] = [];
  const d = fakeDisk(
    { 'Projects/P.md': '# P\n' },
    {
      entry_create_folder: (args) => {
        const path = args.parent ? `${args.parent}/${args.name}` : String(args.name);
        made.push(path);
        return path;
      },
    },
  );
  useVaultStore.setState({
    info: { name: 'Vault', root: '/v', report: {} as never },
    nodes: [
      { path: 'Projects', kind: 'folder' },
      { path: 'Projects/P.md', kind: 'page' },
      ...folders.map((path) => ({ path, kind: 'folder' as const })),
    ],
  });
  return { d, made };
}

beforeEach(() => usePageStore.getState().clear());
afterEach(async () => {
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

describe('createTarget (M2c §7.6)', () => {
  const folders = new Set(['A', 'Projects']);
  it('targets with / start at the vault root and list the folders to create', () => {
    expect(createTarget('Projects/P.md', 'Ideas/New idea', folders)).toEqual({
      dir: 'Ideas',
      name: 'New idea',
      missing: ['Ideas'],
    });
    expect(createTarget('Projects/P.md', 'A/B/C.md', folders)).toEqual({
      dir: 'A/B',
      name: 'C',
      missing: ['A/B'],
    });
    expect(createTarget('Projects/P.md', '/Root page', folders)).toEqual({
      dir: '',
      name: 'Root page',
      missing: [],
    });
  });

  it('a bare name keeps M2a: next to the linking page', () => {
    expect(createTarget('Projects/P.md', 'Plain', folders)).toEqual({
      dir: 'Projects',
      name: 'Plain',
      missing: [],
    });
  });
});

describe('CreatePageDialog (M2c §7.6)', () => {
  it('creates the missing folders, then the page, and opens it', async () => {
    const { d, made } = disk();
    render(<CreatePageDialog source="Projects/P.md" target="Ideas/New idea" onClose={() => {}} />);
    expect(
      screen.getByRole('dialog', { name: 'Create page “New idea” in Ideas/?' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() => expect(usePageStore.getState().path).toBe('Ideas/New idea.md'));
    expect(made).toEqual(['Ideas']);
    expect(d.files.has('Ideas/New idea.md')).toBe(true);
  });

  it('creates only the folders that are missing, outermost first', async () => {
    const { made } = disk(['A']);
    render(<CreatePageDialog source="Projects/P.md" target="A/B/C/Leaf" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() => expect(usePageStore.getState().path).toBe('A/B/C/Leaf.md'));
    expect(made).toEqual(['A/B', 'A/B/C']);
  });

  it('an unusable folder name is explained and nothing is created', async () => {
    const { d } = disk();
    render(<CreatePageDialog source="Projects/P.md" target="Bad:Name/x" onClose={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('“Bad:Name” can’t be used as a name');
    expect(screen.getByRole('button', { name: 'Create page' })).toBeDisabled();
    expect(d.calls.some(([c]) => c.startsWith('entry_create'))).toBe(false);
  });
});
