// Round 3 §3.2: the Move dialog is a folder tree — expand and collapse,
// type to filter, the tree's keys — instead of a flat list of full paths.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { MoveToDialog } from './MoveToDialog';

const nodes = [
  { path: 'Cyber', kind: 'folder', icon: '🛡️' },
  { path: 'Cyber/Linux', kind: 'folder' },
  { path: 'Cyber/Linux/File Descriptors.md', kind: 'page' },
  { path: 'Cyber/Networking', kind: 'folder' },
  { path: 'Cyber/Networking/Subnetting', kind: 'folder' },
  { path: 'Cyber/Networking/Subnetting/Deep', kind: 'folder' },
  { path: 'Notes', kind: 'folder' },
  { path: '.archive', kind: 'folder' },
  { path: '.archive/Old', kind: 'folder' },
  { path: 'Report.md', kind: 'page' },
];

let rename: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rename = vi.fn(async () => ({ ok: true, value: undefined }));
  useVaultStore.setState({ nodes, rename } as never);
});
afterEach(() => resetVaultStore());

const tree = () => screen.getByRole('tree', { name: 'Destination folder' });
const row = (name: string | RegExp) =>
  within(tree()).getByRole('treeitem', {
    name: typeof name === 'string' ? new RegExp(`^${name}`) : name,
  });
const names = () =>
  within(tree())
    .getAllByRole('treeitem')
    .map((r) => r.getAttribute('data-path'));

describe('Move dialog folder tree (round 3 §3.2)', () => {
  it('shows the vault root and folders as a tree, with the current folder opened and marked', () => {
    render(<MoveToDialog path="Cyber/Linux/File Descriptors.md" onClose={vi.fn()} />);
    // Root and the current folder's ancestors are open; Networking is closed.
    expect(names()).toEqual(['', 'Cyber', 'Cyber/Linux', 'Cyber/Networking', 'Notes']);
    expect(row('Vault root')).toHaveAttribute('aria-level', '1');
    expect(row('Cyber')).toHaveAttribute('aria-level', '2');
    expect(row('Cyber')).toHaveAttribute('aria-expanded', 'true');
    expect(row('Networking')).toHaveAttribute('aria-expanded', 'false');
    expect(row('Notes')).not.toHaveAttribute('aria-expanded');
    // Where it is now: marked, not a target.
    expect(row(/^Linux.*current/i)).toHaveAttribute('aria-disabled', 'true');
    // The folder's emoji shows; the Archive and Trash aren't targets.
    expect(row('Cyber')).toHaveTextContent('🛡️');
    expect(names()).not.toContain('.archive');
  });

  it("leaves out a folder's own subtree when moving the folder", () => {
    render(<MoveToDialog path="Cyber/Networking" onClose={vi.fn()} />);
    expect(names()).toEqual(['', 'Cyber', 'Cyber/Linux', 'Notes']);
    expect(row(/^Cyber.*current/i)).toHaveAttribute('aria-disabled', 'true');
  });

  it('a click picks the folder and Move moves there', async () => {
    const onClose = vi.fn();
    render(<MoveToDialog path="Report.md" onClose={onClose} />);
    const move = screen.getByRole('button', { name: 'Move' });
    expect(move).toBeDisabled();
    await userEvent.click(row('Notes'));
    expect(row('Notes')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(move);
    expect(onClose).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith('Report.md', 'Notes/Report.md');
  });

  it('review M6: a pick the filter hides is not moved to, and one row always keeps the tab stop', async () => {
    render(<MoveToDialog path="Report.md" onClose={vi.fn()} />);
    const move = screen.getByRole('button', { name: 'Move' });
    // The keyboard was on Notes, which the filter then hides.
    await userEvent.click(row('Notes'));
    expect(move).toBeEnabled();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter folders' }), 'lin');
    expect(names()).not.toContain('Notes');
    expect(move).toBeDisabled();
    const stops = within(tree())
      .getAllByRole('treeitem')
      .filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    await userEvent.click(move);
    expect(rename).not.toHaveBeenCalled();
  });

  it('the tree keys: up and down move, right opens, left closes, Enter moves', async () => {
    render(<MoveToDialog path="Report.md" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('searchbox', { name: 'Filter folders' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(row(/^Vault root/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(row('Cyber')).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(row('Cyber')).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowRight}');
    expect(row('Linux')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(row('Cyber')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(row('Cyber')).toHaveAttribute('aria-expanded', 'false');
    expect(names()).toEqual(['', 'Cyber', 'Notes']);
    await userEvent.keyboard('{End}');
    expect(row('Notes')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(rename).toHaveBeenCalledWith('Report.md', 'Notes/Report.md');
  });

  it("Enter on the current folder doesn't move", async () => {
    render(<MoveToDialog path="Report.md" onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('searchbox', { name: 'Filter folders' }));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(rename).not.toHaveBeenCalled();
  });

  it('typing filters the tree and keeps the ancestors of what matches', async () => {
    render(<MoveToDialog path="Report.md" onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter folders' }), 'subnet');
    expect(names()).toEqual(['', 'Cyber', 'Cyber/Networking', 'Cyber/Networking/Subnetting']);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Filter folders' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter folders' }), 'zzz');
    expect(screen.getByText('No folder matches')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<MoveToDialog path="Report.md" onClose={vi.fn()} />);
    const r = await axe.run(container);
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
