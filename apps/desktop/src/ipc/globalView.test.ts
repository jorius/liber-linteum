import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { gvChildren, gvEdges, layoutGet, layoutSet } from './index';

afterEach(() => clearMocks());

describe('M3a ipc commands', () => {
  it('passes camelCase arguments and returns the typed payloads', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'gv_children') return { cards: [], centre: null };
      if (cmd === 'gv_edges') return [];
      if (cmd === 'layout_get') return { A: { x: 1, y: 2 } };
      return null;
    });
    expect(await gvChildren({ kind: 'vault' })).toEqual({
      ok: true,
      value: { cards: [], centre: null },
    });
    await gvChildren({ kind: 'folder', path: 'A' });
    await gvEdges(['A', 'b.md']);
    expect(await layoutGet('')).toEqual({ ok: true, value: { A: { x: 1, y: 2 } } });
    await layoutSet('page:b.md', { A: { x: 3, y: 4 } });
    expect(calls).toEqual([
      ['gv_children', { level: { kind: 'vault' } }],
      ['gv_children', { level: { kind: 'folder', path: 'A' } }],
      ['gv_edges', { visible: ['A', 'b.md'] }],
      ['layout_get', { level: '' }],
      ['layout_set', { level: 'page:b.md', positions: { A: { x: 3, y: 4 } } }],
    ]);
  });
});
