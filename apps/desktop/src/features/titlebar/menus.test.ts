// @vitest-environment node
import { readFileSync } from 'node:fs';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { SHORTCUT_GROUPS } from '../dialogs/shortcuts';
import { buildMenus, menuName, type MenuContext, type MenuItemEntry } from './menus';

const ctx = (over: Partial<MenuContext> = {}): MenuContext => ({
  main: true,
  vault: { name: 'Kessari', encrypted: false, scratchpad: false },
  toggles: { sidebar: true, toolbar: false, lineNumbers: true, outline: false },
  maximized: false,
  windows: false,
  ...over,
});

const t = i18next.t.bind(i18next);
const itemsOf = (c: MenuContext) =>
  buildMenus(t, c).flatMap((m) =>
    m.items
      .filter((i): i is MenuItemEntry => i.kind === 'item')
      .map((i) => ({ menu: m.key, ...i })),
  );
const find = (c: MenuContext, key: string) => itemsOf(c).find((i) => i.key === key)!;

describe('the drawn menu bar (custom title bar §3)', () => {
  it('has the macOS menus, in order; file windows have no Vault menu', () => {
    expect(buildMenus(t, ctx()).map((m) => m.label)).toEqual([
      'Liber Linteum',
      'File',
      'Vault',
      'Edit',
      'View',
      'Window',
    ]);
    expect(buildMenus(t, ctx({ main: false, vault: null })).map((m) => m.key)).toEqual([
      'app',
      'file',
      'edit',
      'view',
      'window',
    ]);
  });

  it('runs only items the macOS menu has (menu.rs ids)', () => {
    const menu = readFileSync(new URL('../../../src-tauri/src/menu.rs', import.meta.url), 'utf8');
    const ids = new Set([...menu.matchAll(/_ID: &str = "([^"]+)"/g)].map((m) => m[1]));
    const used = itemsOf(ctx()).flatMap((i) => ('id' in i ? [i.id] : []));
    expect(used.length).toBeGreaterThan(15);
    for (const id of used) expect(ids, id).toContain(id);
  });

  it('shows the keys Settings → Keyboard shortcuts lists', () => {
    const listed = new Set<string>(SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.keys)));
    // The Edit menu's and F11 are the system's, not the app's table.
    const own = itemsOf(ctx()).filter((i) => i.keys && i.menu !== 'edit' && i.keys !== 'F11');
    for (const i of own) expect(listed, `${i.key}: ${i.keys}`).toContain(i.keys);
  });

  it('names the vault in Encrypt and the scratchpad item, and enables what applies', () => {
    expect(find(ctx(), 'encrypt')).toMatchObject({ label: 'Encrypt “Kessari”…', disabled: false });
    expect(find(ctx(), 'quickNote').label).toBe('Create new scratchpad for Kessari');
    expect(find(ctx(), 'lock').disabled).toBe(true);
    const locked = ctx({ vault: { name: 'Kessari', encrypted: true, scratchpad: false } });
    expect(find(locked, 'encrypt')).toMatchObject({ label: 'Encrypt vault…', disabled: true });
    expect(find(locked, 'lock').disabled).toBe(false);
    const welcome = ctx({ vault: null });
    expect(find(welcome, 'closeVault').disabled).toBe(true);
    expect(find(welcome, 'globalView').disabled).toBe(true);
    expect(find(welcome, 'settings').disabled).toBe(true);
    expect(find(welcome, 'quickNote').label).toBe('Create new scratchpad in this vault');
  });

  it('checks the toggles that are on and follows the window state', () => {
    expect(find(ctx(), 'sidebar').checked).toBe(true);
    expect(find(ctx(), 'toolbar').checked).toBe(false);
    expect(find(ctx(), 'lineNumbers').checked).toBe(true);
    expect(find(ctx(), 'maximize').label).toBe('Maximize');
    expect(find(ctx({ maximized: true }), 'maximize').label).toBe('Restore');
    expect(find(ctx(), 'redo').keys).toBe('Mod+Shift+Z');
    expect(find(ctx({ windows: true }), 'redo').keys).toBe('Mod+Y');
  });

  it('cuts long vault names as the macOS menu does', () => {
    expect(menuName('Kessari')).toBe('Kessari');
    const long = 'é'.repeat(45);
    expect(menuName(long)).toBe(`${'é'.repeat(39)}…`);
  });
});
