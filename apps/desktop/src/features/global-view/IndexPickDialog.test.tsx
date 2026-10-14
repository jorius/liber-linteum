import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { IndexPickDialog } from './IndexPickDialog';

let calls: [string, unknown][];
let fail = false;

beforeEach(() => {
  calls = [];
  fail = false;
  useToastStore.getState().clear();
  useVaultStore.setState({
    nodes: [
      { path: 'Delta', kind: 'folder' },
      { path: 'Delta/x.md', kind: 'page' },
      { path: 'Delta/y.md', kind: 'page' },
      { path: 'Delta/Inner', kind: 'folder' },
      { path: 'Delta/Inner/i.md', kind: 'page' },
      { path: 'Delta/pic.png', kind: 'attachment' },
      { path: 'Other.md', kind: 'page' },
    ],
  } as never);
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'index_pick_set') {
      if (fail) throw { kind: 'notFound', message: 'gone' };
      return { path: 'Delta' };
    }
    return null;
  });
});
afterEach(() => clearMocks());

describe('index note pick (M3b §4)', () => {
  it('lists the folder’s own pages; the choice is saved', async () => {
    const onClose = vi.fn();
    render(<IndexPickDialog folder="Delta" current={null} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Index note for Delta' })).toBeVisible();
    const options = screen
      .getAllByRole('radio')
      .map((r) => r.getAttribute('aria-label') ?? r.closest('label')?.textContent);
    expect(options).toEqual(['No index note', 'x', 'y']);
    expect(screen.getByRole('radio', { name: 'No index note' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'y' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toContainEqual(['index_pick_set', { folder: 'Delta', page: 'Delta/y.md' }]);
  });

  it('clearing a pick sends none', async () => {
    render(<IndexPickDialog folder="Delta" current="Delta/x.md" onClose={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'x' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'No index note' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual(['index_pick_set', { folder: 'Delta', page: null }]),
    );
  });

  it('many pages: a search narrows the list', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ path: `Big/p${i}.md`, kind: 'page' }));
    useVaultStore.setState({ nodes: [{ path: 'Big', kind: 'folder' }, ...pages] } as never);
    render(<IndexPickDialog folder="Big" current={null} onClose={vi.fn()} />);
    const search = screen.getByRole('searchbox', { name: 'Find a page' });
    // A text field, not the settings' monospace hex field (final review m12).
    expect(getComputedStyle(search).font).toBe('400 14px var(--font-body)');
    expect(getComputedStyle(search).width).toBe('100%');
    await userEvent.type(search, 'p1');
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      'No index note',
      'p1',
      'p10',
      'p11',
    ]);
  });

  it('a failed save says why and keeps the dialog', async () => {
    fail = true;
    const onClose = vi.fn();
    render(<IndexPickDialog folder="Delta" current={null} onClose={onClose} />);
    await userEvent.click(screen.getByRole('radio', { name: 'x' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    render(<IndexPickDialog folder="Delta" current={null} onClose={vi.fn()} />);
    const violations = await axe
      .run(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });
});
