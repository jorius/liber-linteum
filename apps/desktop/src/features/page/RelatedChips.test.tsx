import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';

const open = (path: string) => act(() => usePageStore.getState().load(path));

/** Link targets, resolution and suggestions as the backend answers them. */
const backend = (pages: string[]) => ({
  link_target: (a: Record<string, unknown>) => String(a.target).replace(/\.md$/, ''),
  links_resolve: (a: Record<string, unknown>) =>
    (a.targets as { target: string }[]).map((t) =>
      pages.includes(`${t.target}.md`) ? `${t.target}.md` : null,
    ),
  link_suggest: (a: Record<string, unknown>) =>
    pages
      .filter((p) => p.toLowerCase().includes(String(a.query).toLowerCase()))
      .map((p) => ({ path: p, kind: 'page', title: p.replace(/\.md$/, ''), target: p })),
});

const related = () => screen.getByRole('list', { name: 'Related pages' });

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
  useToastStore.getState().clear();
});
afterEach(async () => {
  usePageStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

describe('Related chips in the header band (M4b §6)', () => {
  it('lists the page’s own relationships; a chip opens its page; directed ones show →', async () => {
    fakeDisk(
      {
        'A.md':
          '---\nrelated:\n  - "[[B]]"\n  - { link: "[[C]]", label: rival, directed: true }\n---\n# A\n',
        'B.md': '# B\n',
        'C.md': '# C\n',
      },
      backend(['A.md', 'B.md', 'C.md']),
    );
    render(<PageScreen />);
    await open('A.md');
    const list = await screen.findByRole('list', { name: 'Related pages' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    const c = within(list).getByRole('button', { name: 'C →' });
    expect(c).toHaveAttribute('title', 'rival');
    await userEvent.click(within(list).getByRole('button', { name: 'B' }));
    await waitFor(() => expect(usePageStore.getState().path).toBe('B.md'));
  });

  it('× removes a relationship from the frontmatter', async () => {
    const disk = fakeDisk(
      { 'A.md': '---\nrelated:\n  - "[[B]]"\n---\n# A\n', 'B.md': '# B\n' },
      backend(['A.md', 'B.md']),
    );
    render(<PageScreen />);
    await open('A.md');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove the relationship to B' }),
    );
    await waitFor(() => expect(disk.files.get('A.md')).toBe('# A\n'));
    await waitFor(() => expect(within(related()).queryAllByRole('listitem')).toHaveLength(0));
  });

  it('+ Related page picks a page and relates it', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n', 'Beta.md': '# Beta\n' }, backend(['A.md', 'Beta.md']));
    render(<PageScreen />);
    await open('A.md');
    await userEvent.click(await screen.findByRole('button', { name: 'Add a related page' }));
    const field = screen.getByRole('combobox', { name: 'Related page' });
    expect(field).toHaveFocus();
    await userEvent.type(field, 'bet');
    await userEvent.click(await screen.findByRole('option', { name: /Beta/ }));
    await waitFor(() =>
      expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[Beta]]"\n---\n# A\n'),
    );
    await waitFor(() =>
      expect(within(related()).getByRole('button', { name: 'Beta' })).toBeInTheDocument(),
    );
  });

  it('an unresolved target shows muted, not clickable; no axe violations', async () => {
    fakeDisk({ 'A.md': '---\nrelated:\n  - "[[Gone]]"\n---\n# A\n' }, backend(['A.md']));
    render(<PageScreen />);
    await open('A.md');
    const list = await screen.findByRole('list', { name: 'Related pages' });
    await waitFor(() => expect(within(list).getByText('Gone')).toBeInTheDocument());
    expect(within(list).queryByRole('button', { name: 'Gone' })).not.toBeInTheDocument();
    expect(within(list).getByText('Gone').closest('li')).toHaveAttribute('title', 'Not found');
    const violations = await axe
      .run(list, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
