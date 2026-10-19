import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { gvChildren, gvEdges, indexPickSet, layoutGet, layoutSet, linkTarget } from './index';

afterEach(() => clearMocks());

describe('M3a ipc commands', () => {
  it('passes camelCase arguments and returns the typed payloads', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'gv_children') return { cards: [], centre: null, omitted: 0 };
      if (cmd === 'gv_edges') return [];
      if (cmd === 'layout_get') return { A: { x: 1, y: 2 } };
      return null;
    });
    expect(await gvChildren({ kind: 'vault' })).toEqual({
      ok: true,
      value: { cards: [], centre: null, omitted: 0 },
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

  it('M3b: link targets and index-note picks', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'link_target') return 'Sparda';
      if (cmd === 'index_pick_set') return { path: 'A', indexPage: 'A/b.md', indexFrom: 'picked' };
      return null;
    });
    expect(await linkTarget('Welcome.md', 'C/Sparda.md')).toEqual({ ok: true, value: 'Sparda' });
    const card = await indexPickSet('A', 'A/b.md');
    expect(card.ok && card.value.indexFrom).toBe('picked');
    await indexPickSet('A', null);
    expect(calls).toEqual([
      ['link_target', { source: 'Welcome.md', target: 'C/Sparda.md' }],
      ['index_pick_set', { folder: 'A', page: 'A/b.md' }],
      ['index_pick_set', { folder: 'A', page: null }],
    ]);
  });
});
