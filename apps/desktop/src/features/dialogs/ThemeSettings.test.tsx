import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { newTheme, setColor, toExport, type CustomTheme } from '../../theme/customThemes';
import { PALETTES } from '../../theme/palettes';
import { ThemeSettings } from './ThemeSettings';

let patches: Record<string, unknown>[];
let importText: string | null;
let exported: { name: string; json: string }[];

beforeEach(() => {
  patches = [];
  importText = null;
  exported = [];
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    if (cmd === 'settings_set') {
      patches.push(args.patch as Record<string, unknown>);
      return { ...useSettingsStore.getState().settings, ...(args.patch as object) };
    }
    if (cmd === 'theme_import') return importText;
    if (cmd === 'theme_export') {
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
    await userEvent.click(screen.getByRole('button', { name: 'Fill the rest from Primary' }));
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(saved().customThemes[0].light.bg).toBe('#123456');
  });

  it('a Low badge offers Fix; after Fix it reads AA', async () => {
    withThemes([setColor(selva(), 'light', 'muted', '#cccccc')], 'selva');
    render(<ThemeSettings />);
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more colours' }));
    const row = screen.getByRole('group', { name: 'Secondary text' });
    expect(within(row).getByText(/^Low/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Fix Secondary text' }));
    await waitFor(() => expect(within(row).getByText(/^AA/)).toBeInTheDocument());
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
    await userEvent.click(screen.getByRole('button', { name: 'Delete “Selva”' }));
    await waitFor(() => expect(saved().customThemes).toHaveLength(0));
    expect(saved().palette).toBe('lavender');
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
