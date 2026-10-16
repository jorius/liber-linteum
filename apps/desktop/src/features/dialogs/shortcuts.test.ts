// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keyLabel, SHORTCUT_GROUPS } from './shortcuts';

const listed = new Set<string>(SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.keys)));

describe('Settings → Keyboard shortcuts (M5b §18)', () => {
  it("lists every accelerator of the app's menus", () => {
    const menu = readFileSync(new URL('../../../src-tauri/src/menu.rs', import.meta.url), 'utf8');
    const accels = [...menu.matchAll(/"((?:Alt\+|Shift\+)*CmdOrCtrl\+[^"]+)"/g)].map((m) =>
      m[1].replace('CmdOrCtrl', 'Mod'),
    );
    expect(accels.length).toBeGreaterThan(5);
    for (const a of accels) expect(listed, a).toContain(a);
  });

  it("lists every Mod shortcut of the editor's keymap (round-2 review M11)", () => {
    const format = readFileSync(new URL('../editor/format.ts', import.meta.url), 'utf8');
    const keys = [...format.matchAll(/key: '(Mod-[^']+)'/g)].map((m) =>
      m[1].replace(/-(?=.)/g, '+').replace(/\+([a-z])$/, (_, c: string) => '+' + c.toUpperCase()),
    );
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(listed, k).toContain(k);
  });

  it('lists the keys only the page answers (round-2 review M11)', () => {
    // Hand-kept: these live in useGlobalShortcuts' key tests, not in a table a test can read.
    for (const k of ['Mod+[', 'Mod+]', 'Mod+1', 'Mod+2', 'Mod+F', 'Mod+J', 'Mod+Shift+D']) {
      expect(listed, k).toContain(k);
    }
  });

  it('writes keys the way each platform does', () => {
    expect(keyLabel('Alt+Mod+W', true)).toBe('⌥⌘W');
    expect(keyLabel('Mod+Shift+F', false)).toBe('Ctrl+Shift+F');
    expect(keyLabel('Mod+\\', true)).toBe('⌘\\');
    expect(keyLabel('Mod+,', false)).toBe('Ctrl+,');
  });
});
