import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import styles from './Dialogs.module.css';
import { resetSettingsCategory, SettingsDialog } from './SettingsDialog';

let patches: Record<string, unknown>[];

beforeEach(() => {
  resetSettingsCategory();
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

/** Shows a category of the left menu (M5b §18). */
const show = (name: string) =>
  userEvent.click(
    within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', {
      name,
    }),
  );

describe('Settings dialog (M2b §4, §5, §7)', () => {
  it('M5b §18: categories in a left menu, one shown at a time, and no axe violations', async () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const nav = within(dialog).getByRole('navigation', { name: 'Settings categories' });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['General', 'Appearance', 'Editor', 'Files and quick notes', 'Keyboard shortcuts']);
    expect(within(nav).getByRole('button', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Graphite' })).not.toBeInTheDocument();
    await show('Appearance');
    expect(screen.getByRole('heading', { name: 'Appearance', level: 3 })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Graphite' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Language' })).not.toBeInTheDocument();
    await screen.findByRole('option', { name: 'Avenir Next' }, { timeout: 2000 }).catch(() => null);
    const violations = await axe
      .run(dialog, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });

  it('M5b §18: ↑ and ↓ move through the categories; the last one is kept for the session', async () => {
    const view = open();
    const nav = screen.getByRole('navigation', { name: 'Settings categories' });
    within(nav).getByRole('button', { name: 'General' }).focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(within(nav).getByRole('button', { name: 'Editor' })).toHaveFocus();
    expect(within(nav).getByRole('button', { name: 'Editor' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('combobox', { name: 'Text size' })).toBeInTheDocument();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(within(nav).getByRole('button', { name: 'Keyboard shortcuts' })).toHaveFocus();
    view.unmount();
    open();
    expect(
      screen.getByRole('heading', { name: 'Keyboard shortcuts', level: 3 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Create new scratchpad in this vault')).toBeInTheDocument();
  });

  it('M5b §18: search shows the matching rows of every category, accents ignored', async () => {
    open();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'líne');
    expect(screen.getByRole('heading', { name: 'Search results', level: 3 })).toBeInTheDocument();
    // "Show line numbers" (Editor), nothing from General.
    expect(screen.getByRole('checkbox', { name: 'Show line numbers' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Language' })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search settings' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'zzzz');
    expect(screen.getByText('No settings match.')).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search settings' }));
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeVisible();
    expect(screen.queryByText('No settings match.')).not.toBeInTheDocument();
  });

  it('round-2 review I3: Tab from the last shown control wraps, past a category search hides', async () => {
    open();
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    await userEvent.type(search, 'theme');
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    // A row that arrives after the search ran (a vault row loading late) stays
    // unhidden inside its hidden category: it must not be the trap's last stop.
    const late = document.createElement('button');
    late.textContent = 'late';
    [...dialog.querySelectorAll('[data-no-match]')].pop()?.append(late);
    const shown = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button, input, select, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((n) => !n.closest('[hidden], [data-no-match]'));
    shown[shown.length - 1].focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(shown[0]);
  });

  it('a palette applies at once and is saved', async () => {
    open();
    await show('Appearance');
    await userEvent.click(screen.getByRole('radio', { name: 'Graphite' }));
    await waitFor(() => expect(patches).toEqual([{ palette: 'graphite' }]));
    expect(document.documentElement.dataset.palette).toBe('graphite');
  });

  it('a custom accent from the hex field: invalid input is explained and not saved', async () => {
    open();
    await show('Appearance');
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
    await show('Appearance');
    fireEvent.change(screen.getByLabelText('Accent colour'), { target: { value: '#6d28d9' } });
    await waitFor(() => expect(patches).toEqual([{ accentColor: '#6d28d9' }]));
  });

  it('the hex error clears once the value is valid again, typed or picked', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, palette: 'custom' } });
    open();
    await show('Appearance');
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
    await show('Appearance');
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
    await show('Editor');
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
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Page width' }), 'full');
    await waitFor(() => expect(patches.at(-1)).toEqual({ pageWidth: 'full' }));
    expect(document.documentElement.style.getPropertyValue('--font-source')).toContain('"Menlo"');
  });

  it('M4b part 3: page width offers Wide elements; the kinds that go wide are checkboxes', async () => {
    open();
    await show('Editor');
    const width = screen.getByRole('combobox', { name: 'Page width' });
    expect(
      within(width)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Readable', 'Wide elements', 'Full width']);
    await userEvent.selectOptions(width, 'wide');
    await waitFor(() => expect(patches).toEqual([{ pageWidth: 'wide' }]));
    const group = screen.getByRole('group', { name: 'Wide elements' });
    expect(within(group).getByText('Used when a page’s width is Wide elements.')).toBeVisible();
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label') ?? b.parentElement!.textContent)).toEqual([
      'Tables',
      'Code blocks',
      'Diagrams',
      'Images',
      'Maths blocks',
    ]);
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
    await userEvent.click(within(group).getByRole('checkbox', { name: 'Code blocks' }));
    await waitFor(() =>
      expect(patches.at(-1)).toEqual({
        wideElements: { tables: true, code: true, diagrams: true, images: false, maths: false },
      }),
    );
    expect(within(group).getByRole('checkbox', { name: 'Code blocks' })).toBeChecked();
  });

  it('cover resize: the default cover height is a choice of four sizes, saved at once', async () => {
    open();
    await show('Editor');
    const select = screen.getByRole('combobox', { name: 'Default cover height' });
    expect(select).toHaveValue('200');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Small (132 px)', 'Medium (200 px)', 'Large (280 px)', 'Extra large (360 px)']);
    await userEvent.selectOptions(select, '280');
    await waitFor(() => expect(patches).toEqual([{ coverHeight: 280 }]));
    expect(select).toHaveValue('280');
  });

  it('M4b part 3 §8: "Show where attachments are on disk" is off until turned on', async () => {
    open();
    await show('Editor');
    const box = screen.getByRole('checkbox', { name: 'Show where attachments are on disk' });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    await waitFor(() => expect(patches).toEqual([{ showAttachmentPaths: true }]));
  });

  it('M5b §6, §2.2: Auto save (on) and where the floating button sits are saved at once', async () => {
    open();
    await show('Editor');
    const autoSave = screen.getByRole('checkbox', { name: 'Auto save' });
    expect(autoSave).toBeChecked();
    await userEvent.click(autoSave);
    await show('Appearance');
    const place = screen.getByRole('combobox', { name: 'Action button' });
    expect(place).toHaveValue('bottomRight');
    await userEvent.selectOptions(place, 'topRight');
    await waitFor(() =>
      expect(patches).toEqual([{ autoSave: false }, { actionButton: 'topRight' }]),
    );
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Bottom right', 'Bottom left', 'Top right']),
    );
  });

  it('cover resize: a default set by hand outside the four sizes is still shown', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, coverHeight: 250 } });
    open();
    await show('Editor');
    const select = screen.getByRole('combobox', { name: 'Default cover height' });
    expect(select).toHaveValue('250');
    expect(within(select).getByRole('option', { name: '250 px' })).toBeInTheDocument();
  });

  it('without the installed list (outside the app) the bundled fonts still work', async () => {
    mockIPC((cmd) => {
      if (cmd === 'fonts_list') throw { kind: 'io', message: 'no' };
      return null;
    });
    open();
    await show('Editor');
    const live = screen.getByRole('combobox', { name: 'Live Preview font' });
    expect(within(live).getAllByRole('option').length).toBe(6);
  });
});

describe('Settings → This vault (M2c §5.4)', () => {
  let vaultPatches: unknown[];
  let obsidian: string | null;
  let overrideObsidian: boolean;
  let stored: { mode: string; path: string };
  let vaultWidth: string | null;
  let linkFormat: string | null;
  let obsidianLinkFormat: string | null;

  beforeEach(() => {
    vaultWidth = null;
    linkFormat = null;
    obsidianLinkFormat = null;
    vaultPatches = [];
    obsidian = null;
    overrideObsidian = false;
    stored = { mode: 'subfolder', path: 'attachments' };
    useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
    mockIPC((cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      const reply = () => ({
        attachments: stored,
        obsidian,
        overrideObsidian,
        pageWidth: vaultWidth,
        pageWidths: {},
        attachmentLinkFormat: linkFormat,
        obsidianLinkFormat,
      });
      if (cmd === 'vault_settings_get') return reply();
      if (cmd === 'vault_settings_set') {
        vaultPatches.push(args.patch);
        const patch = args.patch as {
          attachments?: typeof stored;
          overrideObsidian?: boolean;
          pageWidth?: string;
          attachmentLinkFormat?: string;
        };
        if (patch.attachmentLinkFormat) {
          linkFormat = patch.attachmentLinkFormat === 'default' ? null : patch.attachmentLinkFormat;
        }
        if (patch.attachments) stored = patch.attachments;
        if (patch.overrideObsidian !== undefined) overrideObsidian = patch.overrideObsidian;
        if (patch.pageWidth) vaultWidth = patch.pageWidth === 'default' ? null : patch.pageWidth;
        return reply();
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
    await show('This vault');
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toHaveValue('subfolder'));
    expect(screen.getByRole('textbox', { name: 'Subfolder name' })).toHaveValue('attachments');
    // M5b round 2: as wide as the selects around it, not a 10-character box.
    expect(screen.getByRole('textbox', { name: 'Subfolder name' })).toHaveClass(
      styles.textInput,
      'field-control',
    );
    await userEvent.selectOptions(where, 'same');
    await waitFor(() =>
      expect(vaultPatches).toEqual([{ attachments: { mode: 'same', path: '' } }]),
    );
    expect(screen.queryByRole('textbox', { name: 'Subfolder name' })).not.toBeInTheDocument();
  });

  it('M4b part 2 §1: the vault can set its own page width or use the app setting', async () => {
    open();
    await show('This vault');
    const width = await screen.findByRole('combobox', { name: 'Page width for this vault' });
    await waitFor(() => expect(width).toHaveValue('default'));
    await userEvent.selectOptions(width, 'full');
    await waitFor(() => expect(vaultPatches).toEqual([{ pageWidth: 'full' }]));
    // M4b part 3: Wide elements is a vault choice too.
    await userEvent.selectOptions(width, 'wide');
    await waitFor(() => expect(vaultPatches.at(-1)).toEqual({ pageWidth: 'wide' }));
    await userEvent.selectOptions(width, 'default');
    await waitFor(() => expect(vaultPatches.at(-1)).toEqual({ pageWidth: 'default' }));
  });

  it('M4b part 3 §8: the link format for new attachments is saved at once, with an example', async () => {
    open();
    await show('This vault');
    const format = await screen.findByRole('combobox', {
      name: 'Link format for new attachments',
    });
    await waitFor(() => expect(format).toHaveValue('shortest'));
    expect(
      within(format)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Shortest name',
      'Full path in the vault',
      'Relative to the note',
      'Absolute path on disk',
    ]);
    expect(screen.getByText('![[x.png]]')).toBeInTheDocument();
    await userEvent.selectOptions(format, 'absolute');
    await waitFor(() => expect(vaultPatches).toEqual([{ attachmentLinkFormat: 'absolute' }]));
    expect(format).toHaveValue('absolute');
    expect(screen.getByText('![](file:///…/Assets/x.png)')).toBeInTheDocument();
  });

  it("M4b part 3 §8: Obsidian's newLinkFormat is followed until NIMW has its own", async () => {
    obsidianLinkFormat = 'relative';
    open();
    await show('This vault');
    const format = await screen.findByRole('combobox', {
      name: 'Link format for new attachments',
    });
    await waitFor(() => expect(format).toHaveValue('default'));
    expect(
      screen.getByText(
        'Following Obsidian’s setting (Relative to the note). Choose a format to use your own.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('![[../Assets/x.png]]')).toBeInTheDocument();
    await userEvent.selectOptions(format, 'vault');
    await waitFor(() => expect(vaultPatches).toEqual([{ attachmentLinkFormat: 'vault' }]));
    expect(screen.queryByText(/Following Obsidian’s setting/)).not.toBeInTheDocument();
    await userEvent.selectOptions(format, 'default');
    await waitFor(() => expect(vaultPatches.at(-1)).toEqual({ attachmentLinkFormat: 'default' }));
    expect(format).toHaveValue('default');
  });

  it('a folder is saved on Enter; an unusable name is explained and not saved', async () => {
    open();
    await show('This vault');
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

  it('M4b part 3: a folder typed but not confirmed is saved when a click outside closes Settings', async () => {
    const closed: string[] = [];
    render(<SettingsDialog onClose={() => closed.push('closed')} />);
    await show('This vault');
    const where = await screen.findByRole('combobox', { name: 'New attachments go to' });
    await waitFor(() => expect(where).toHaveValue('subfolder'));
    await userEvent.selectOptions(where, 'folder');
    vaultPatches.length = 0;
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder in the vault' }), 'Media');
    const backdrop = screen.getByRole('dialog', { name: 'Settings' }).parentElement!;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(closed).toEqual(['closed']);
    await waitFor(() =>
      expect(vaultPatches).toEqual([{ attachments: { mode: 'folder', path: 'Media' } }]),
    );
  });

  it('tabbing through the untouched field writes nothing (no .nimw/ for nothing; final review M5)', async () => {
    open();
    await show('This vault');
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
    await show('This vault');
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
    await show('This vault');
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
    await show('This vault');
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

describe('M4b part 3: Escape and a click outside save and close Settings', () => {
  const openWith = () => {
    const closed: string[] = [];
    render(<SettingsDialog onClose={() => closed.push('closed')} />);
    return closed;
  };

  it('Escape closes when nothing in the dialog has focus (WebKit leaves a clicked checkbox unfocused)', () => {
    const closed = openWith();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toEqual(['closed']);
  });

  it('Escape closes once, not twice, when focus is inside the dialog', () => {
    const closed = openWith();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Language' }), { key: 'Escape' });
    expect(closed).toEqual(['closed']);
  });

  it('a click on the backdrop closes; a click inside, or a press inside released outside, does not', () => {
    const closed = openWith();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const backdrop = dialog.parentElement!;
    fireEvent.mouseDown(dialog);
    fireEvent.click(backdrop);
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(closed).toEqual([]);
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(closed).toEqual(['closed']);
  });

  it('a hex accent typed but not confirmed is saved by Escape before closing', async () => {
    const closed = openWith();
    await show('Appearance');
    await userEvent.click(screen.getByRole('radio', { name: 'Custom accent' }));
    const hex = screen.getByRole('textbox', { name: 'Accent colour (hex)' });
    await userEvent.clear(hex);
    await userEvent.type(hex, '#123456');
    fireEvent.keyDown(hex, { key: 'Escape' });
    expect(closed).toEqual(['closed']);
    await waitFor(() =>
      expect(patches).toContainEqual(expect.objectContaining({ accentColor: '#123456' })),
    );
  });
});
