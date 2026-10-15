// M4b part 3 §9: links and embeds naming files outside the vault, and §8:
// captions saying where attachments are on disk.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalAssetUrl, type ExternalFile } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { DialogHost } from '../dialogs/DialogHost';
import { Preview } from './Preview';

/** What `links_external` knows (the "disk"). */
let outside: Record<string, ExternalFile>;
let calls: [string, Record<string, unknown>][];

const VAULT: Record<string, string> = { 'assets/rex cover.png': '', 'Notes/Page.md': '' };

beforeEach(() => {
  calls = [];
  outside = {};
  useUiStore.setState({ dialog: null });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    const targets = (args.targets ?? []) as { kind: string; target: string }[];
    if (cmd === 'links_resolve') {
      return targets.map(({ target }) => {
        const t = target.replace(/^\//, '');
        return Object.keys(VAULT).find((p) => p === t || p.endsWith(`/${t}`)) ?? null;
      });
    }
    if (cmd === 'links_external') return targets.map(({ target }) => outside[target] ?? null);
    if (cmd === 'external_network_allow') {
      // Loaded: from now on it is looked up (and, here, found).
      const path = args.path as string;
      for (const [target, f] of Object.entries(outside)) {
        if (f.path === path) outside[target] = { ...f, askFirst: false, exists: true };
      }
      return { ...file(path), network: true };
    }
    return null;
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetEditorStore();
  await resetVaultStore();
  clearMocks();
});

const show = (text: string) =>
  render(
    <>
      <Preview text={text} path="Notes/Page.md" delay={0} />
      <DialogHost />
    </>,
  );

const file = (path: string, over: Partial<ExternalFile> = {}): ExternalFile => ({
  path,
  exists: true,
  listed: true,
  network: false,
  askFirst: false,
  openable: true,
  ...over,
});

describe('only documents and media open from a note (final review I2)', () => {
  it('a disk image gets Show in Finder only, with the reason', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (Macintosh)' });
    outside['/Users/j/disk.iso'] = file('/Users/j/disk.iso', { openable: false });
    show('![[/Users/j/disk.iso]]\n');
    expect(await screen.findByText('disk.iso')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(
      screen.getByText('Not opened from notes: this kind of file can run programs.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show in Finder' })).toBeInTheDocument();
  });

  it('a link to one shows it in its folder instead of opening it', async () => {
    outside['D:\\x\\disk.iso'] = file('D:\\x\\disk.iso', { openable: false });
    show('See [[D:\\x\\disk.iso|the image]].\n');
    const link = await screen.findByText('the image');
    await waitFor(() => expect(link.closest('a')).toHaveAttribute('data-state', 'resolved'));
    await userEvent.click(link);
    expect(useUiStore.getState().dialog).toBeNull();
    await waitFor(() =>
      expect(calls).toContainEqual(['external_reveal', { path: 'D:\\x\\disk.iso' }]),
    );
    expect(calls.some(([c]) => c === 'external_open')).toBe(false);
  });
});

/** A network file nobody has loaded yet: nothing has touched it. */
const unloaded = (path: string): ExternalFile =>
  file(path, { exists: false, network: true, askFirst: true });

describe('a leading / with no linked file on disk is a vault link (final review I1)', () => {
  // Rust answers `null`: the vault's own missing link, as before §9.
  it('[[/…]] and [x](/…) offer Create page; ![[/…]] says Not found', async () => {
    show('[[/Projects/New idea]]\n\n![[/Assets/gone.png]]\n\n[x](/Notes/Missing.md)\n');
    expect(await screen.findByText('Not found: /Assets/gone.png')).toBeInTheDocument();
    const wiki = screen.getByText('/Projects/New idea');
    await waitFor(() => expect(wiki.closest('a')).toHaveAttribute('data-state', 'unresolved'));
    await userEvent.click(wiki);
    expect(useUiStore.getState().dialog).toEqual({
      type: 'createPage',
      source: 'Notes/Page.md',
      target: '/Projects/New idea',
    });
    useUiStore.setState({ dialog: null });
    await userEvent.click(screen.getByText('x'));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'createPage',
      source: 'Notes/Page.md',
      target: 'Notes/Missing.md',
    });
    expect(screen.queryByText(/Not found: \/Projects/)).toBeNull();
  });
});

describe('network files wait for the user (final review C1)', () => {
  const UNC = '\\\\nas\\share\\x.png';

  it('a network embed shows a card, connects nowhere, and loads on click', async () => {
    outside[UNC] = unloaded(UNC);
    show(`![[${UNC}]]\n`);
    expect(await screen.findByText(`Network file: ${UNC}`)).toBeInTheDocument();
    expect(screen.getByText('Loading it connects to “nas”.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(calls.some(([c]) => c === 'external_network_allow')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Load from network' }));
    expect(calls).toContainEqual(['external_network_allow', { path: UNC }]);
    expect(await screen.findByRole('img', { name: UNC })).toHaveAttribute(
      'src',
      externalAssetUrl(UNC),
    );
  });

  it('a link to a network file asks first, then loads and opens it', async () => {
    const doc = '\\\\nas\\share\\doc.pdf';
    outside[doc] = unloaded(doc);
    show(`Read [[${doc}|the doc]].\n`);
    const link = await screen.findByText('the doc');
    await waitFor(() => expect(link.closest('a')).toHaveAttribute('data-state', 'resolved'));
    await userEvent.click(link);
    const dialog = screen.getByRole('dialog', { name: 'Open “doc.pdf” in its default app?' });
    expect(dialog.textContent).toContain('Opening it connects to “nas”.');
    expect(calls.some(([c]) => c === 'external_network_allow')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(calls.some(([c]) => c === 'external_open')).toBe(true));
    const order = calls.map(([c]) => c).filter((c) => c.startsWith('external_'));
    expect(order).toEqual(['external_network_allow', 'external_open']);
  });
});

describe('outside files in the preview (M4b part 3 §9)', () => {
  it('an outside image embed shows through /.external/ once a saved page links it', async () => {
    outside['/Users/j/pic.png'] = file('/Users/j/pic.png');
    show('![[/Users/j/pic.png]]\n');
    const img = await screen.findByRole('img', { name: '/Users/j/pic.png' });
    expect(img).toHaveAttribute('src', externalAssetUrl('/Users/j/pic.png'));
    expect(calls.find(([c]) => c === 'links_external')?.[1]).toEqual({
      source: 'Notes/Page.md',
      targets: [{ kind: 'embed', target: '/Users/j/pic.png' }],
    });
  });

  it('until the page is saved it says Loading…, never a broken image', async () => {
    outside['D:\\Pics\\a.png'] = file('D:\\Pics\\a.png', { listed: false });
    show('![[D:\\Pics\\a.png]]\n');
    await waitFor(() => expect(calls.some(([c]) => c === 'links_external')).toBe(true));
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('a missing outside file says where it was looked for, without Create page', async () => {
    outside['D:\\Docs\\x.pdf'] = file('D:\\Docs\\x.pdf', { exists: false });
    show('![[D:\\Docs\\x.pdf]]\n');
    expect(await screen.findByText('Not found: D:\\Docs\\x.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create page' })).toBeNull();
  });

  it('other outside files get Open (after asking) and Show in Finder', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (Macintosh)' });
    outside['/Users/j/brief.pdf'] = file('/Users/j/brief.pdf');
    show('![[/Users/j/brief.pdf]]\n');
    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(calls.find(([c]) => c === 'external_reveal')?.[1]).toEqual({
      path: '/Users/j/brief.pdf',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Open “brief.pdf” in its default app?' });
    expect(dialog.textContent).toContain('/Users/j/brief.pdf');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    await waitFor(() =>
      expect(calls.find(([c]) => c === 'external_open')?.[1]).toEqual({
        path: '/Users/j/brief.pdf',
      }),
    );
  });

  it('Markdown images and links name outside files as the index reads them', async () => {
    outside['file:///Users/j/b c.png'] = file('/Users/j/b c.png');
    outside['D:\\Docs\\x.pdf'] = file('D:\\Docs\\x.pdf');
    show('![pic](file:///Users/j/b%20c.png)\n\nSee [the doc](D:\\Docs\\x.pdf).\n');
    expect(await screen.findByRole('img', { name: 'pic' })).toHaveAttribute(
      'src',
      externalAssetUrl('/Users/j/b c.png'),
    );
    const external = calls.find(([c]) => c === 'links_external')?.[1];
    expect(external?.targets).toEqual(
      expect.arrayContaining([
        { kind: 'markdown_image', target: 'file:///Users/j/b c.png' },
        { kind: 'markdown', target: 'D:\\Docs\\x.pdf' },
      ]),
    );
    await userEvent.click(await screen.findByText('the doc'));
    expect(
      screen.getByRole('dialog', { name: 'Open “x.pdf” in its default app?' }),
    ).toBeInTheDocument();
  });

  it('a [[D:\\…]] link asks to open the file, never to create a page', async () => {
    outside['D:\\Docs\\x.pdf'] = file('D:\\Docs\\x.pdf');
    show('Read [[D:\\Docs\\x.pdf|the brief]].\n');
    const link = await screen.findByText('the brief');
    await waitFor(() => expect(link.closest('a')).toHaveAttribute('data-state', 'resolved'));
    await userEvent.click(link);
    expect(useUiStore.getState().dialog).toEqual({
      type: 'openFile',
      path: 'D:\\Docs\\x.pdf',
      external: true,
    });
  });
});

describe('where attachments are on disk (M4b part 3 §8)', () => {
  it('off by default: no caption', async () => {
    show('![[rex cover.png]]\n');
    await screen.findByRole('img', { name: 'rex cover.png' });
    expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull();
  });

  it('a vault file shows its place under the vault, with Copy path', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() =>
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showAttachmentPaths: true } }),
    );
    show('![[rex cover.png]]\n');
    expect(await screen.findByText('/v/assets/rex cover.png')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('/v/assets/rex cover.png');
  });

  it('on Windows with backslashes; outside files show their own path', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
    useVaultStore.setState({ info: { name: 'Mind_PC', root: 'D:\\Mind_PC', report: {} as never } });
    act(() =>
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showAttachmentPaths: true } }),
    );
    outside['E:\\Pics\\a.png'] = file('E:\\Pics\\a.png');
    show('![[rex cover.png]]\n\n![[E:\\Pics\\a.png]]\n');
    expect(await screen.findByText('D:\\Mind_PC\\assets\\rex cover.png')).toBeInTheDocument();
    expect(await screen.findByText('E:\\Pics\\a.png')).toBeInTheDocument();
  });
});
