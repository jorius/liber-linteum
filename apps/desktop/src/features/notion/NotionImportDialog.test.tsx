import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearMocks, emit, mockIPC } from '../../ipc/testing';
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

  it('batch 6 review M7: refuses what Rust would refuse, before the import runs', () => {
    for (const bad of [
      'CON',
      'nul',
      'Notes.',
      'Wiki 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
      'é'.repeat(101),
    ]) {
      expect(validVaultName(bad), bad).toBe(false);
    }
    expect(validVaultName('CONsole')).toBe(true);
  });
});

async function readyToImport() {
  render(<NotionHost />);
  await userEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
  await screen.findByText(/12 pages/);
  await userEvent.click(screen.getByRole('button', { name: 'Choose location…' }));
  await waitFor(() => expect(importButton()).toHaveAttribute('aria-disabled', 'false'));
}

describe('Notion import dialog, batch 6 review', () => {
  it('I7: the Choose buttons wait while the export is read', async () => {
    let finish: (v: unknown) => void = () => undefined;
    standard({ notion_preview: () => new Promise((r) => (finish = r)) });
    render(<NotionHost />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose export…' }));
    expect(await screen.findByText('Reading the export…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose export…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose location…' })).toBeDisabled();
    await act(async () => finish(preview));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose export…' })).toBeEnabled(),
    );
  });

  it('I8: a taken name keeps the preview, so another name imports at once', async () => {
    let tries = 0;
    const calls = standard({
      notion_import: () => {
        tries++;
        if (tries === 1) throw { kind: 'alreadyExists', message: '/n/Team wiki already exists' };
        return { vault, report: 'Notion import report.md', cancelled: false, failed: null, root: '/n/Wiki' };
      },
    });
    await readyToImport();
    await userEvent.click(importButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/);
    expect(screen.getByText(/12 pages/)).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: 'Vault name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Wiki');
    await waitFor(() => expect(importButton()).toHaveAttribute('aria-disabled', 'false'));
    await userEvent.click(importButton());
    await waitFor(() => expect(useUiStore.getState().dialog).toBeNull());
    expect(calls.filter(([c]) => c === 'notion_pick_zip')).toHaveLength(1);
  });

  it('I8: a vault left part-way says so and offers to open or show it', async () => {
    const calls = standard({
      notion_import: () => ({
        vault: null,
        report: 'Notion import report.md',
        cancelled: false,
        failed: 'No space left on device',
        root: '/n/Team wiki',
      }),
      notion_reveal_partial: () => null,
      notion_open_partial: () => vault,
    });
    await readyToImport();
    await userEvent.click(importButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/No space left on device/);
    expect(screen.getByRole('alert')).toHaveTextContent('/n/Team wiki');
    expect(useVaultStore.getState().info).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Show in/ }));
    expect(calls.some(([c]) => c === 'notion_reveal_partial')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Open it anyway' }));
    await waitFor(() => expect(useUiStore.getState().dialog).toBeNull());
    expect(useVaultStore.getState().info?.root).toBe('/n/Wiki');
    await waitFor(() => expect(usePageStore.getState().path).toBe('Notion import report.md'));
  });

  it('M9, M10: importing moves focus to Stop, Escape stops it, and the total counts databases', async () => {
    const calls = standard({
      notion_import: () => new Promise(() => undefined),
      notion_cancel: () => null,
    });
    await readyToImport();
    await userEvent.click(importButton());
    const stop = await screen.findByRole('button', { name: 'Stop import' });
    await waitFor(() => expect(stop).toHaveFocus());
    // 12 pages + 3 rows + 4 attachments + 1 index page + the report.
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toHaveAttribute('max', '21');
    await userEvent.keyboard('{Escape}');
    expect(calls.some(([c]) => c === 'notion_cancel')).toBe(true);
    expect(useUiStore.getState().dialog).toEqual({ type: 'notionImport' });
  });
});
