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

  it('writes keys the way each platform does', () => {
    expect(keyLabel('Alt+Mod+W', true)).toBe('⌥⌘W');
    expect(keyLabel('Mod+Shift+F', false)).toBe('Ctrl+Shift+F');
    expect(keyLabel('Mod+\\', true)).toBe('⌘\\');
    expect(keyLabel('Mod+,', false)).toBe('Ctrl+,');
  });
});
