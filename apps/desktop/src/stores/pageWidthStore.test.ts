import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
import { usePageWidthStore, widthFor } from './pageWidthStore';

let stored: { pageWidth: string | null; pageWidths: Record<string, string> };
let calls: [string, unknown][];

beforeEach(() => {
  stored = { pageWidth: null, pageWidths: {} };
  calls = [];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  usePageWidthStore.setState({ vault: null, pages: {}, loaded: false });
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    const reply = () => ({
      attachments: { mode: 'subfolder', path: 'attachments' },
      obsidian: null,
      overrideObsidian: false,
      ...stored,
    });
    if (cmd === 'vault_settings_get') return reply();
    if (cmd === 'page_width_set') {
      const { path, width } = args as { path: string; width: string | null };
      if (width) stored.pageWidths[path] = width;
      else delete stored.pageWidths[path];
      return reply();
    }
    if (cmd === 'vault_settings_set') {
      const w = (args.patch as { pageWidth: string }).pageWidth;
      stored.pageWidth = w === 'default' ? null : w;
      return reply();
    }
    return null;
  });
});
afterEach(() => clearMocks());

describe('page width (M4b part 2 §1)', () => {
  it('the page wins over the vault, the vault over the app', async () => {
    stored = { pageWidth: 'full', pageWidths: { 'B.md': 'readable' } };
    await usePageWidthStore.getState().load();
    expect(widthFor('A.md')).toBe('full');
    expect(widthFor('B.md')).toBe('readable');
    stored = { pageWidth: null, pageWidths: {} };
    await usePageWidthStore.getState().load();
    expect(widthFor('A.md')).toBe('readable');
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, pageWidth: 'full' } });
    expect(widthFor('A.md')).toBe('full');
  });

  it('toggling a page stores an entry only when it differs from the default', async () => {
    await usePageWidthStore.getState().load();
    await usePageWidthStore.getState().toggle('A.md');
    expect(widthFor('A.md')).toBe('full');
    expect(stored.pageWidths).toEqual({ 'A.md': 'full' });
    await usePageWidthStore.getState().toggle('A.md');
    expect(widthFor('A.md')).toBe('readable');
    expect(stored.pageWidths).toEqual({});
    // With a full vault default, turning a page off stores "readable".
    await usePageWidthStore.getState().setVault('full');
    await usePageWidthStore.getState().toggle('A.md');
    expect(stored.pageWidths).toEqual({ 'A.md': 'readable' });
    expect(widthFor('A.md')).toBe('readable');
  });
});
