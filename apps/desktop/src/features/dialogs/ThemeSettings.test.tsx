import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import {
  isThemeColor,
  MAX_NAME,
  MAX_THEMES,
  newTheme,
  setColor,
  TOKEN_KEYS,
  toExport,
  type CustomTheme,
} from '../../theme/customThemes';
import { PALETTES } from '../../theme/palettes';
import { ThemeSettings } from './ThemeSettings';

let patches: Record<string, unknown>[];
let importText: string | null;
let importError: { kind: string; message: string } | null;
let exportError: { kind: string; message: string } | null;
let saveError: { kind: string; message: string } | null;
let exported: { name: string; json: string }[];

/** Refuses what Rust's `settings_set` refuses (review I3): a bad colour, a
 *  name over the cap, more than the theme limit. */
function rustRefuses(patch: Record<string, unknown>): string | null {
  const themes = patch.customThemes as CustomTheme[] | undefined;
  if (!themes) return null;
  if (themes.length > MAX_THEMES) return 'at most 100 themes';
  for (const t of themes) {
    if (!t.name.trim() || [...t.name].length > MAX_NAME) return 'theme id or name out of range';
    for (const mode of ['light', 'dark'] as const)
      for (const k of TOKEN_KEYS)
        if (!isThemeColor(k, t[mode][k])) return `not a theme colour: ${t[mode][k]}`;
  }
  return null;
}

beforeEach(() => {
  patches = [];
  importText = null;
  importError = null;
  exportError = null;
  saveError = null;
  exported = [];
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    if (cmd === 'settings_set') {
      const patch = args.patch as Record<string, unknown>;
      const refused = rustRefuses(patch);
      if (refused) throw { kind: 'io', message: refused };
      if (saveError) throw saveError;
      patches.push(patch);
      return { ...useSettingsStore.getState().settings, ...patch };
    }
    if (cmd === 'theme_import') {
      if (importError) throw importError;
      return importText;
    }
    if (cmd === 'theme_export') {
      if (exportError) throw exportError;
      exported.push({ name: args.name as string, json: args.json as string });
      return true;
    }
    return null;
  });
});
afterEach(() => {
  clearMocks();
  document.documentElement.removeAttribute('data-palette');
});

const withThemes = (themes: CustomTheme[], selected?: string) =>
  useSettingsStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      palette: selected ? 'custom' : 'lavender',
      customThemes: themes,
      customTheme: selected ?? null,
    },
  });
const saved = () => useSettingsStore.getState().settings;
const selva = () => newTheme(PALETTES[0], 'Selva', 'selva');

describe('Appearance: theme gallery and editor (custom themes §3)', () => {
  it('lists the 8 built-ins and the user themes, and picks one at once', async () => {
    withThemes([selva()]);
    render(<ThemeSettings />);
    const builtIn = screen.getByRole('radiogroup', { name: 'Built-in' });
    expect(within(builtIn).getAllByRole('radio')).toHaveLength(8);
    const mine = screen.getByRole('radiogroup', { name: 'My themes' });
    await userEvent.click(within(mine).getByRole('radio', { name: 'Selva' }));
    await waitFor(() => expect(saved().customTheme).toBe('selva'));
    expect(saved().palette).toBe('custom');
  });

  it('New creates "My theme", then "My theme 2", and selects it', async () => {
    render(<ThemeSettings />);
    await userEvent.click(screen.getByRole('button', { name: 'New theme' }));
    await waitFor(() => expect(saved().customThemes.map((t) => t.name)).toEqual(['My theme']));
    await userEvent.click(screen.getByRole('button', { name: 'New theme' }));
    await waitFor(() =>
      expect(saved().customThemes.map((t) => t.name)).toEqual(['My theme', 'My theme 2']),
    );
    expect(saved().customTheme).toBe(saved().customThemes[1].id);
    expect(screen.getByRole('textbox', { name: 'Theme name' })).toHaveValue('My theme 2');
  });

  it('editing Primary saves the theme and drops its derived mark', async () => {
    const t = { ...selva(), derived: { light: ['accent' as const], dark: [] } };
    withThemes([t], 'selva');
    render(<ThemeSettings />);
    fireEvent.change(screen.getByLabelText('Primary colour'), { target: { value: '#0e7c7b' } });
    await waitFor(() => expect(saved().customThemes[0].light.accent).toBe('#0e7c7b'));
    expect(saved().customThemes[0].derived.light).not.toContain('accent');
  });

  it('Fill the rest leaves hand-set colours alone', async () => {
    const t = {
      ...setColor(selva(), 'light', 'bg', '#123456'),
      derived: { light: ['soft' as const], dark: [] },
    };
    withThemes([t], 'selva');
    render(<ThemeSettings />);
    expect(t.light.soft).toBe(PALETTES[0].light.soft);
    await userEvent.click(screen.getByRole('button', { name: 'Fill the rest from Primary' }));
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(saved().customThemes[0].light.bg).toBe('#123456');
    // Review M15: Fill did fill — the derived colour follows the primary.
    expect(saved().customThemes[0].light.soft).not.toBe(PALETTES[0].light.soft);
  });

  it('a Low badge offers Fix; after Fix it reads AA and focus stays on the row', async () => {
    withThemes(
      [setColor(setColor(selva(), 'light', 'muted', '#cccccc'), 'light', 'secondary', '#ee79a1')],
      'selva',
    );
    render(<ThemeSettings />);
    for (const name of ['Secondary text', 'Secondary']) {
      const row = screen.getByRole('group', { name });
      expect(within(row).getByText(/^Low/)).toBeInTheDocument();
      // Review M10: the badge describes the hex field.
      const hex = within(row).getByRole('textbox', { name: `${name} colour (hex)` });
      expect(hex).toHaveAccessibleDescription(/^Low/);
      await userEvent.click(within(row).getByRole('button', { name: `Fix ${name}` }));
      // Review I1: the secondary reaches AA on its tag tint too.
      await waitFor(() => expect(within(row).getByText(/^AA/)).toBeInTheDocument());
      expect(hex).toHaveFocus();
    }
  });

  it('review I3: an invalid colour never saves; a refused save says so and resets the draft', async () => {
    withThemes([selva()], 'selva');
    render(<ThemeSettings />);
    const sel = screen.getByRole('textbox', { name: 'Sidebar selection colour (hex)' });
    await userEvent.clear(sel);
    await userEvent.type(sel, 'rgba(300,0,0,.5)');
    expect(patches).toHaveLength(0);
    // A save Rust refuses (a full disk, here): a toast, and the draft is back.
    saveError = { kind: 'io', message: 'disk full' };
    fireEvent.change(screen.getByLabelText('Primary colour'), { target: { value: '#0e7c7b' } });
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        "That change couldn't be saved, so the theme is back to how it was.",
      ),
    );
    expect(screen.getByRole('textbox', { name: 'Primary colour (hex)' })).toHaveValue(
      PALETTES[0].light.accent,
    );
    // The next edit saves normally.
    saveError = null;
    fireEvent.change(screen.getByLabelText('Primary colour'), { target: { value: '#123456' } });
    await waitFor(() => expect(saved().customThemes[0].light.accent).toBe('#123456'));
  });

  it('review I4: import and export failures are explained', async () => {
    withThemes([selva()], 'selva');
    render(<ThemeSettings />);
    const messages = () =>
      useToastStore.getState().toasts.map((t) => [t.message, ...(t.detail ?? [])]);
    importError = { kind: 'invalidInput', message: 'this file is too big to be a theme' };
    await userEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await waitFor(() => expect(messages().flat()).toContain("It's too big for a theme file."));
    importError = { kind: 'io', message: 'permission denied' };
    await userEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await waitFor(() => expect(messages().flat()).toContain("It couldn't be read."));
    exportError = { kind: 'io', message: 'read-only volume' };
    await userEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(messages().flat()).toContain("The theme couldn't be saved."));
  });

  it('review M5, M7: long names stay under the cap; a 101st theme is refused with a message', async () => {
    const long = { ...selva(), name: 'a'.repeat(MAX_NAME) };
    withThemes([long], 'selva');
    render(<ThemeSettings />);
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(saved().customThemes).toHaveLength(2));
    expect([...saved().customThemes[1].name].length).toBeLessThanOrEqual(MAX_NAME);
    useToastStore.getState().clear();
    const many = Array.from({ length: MAX_THEMES }, (_, i) =>
      newTheme(PALETTES[0], `T${i}`, `t${i}`),
    );
    withThemes(many, 't0');
    await userEvent.click(screen.getByRole('button', { name: 'New theme' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        'You can keep up to 100 themes. Delete one to add another.',
      ),
    );
    expect(saved().customThemes).toHaveLength(MAX_THEMES);
  });

  it('review M8: a stale selection shows Lavender, and its copy is named for it', async () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        palette: 'custom',
        customThemes: [selva()],
        customTheme: 'gone',
      },
    });
    render(<ThemeSettings />);
    const builtIn = screen.getByRole('radiogroup', { name: 'Built-in' });
    expect(within(builtIn).getByRole('radio', { name: 'Lavender' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate to edit' }));
    await waitFor(() => expect(saved().customThemes.map((t) => t.name)).toContain('Lavender copy'));
  });

  it('review M9: the editor opens on the mode the app is in', () => {
    document.documentElement.dataset.theme = 'dark';
    withThemes([selva()], 'selva');
    render(<ThemeSettings />);
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    document.documentElement.removeAttribute('data-theme');
  });

  it('a built-in shows "Duplicate to edit", which makes an editable copy', async () => {
    render(<ThemeSettings />);
    expect(screen.queryByRole('textbox', { name: 'Theme name' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate to edit' }));
    await waitFor(() => expect(saved().customThemes).toHaveLength(1));
    expect(saved().customThemes[0].light).toEqual(PALETTES[0].light);
    expect(saved().customThemes[0].name).toBe('Lavender copy');
  });

  it('Delete asks first, removes the theme and falls back to Lavender', async () => {
    withThemes([selva()], 'selva');
    render(<ThemeSettings />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(saved().customThemes).toHaveLength(1);
    // Review M10: focus moves to the confirm, back on Cancel, and to the
    // selected card after deleting.
    expect(screen.getByRole('button', { name: 'Delete “Selva”' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete “Selva”' }));
    await waitFor(() => expect(saved().customThemes).toHaveLength(0));
    expect(saved().palette).toBe('lavender');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Lavender' })).toHaveFocus());
  });

  it('export writes the file; import adds and selects a valid one, and explains a bad one', async () => {
    withThemes([selva()], 'selva');
    render(<ThemeSettings />);
    await userEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(exported).toHaveLength(1));
    expect(exported[0].name).toBe('Selva');
    importText = '{ nope';
    await userEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(saved().customThemes).toHaveLength(1);
    importText = toExport(selva());
    await userEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await waitFor(() =>
      expect(saved().customThemes.map((t) => t.name)).toEqual(['Selva', 'Selva 2']),
    );
    expect(saved().customTheme).toBe(saved().customThemes[1].id);
  });

  it('Light/Dark switches the mode being edited', async () => {
    withThemes([selva()], 'selva');
    render(<ThemeSettings />);
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Primary colour (hex)' })).toHaveValue(
      PALETTES[0].dark.accent,
    );
  });

  it('has no axe violations', async () => {
    withThemes([selva()], 'selva');
    const { container } = render(<ThemeSettings />);
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
