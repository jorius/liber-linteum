import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { fakeDisk } from '../../test/fakeDisk';
import { RelationsDialog } from './RelationsDialog';

/** `[[X]]` resolves to `X.md`; the shortest target is the stem. */
const extra = {
  link_target: (a: Record<string, unknown>) => String(a.target).replace(/\.md$/, ''),
  links_resolve: (a: Record<string, unknown>) =>
    (a.targets as { target: string }[]).map((t) => `${t.target}.md`),
};

afterEach(() => {
  resetEditorStore();
  clearMocks();
});

describe('relationships dialog (M3b §3)', () => {
  it('lists a page’s relationships; a label and an arrow are saved to its frontmatter', async () => {
    const disk = fakeDisk(
      {
        'A.md': '---\nrelated:\n  - "[[B]]"\n  - { link: "[[C]]", label: old }\n---\n# A\n',
        'B.md': '# B\n',
        'C.md': '# C\n',
      },
      extra,
    );
    render(<RelationsDialog page="A.md" onClose={vi.fn()} />);
    const b = await screen.findByRole('group', { name: 'A → B' });
    expect(within(screen.getByRole('group', { name: 'A → C' })).getByRole('textbox')).toHaveValue(
      'old',
    );
    const save = within(b).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(within(b).getByRole('textbox', { name: 'Label' }), 'inspired by');
    await userEvent.click(within(b).getByRole('checkbox', { name: 'Arrow to B' }));
    await userEvent.click(save);
    await waitFor(() =>
      expect(disk.files.get('A.md')).toBe(
        '---\nrelated:\n  - { link: "[[B]]", label: inspired by, directed: true }\n  - { link: "[[C]]", label: old }\n---\n# A\n',
      ),
    );
  });

  it('deleting removes it from the page and from the list', async () => {
    const disk = fakeDisk(
      { 'A.md': '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\n', 'B.md': '', 'C.md': '' },
      extra,
    );
    render(<RelationsDialog page="A.md" onClose={vi.fn()} />);
    const c = await screen.findByRole('group', { name: 'A → C' });
    await userEvent.click(within(c).getByRole('button', { name: 'Delete relationship' }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'A → C' })).not.toBeInTheDocument(),
    );
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n');
    // The keyboard stays in the dialog.
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
  });

  it('between two cards: both pages’ relationships to each other, nothing else', async () => {
    fakeDisk(
      {
        'A.md': '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\n',
        'B.md': '---\nrelated:\n  - { link: "[[A]]", directed: true }\n---\n',
        'C.md': '',
      },
      extra,
    );
    render(<RelationsDialog page="A.md" other="B.md" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Relationships between A and B' })).toBeVisible();
    await screen.findByRole('group', { name: 'A → B' });
    expect(screen.getByRole('group', { name: 'B → A' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'A → C' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'B → A' })).getByRole('checkbox', {
        name: 'Arrow to A',
      }),
    ).toBeChecked();
  });

  it('a save or delete refused because the list changed on disk re-reads it (§10.7, final review m5)', async () => {
    const disk = fakeDisk(
      { 'A.md': '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\n', 'B.md': '', 'C.md': '' },
      extra,
    );
    render(<RelationsDialog page="A.md" onClose={vi.fn()} />);
    const b = await screen.findByRole('group', { name: 'A → B' });
    // Another app takes B out (C moves up) while the dialog is open.
    disk.files.set('A.md', '---\nrelated:\n  - "[[C]]"\n  - "[[D]]"\n---\n');
    await userEvent.type(within(b).getByRole('textbox', { name: 'Label' }), 'x');
    await userEvent.click(within(b).getByRole('button', { name: 'Save' }));
    await screen.findByRole('group', { name: 'A → D' });
    expect(screen.queryByRole('group', { name: 'A → B' })).not.toBeInTheDocument();
    expect(disk.writes()).toEqual([]);
    // The row the keyboard was on is gone: it stays in the dialog.
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    disk.files.set('A.md', '---\nrelated:\n  - "[[D]]"\n---\n');
    const c = screen.getByRole('group', { name: 'A → C' });
    await userEvent.click(within(c).getByRole('button', { name: 'Delete relationship' }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'A → C' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('group', { name: 'A → D' })).toBeVisible();
    expect(disk.writes()).toEqual([]);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  });

  it('a page without any says how to add one; no axe violations', async () => {
    fakeDisk({ 'A.md': '# A\n' }, extra);
    render(<RelationsDialog page="A.md" onClose={vi.fn()} />);
    expect(
      await screen.findByText('No relationships yet. Use “Connect to…” on a card to add one.'),
    ).toBeVisible();
    const violations = await axe
      .run(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
