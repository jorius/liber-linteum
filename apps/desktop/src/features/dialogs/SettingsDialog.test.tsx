import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { SettingsDialog } from './SettingsDialog';

let patches: Record<string, unknown>[];

beforeEach(() => {
  patches = [];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    if (cmd === 'settings_set') {
      patches.push(args.patch as Record<string, unknown>);
      return { ...useSettingsStore.getState().settings, ...(args.patch as object) };
    }
    if (cmd === 'fonts_list') return ['Avenir Next', 'Menlo'];
    return null;
  });
});
afterEach(() => {
  clearMocks();
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('style');
});

const open = () => render(<SettingsDialog onClose={() => undefined} />);

describe('Settings dialog (M2b §4, §5, §7)', () => {
  it('is grouped into Appearance, Editor and Files, and has no axe violations', async () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    for (const name of ['Appearance', 'Editor', 'Files']) {
      expect(within(dialog).getByRole('heading', { name, level: 3 })).toBeInTheDocument();
    }
    await screen.findByRole('option', { name: 'Avenir Next' }, { timeout: 2000 }).catch(() => null);
    const violations = await axe
      .run(dialog, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });

  it('a palette applies at once and is saved', async () => {
    open();
    await userEvent.click(screen.getByRole('radio', { name: 'Graphite' }));
    await waitFor(() => expect(patches).toEqual([{ palette: 'graphite' }]));
    expect(document.documentElement.dataset.palette).toBe('graphite');
  });

  it('a custom accent from the hex field: invalid input is explained and not saved', async () => {
    open();
    await userEvent.click(screen.getByRole('radio', { name: 'Custom accent' }));
    const hex = screen.getByRole('textbox', { name: 'Accent colour (hex)' });
    await userEvent.clear(hex);
    await userEvent.type(hex, 'pink{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('#rrggbb');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#2AA198{Enter}');
    await waitFor(() =>
      expect(patches).toEqual([{ palette: 'custom' }, { accentColor: '#2aa198' }]),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/Accent contrast/)).toHaveTextContent(/\d+\.\d:1/);
  });

  it('the colour picker saves the accent too', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, palette: 'custom' } });
    open();
    fireEvent.change(screen.getByLabelText('Accent colour'), { target: { value: '#6d28d9' } });
    await waitFor(() => expect(patches).toEqual([{ accentColor: '#6d28d9' }]));
  });

  it('the hex error clears once the value is valid again, typed or picked', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, palette: 'custom' } });
    open();
    const hex = screen.getByRole('textbox', { name: 'Accent colour (hex)' });
    await userEvent.clear(hex);
    await userEvent.type(hex, 'pink{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.clear(hex);
    await userEvent.type(hex, '#2aa198');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(hex).not.toHaveAttribute('aria-invalid', 'true');

    await userEvent.clear(hex);
    await userEvent.type(hex, 'nope{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText('Accent colour'), { target: { value: '#6d28d9' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(hex).toHaveValue('#6d28d9');
  });

  it('dragging the colour picker saves a bounded number of times, and the last colour wins', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, palette: 'custom' } });
    // Earlier saves answer later, as a busy blocking pool might.
    let calls = 0;
    mockIPC(async (cmd, raw) => {
      if (cmd !== 'settings_set') return cmd === 'fonts_list' ? [] : null;
      const patch = (raw as { patch: Record<string, unknown> }).patch;
      patches.push(patch);
      await new Promise((r) => setTimeout(r, Math.max(10, 80 - 20 * calls++)));
      return { ...useSettingsStore.getState().settings, ...patch };
    });
    open();
    const picker = screen.getByLabelText('Accent colour');
    const colours = Array.from(
      { length: 20 },
      (_, i) => `#${(0x203040 + i * 0x050301).toString(16).padStart(6, '0')}`,
    );
    // Mostly quick moves, with a pause now and then long enough to save.
    for (const [i, value] of colours.entries()) {
      fireEvent.input(picker, { target: { value } });
      await new Promise((r) => setTimeout(r, i % 5 === 4 ? 200 : 15));
    }
    const last = colours[colours.length - 1];
    expect(screen.getByRole('textbox', { name: 'Accent colour (hex)' })).toHaveValue(last);
    await waitFor(() => expect(useSettingsStore.getState().settings.accentColor).toBe(last), {
      timeout: 2000,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(useSettingsStore.getState().settings.accentColor).toBe(last);
    expect(patches.at(-1)).toEqual({ accentColor: last });
    expect(patches.length).toBeLessThanOrEqual(6);
  });

  it('fonts: bundled and installed families per mode, text size, toolbar and line numbers', async () => {
    open();
    const live = screen.getByRole('combobox', { name: 'Live Preview font' });
    const source = screen.getByRole('combobox', { name: 'Source font' });
    expect(within(live).getByRole('option', { name: 'Atkinson Hyperlegible' })).toBeInTheDocument();
    expect(await within(source).findByRole('option', { name: 'Menlo' })).toBeInTheDocument();
    await userEvent.selectOptions(live, 'literata');
    await userEvent.selectOptions(source, 'system:Menlo');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Text size' }), '18');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show the formatting toolbar' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show line numbers' }));
    await waitFor(() =>
      expect(patches).toEqual([
        { fontLivePreview: 'literata' },
        { fontSource: 'system:Menlo' },
        { fontSize: 18 },
        { toolbar: false },
        { lineNumbers: true },
      ]),
    );
    expect(document.documentElement.style.getPropertyValue('--font-source')).toContain('"Menlo"');
  });

  it('without the installed list (outside the app) the bundled fonts still work', async () => {
    mockIPC((cmd) => {
      if (cmd === 'fonts_list') throw { kind: 'io', message: 'no' };
      return null;
    });
    open();
    const live = screen.getByRole('combobox', { name: 'Live Preview font' });
    expect(within(live).getAllByRole('option').length).toBe(6);
  });
});

describe('Settings → This vault (M2c §5.4)', () => {
  let vaultPatches: unknown[];
  let obsidian: string | null;
  let overrideObsidian: boolean;
  let stored: { mode: string; path: string };

  beforeEach(() => {
    vaultPatches = [];
    obsidian = null;
    overrideObsidian = false;
    stored = { mode: 'subfolder', path: 'attachments' };
    useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
    mockIPC((cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (cmd === 'vault_settings_get') return { attachments: stored, obsidian, overrideObsidian };
      if (cmd === 'vault_settings_set') {
        vaultPatches.push(args.patch);
        const patch = args.patch as { attachments?: typeof stored; overrideObsidian?: boolean };
        if (patch.attachments) stored = patch.attachments;
        if (patch.overrideObsidian !== undefined) overrideObsidian = patch.overrideObsidian;
        return { attachments: stored, obsidian, overrideObsidian };
      }
      if (cmd === 'fonts_list') return [];
      return null;
    });
  });
  afterEach(async () => {
    await resetVaultStore();
  });

  it('is hidden without an open vault', async () => {
    await resetVaultStore();
    open();
    expect(screen.queryByRole('heading', { name: 'This vault' })).not.toBeInTheDocument();
  });

  it("shows NIMW's setting and saves another mode at once", async () => {
    open();
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toHaveValue('subfolder'));
    expect(screen.getByRole('textbox', { name: 'Subfolder name' })).toHaveValue('attachments');
    await userEvent.selectOptions(where, 'same');
    await waitFor(() =>
      expect(vaultPatches).toEqual([{ attachments: { mode: 'same', path: '' } }]),
    );
    expect(screen.queryByRole('textbox', { name: 'Subfolder name' })).not.toBeInTheDocument();
  });

  it('a folder is saved on Enter; an unusable name is explained and not saved', async () => {
    open();
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toHaveValue('subfolder'));
    await userEvent.selectOptions(where, 'folder');
    const field = screen.getByRole('textbox', { name: 'Folder in the vault' });
    expect(vaultPatches).toEqual([]);
    await userEvent.type(field, 'Me:dia{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Names can\'t contain ":"');
    expect(vaultPatches).toEqual([]);
    await userEvent.clear(field);
    await userEvent.type(field, 'Media/Img{Enter}');
    await waitFor(() =>
      expect(vaultPatches).toEqual([{ attachments: { mode: 'folder', path: 'Media/Img' } }]),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tabbing through the untouched field writes nothing (no .nimw/ for nothing; final review M5)', async () => {
    open();
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toBeEnabled());
    const field = screen.getByRole('textbox', { name: 'Subfolder name' });
    field.focus();
    fireEvent.blur(field);
    await userEvent.click(field);
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await new Promise((r) => setTimeout(r, 20));
    expect(vaultPatches).toEqual([]);
  });

  it('a value saved on Enter is not saved again on blur (final review M5)', async () => {
    open();
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toBeEnabled());
    const field = screen.getByRole('textbox', { name: 'Subfolder name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'files{Enter}');
    await waitFor(() =>
      expect(vaultPatches).toEqual([{ attachments: { mode: 'subfolder', path: 'files' } }]),
    );
    await userEvent.tab();
    await new Promise((r) => setTimeout(r, 20));
    expect(vaultPatches).toHaveLength(1);
  });

  it("Obsidian's setting wins: shown read-only with where files go", async () => {
    obsidian = './assets';
    open();
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toBeDisabled());
    expect(
      screen.getByText(
        'Obsidian puts new attachments in ./assets (the “assets” folder next to the page).',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Use a different place in Notes In My Way' }),
    ).not.toBeChecked();
    const violations = await axe
      .run(screen.getByRole('dialog'), { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });

  it("M4b §5: a switch lets NIMW use its own place; off restores Obsidian's", async () => {
    obsidian = './assets';
    open();
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toBeDisabled());
    const own = screen.getByRole('checkbox', { name: 'Use a different place in Notes In My Way' });
    await userEvent.click(own);
    await waitFor(() =>
      expect(vaultPatches).toEqual([
        { attachments: { mode: 'subfolder', path: 'attachments' }, overrideObsidian: true },
      ]),
    );
    expect(own).toBeChecked();
    expect(where).toBeEnabled();
    await userEvent.selectOptions(where, 'same');
    await waitFor(() => expect(vaultPatches).toHaveLength(2));
    expect(vaultPatches[1]).toEqual({ attachments: { mode: 'same', path: '' } });
    await userEvent.click(own);
    await waitFor(() => expect(vaultPatches[2]).toEqual({ overrideObsidian: false }));
    expect(where).toBeDisabled();
    expect(where).toHaveValue('same');
  });
});
