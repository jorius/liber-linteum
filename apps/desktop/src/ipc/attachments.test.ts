import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentImport,
  attachmentPaste,
  coverPick,
  linkSuggest,
  vaultSettingsGet,
  vaultSettingsSet,
} from './index';

afterEach(() => clearMocks());

type Internals = { invoke: (cmd: string, args: unknown, options?: unknown) => Promise<unknown> };

describe('M2c ipc commands', () => {
  it('passes camelCase arguments', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'attachment_import')
        return [{ source: '/x.pdf', ok: { path: 'a/x.pdf', link: 'x.pdf', copied: true } }];
      if (cmd === 'cover_pick') return null;
      if (cmd === 'link_suggest') return [];
      return { attachments: { mode: 'subfolder', path: 'attachments' }, obsidian: null };
    });
    expect(await attachmentImport('P.md', ['/x.pdf'])).toEqual({
      ok: true,
      value: [{ source: '/x.pdf', ok: { path: 'a/x.pdf', link: 'x.pdf', copied: true } }],
    });
    expect(await coverPick('P.md')).toEqual({ ok: true, value: null });
    await linkSuggest('P.md', 'ge', true);
    await vaultSettingsGet();
    await vaultSettingsSet({ attachments: { mode: 'same', path: '' } });
    expect(calls).toEqual([
      ['attachment_import', { page: 'P.md', paths: ['/x.pdf'] }],
      ['cover_pick', { page: 'P.md' }],
      ['link_suggest', { source: 'P.md', query: 'ge', embed: true }],
      ['vault_settings_get', {}],
      ['vault_settings_set', { patch: { attachments: { mode: 'same', path: '' } } }],
    ]);
  });

  it('sends a paste as raw bytes with percent-encoded headers', async () => {
    mockIPC(() => ({ path: 'a/Pasted image 1.png', link: 'Pasted image 1.png', copied: true }));
    const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
    const seen: unknown[] = [];
    const real = internals.invoke;
    internals.invoke = (cmd, args, options) => {
      seen.push([cmd, args, options]);
      return real(cmd, args, options);
    };
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const res = await attachmentPaste('Notes/Día 1.md', 'Pasted image 1.png', bytes);
    expect(res.ok).toBe(true);
    expect(seen).toEqual([
      [
        'attachment_paste',
        bytes,
        {
          headers: {
            'x-nimw-page': 'Notes%2FD%C3%ADa%201.md',
            'x-nimw-name': 'Pasted%20image%201.png',
          },
        },
      ],
    ]);
  });
});
