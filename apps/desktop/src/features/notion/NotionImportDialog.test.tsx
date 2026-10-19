import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { usePageStore } from '../../stores/pageStore';
import { NotionHost } from './NotionHost';
import { validVaultName } from './NotionImportDialog';

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

const preview = {
  pages: 12,
  databases: 1,
  rows: 3,
  attachments: 4,
  folders: 2,
  bytes: 2048,
  warnings: ['Home.md: the link to Gone.md points nowhere'],
  moreWarnings: 0,
};
const vault = { name: 'Wiki', root: '/n/Wiki', report: { pages: 16, warnings: [] } };

function standard(extra: Record<string, Handler> = {}) {
  return backend({
    notion_pick_zip: () => ({ name: 'Team wiki.zip', suggestedName: 'Team wiki' }),
    notion_preview: () => preview,
    notion_pick_parent: () => '/n',
    notion_import: () => ({ vault, report: 'Notion import report.md', cancelled: false }),
    vault_tree: () => [],
    bin_list: () => ({ trash: [], archive: [] }),
    favorites_get: () => [],
    page_get: (a) => ({ path: a.path, title: 'Notion import report', text: '', tags: [] }),
    page_read: () => ({ text: '# Notion import report\n', hash: 'h' }),
    ...extra,
  });
}

beforeEach(() => {
  useToastStore.getState().clear();
  useUiStore.setState({ dialog: { type: 'notionImport' } });
});

afterEach(async () => {
  useUiStore.setState({ dialog: null });
  await resetVaultStore();
  clearMocks();
});

const importButton = () => screen.getByRole('button', { name: 'Import' });

describe('Notion import dialog (M7 §3)', () => {
  it('needs an export, a place and a valid name before Import does anything', async () => {
    const calls = standard();
    render(<NotionHost />);
    expect(importButton()).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(importButton());
    expect(calls.some(([c]) => c === 'notion_import')).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
    expect(await screen.findByText('Team wiki.zip')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Vault name' })).toHaveValue('Team wiki');
    expect(
      await screen.findByText('12 pages, 1 database with 3 rows, 4 attachments.'),
    ).toBeInTheDocument();
    expect(importButton()).toHaveAttribute('aria-disabled', 'true'); // no place yet

    await userEvent.click(screen.getByRole('button', { name: 'Choose location…' }));
    expect(await screen.findByText('/n')).toBeInTheDocument();
    await waitFor(() => expect(importButton()).toHaveAttribute('aria-disabled', 'false'));

    const name = screen.getByRole('textbox', { name: 'Vault name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'a/b');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(importButton()).toHaveAttribute('aria-disabled', 'true');
  });

  it('imports, opens the new vault and its report page', async () => {
    const calls = standard();
    render(<NotionHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
    await screen.findByText(/12 pages/);
    await userEvent.click(screen.getByRole('button', { name: 'Choose location…' }));
    await waitFor(() => expect(importButton()).toHaveAttribute('aria-disabled', 'false'));
    await userEvent.click(importButton());
    await waitFor(() => expect(useUiStore.getState().dialog).toBeNull());
    expect(calls).toContainEqual(['notion_import', { name: 'Team wiki' }]);
    expect(useVaultStore.getState().info?.root).toBe('/n/Wiki');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notion import report.md'));
  });

  it('shows progress, and Stop asks the import to stop instead of closing', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const calls = standard({
      notion_import: () => new Promise((r) => (finish = r)),
      notion_cancel: () => null,
    });
    render(<NotionHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
    await screen.findByText(/12 pages/);
    await userEvent.click(screen.getByRole('button', { name: 'Choose location…' }));
    await waitFor(() => expect(importButton()).toHaveAttribute('aria-disabled', 'false'));
    await userEvent.click(importButton());
    const progress = await screen.findByRole('progressbar', { name: 'Import progress' });
    await act(() => emit('notion:progress', { done: 5, total: 21 }));
    await waitFor(() => expect(progress).toHaveAttribute('value', '5'));
    expect(screen.getByText('5 of 21 files')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Stop import' }));
    expect(calls.some(([c]) => c === 'notion_cancel')).toBe(true);
    expect(useUiStore.getState().dialog).toEqual({ type: 'notionImport' });

    await act(async () => finish({ vault, report: 'Notion import report.md', cancelled: true }));
    await waitFor(() => expect(useUiStore.getState().dialog).toBeNull());
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/Import stopped/);
  });

  it('a failed import says why and keeps the dialog', async () => {
    standard({
      notion_import: () => {
        throw { kind: 'alreadyExists', message: '/n/Team wiki already exists' };
      },
    });
    render(<NotionHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
    await screen.findByText(/12 pages/);
    await userEvent.click(screen.getByRole('button', { name: 'Choose location…' }));
    await waitFor(() => expect(importButton()).toHaveAttribute('aria-disabled', 'false'));
    await userEvent.click(importButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/);
    expect(useUiStore.getState().dialog).toEqual({ type: 'notionImport' });
  });

  it('has no axe violations with the preview and its warnings', async () => {
    standard();
    render(<NotionHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
    await screen.findByText(/12 pages/);
    const violations = await axe
      .run(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });

  it('opens from File → Import from Notion… only when no other dialog is up', async () => {
    standard();
    useUiStore.setState({ dialog: null });
    render(<NotionHost />);
    await act(() => emit('menu:notionImport'));
    await waitFor(() => expect(useUiStore.getState().dialog).toEqual({ type: 'notionImport' }));
    useUiStore.setState({ dialog: { type: 'search' } });
    await act(() => emit('menu:notionImport'));
    expect(useUiStore.getState().dialog).toEqual({ type: 'search' });
  });
});

describe('validVaultName', () => {
  it('takes a plain folder name only', () => {
    for (const ok of ['Wiki', 'Team wiki 2', 'Canción']) expect(validVaultName(ok)).toBe(true);
    for (const bad of ['', '  ', '.hidden', 'a/b', 'a\\b', 'What?', 'x:y', 'p|q']) {
      expect(validVaultName(bad)).toBe(false);
    }
  });
});
