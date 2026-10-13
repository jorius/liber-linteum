import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileOpenExternal,
  linksResolve,
  onCloseRequested,
  pageCreateConflictCopy,
  pageRead,
  pageWrite,
  toCommandError,
  urlOpen,
} from './index';

afterEach(() => clearMocks());

describe('M2a ipc commands', () => {
  it('passes camelCase arguments for the editor commands', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'page_read') return { text: '# A\n', hash: 'h1' };
      if (cmd === 'page_write') return { hash: 'h2' };
      if (cmd === 'page_create_conflict_copy') return 'A (conflict).md';
      if (cmd === 'links_resolve') return ['B.md', null];
    });
    expect(await pageRead('A.md')).toEqual({ ok: true, value: { text: '# A\n', hash: 'h1' } });
    expect(await pageWrite('A.md', '# A!\n', 'h1')).toEqual({ ok: true, value: { hash: 'h2' } });
    expect(await pageCreateConflictCopy('A.md', 'theirs')).toEqual({
      ok: true,
      value: 'A (conflict).md',
    });
    const resolved = await linksResolve('A.md', [
      { kind: 'wiki', target: 'B' },
      { kind: 'wiki', target: 'Nope' },
    ]);
    expect(resolved).toEqual({ ok: true, value: ['B.md', null] });
    await urlOpen('https://example.org');
    await fileOpenExternal('assets/brief.pdf');
    expect(calls).toEqual([
      ['page_read', { path: 'A.md' }],
      ['page_write', { path: 'A.md', text: '# A!\n', expectedHash: 'h1' }],
      ['page_create_conflict_copy', { path: 'A.md', text: 'theirs' }],
      [
        'links_resolve',
        {
          source: 'A.md',
          targets: [
            { kind: 'wiki', target: 'B' },
            { kind: 'wiki', target: 'Nope' },
          ],
        },
      ],
      ['url_open', { url: 'https://example.org' }],
      ['file_open_external', { path: 'assets/brief.pdf' }],
    ]);
  });

  it('keeps the conflict payload of a rejected write (ED-08)', async () => {
    mockIPC(() => {
      throw { kind: 'conflict', message: 'changed', currentText: 'disk', currentHash: 'h9' };
    });
    expect(await pageWrite('A.md', 'mine', 'h1')).toEqual({
      ok: false,
      error: { kind: 'conflict', message: 'changed', currentText: 'disk', currentHash: 'h9' },
    });
    expect(toCommandError({ kind: 'binary', message: 'not UTF-8' })).toEqual({
      kind: 'binary',
      message: 'not UTF-8',
    });
  });

  it('runs the close handler before the window is destroyed', async () => {
    mockWindows('main');
    const calls: string[] = [];
    mockIPC((cmd) => void calls.push(cmd), { shouldMockEvents: true });
    let flushed = false;
    await onCloseRequested(async () => {
      await Promise.resolve();
      flushed = true;
    });
    await emit('tauri://close-requested');
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toBe(true);
    expect(calls).toContain('plugin:window|destroy');
  });
});
