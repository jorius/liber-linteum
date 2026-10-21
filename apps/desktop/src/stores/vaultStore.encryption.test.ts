// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../app/App';
import { clearMocks, mockIPC } from '../ipc/testing';
import { useEditorStore } from './editorStore';
import { usePageStore } from './pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
import { useSpellStore } from './spellStore';
import { useToastStore } from './toastStore';
import { resetVaultStore, useVaultStore } from './vaultStore';

type Handler = (args: Record<string, unknown>) => unknown;

function backend(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      return handlers[cmd]?.((args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const info = { name: 'V', root: '/v', report: { pages: 2, warnings: [] }, encrypted: true };

const editorActions = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(editorActions, true);
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, warning: null, loaded: false });
});

afterEach(async () => {
  await resetVaultStore();
  clearMocks();
});

describe('vaultStore — encrypted vaults (E4)', () => {
  it('open_locked_goes_to_locked', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'locked', message: 'locked' };
      },
    });
    const res = await useVaultStore.getState().open('/v');
    expect(res.ok).toBe(false);
    expect(useVaultStore.getState().status).toBe('locked');
    expect(useVaultStore.getState().lockedPath).toBe('/v');
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('unlock_opens_like_open', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'locked', message: 'locked' };
      },
      vault_unlock: () => info,
      vault_tree: () => [{ path: 'a.md', kind: 'page' }],
    });
    await useVaultStore.getState().open('/v');
    const before = useSpellStore.getState().setKey;
    const res = await useVaultStore
      .getState()
      .unlock({ kind: 'passphrase', value: 'x'.repeat(12) });
    expect(res.ok).toBe(true);
    expect(useVaultStore.getState().status).toBe('open');
    expect(useVaultStore.getState().lockedPath).toBeNull();
    expect(useVaultStore.getState().nodes.map((n) => n.path)).toEqual(['a.md']);
    expect(useSpellStore.getState().setKey).toBeGreaterThan(before);
  });

  it('a wrong secret stays locked, with no toast (the screen shows the error)', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'locked', message: 'locked' };
      },
      vault_unlock: () => {
        throw { kind: 'wrongSecret', message: 'no' };
      },
    });
    await useVaultStore.getState().open('/v');
    const res = await useVaultStore.getState().unlock({ kind: 'recovery', value: 'bad' });
    expect(res.ok).toBe(false);
    expect(useVaultStore.getState().status).toBe('locked');
    expect(useVaultStore.getState().lockedPath).toBe('/v');
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('unlock announces recovered clips like the plain path', async () => {
    backend({
      vault_unlock: () => ({
        ...info,
        recovered: [{ path: 'Audio/clip.wav', link: 'Audio/clip.wav' }],
      }),
      vault_tree: () => [],
    });
    useVaultStore.setState({ status: 'locked', lockedPath: '/v' });
    await useVaultStore.getState().unlock({ kind: 'passphrase', value: 'x'.repeat(12) });
    expect(useToastStore.getState().toasts[0]?.detail).toEqual(['Audio/clip.wav']);
  });

  async function openEncrypted(calls?: { vaultLock?: Handler }) {
    const log = backend({
      vault_unlock: () => info,
      vault_tree: () => [],
      vault_lock: calls?.vaultLock ?? (() => null),
    });
    useVaultStore.setState({ status: 'locked', lockedPath: '/v' });
    await useVaultStore.getState().unlock({ kind: 'passphrase', value: 'x'.repeat(12) });
    return log;
  }

  it('lock_saves_then_locks', async () => {
    const order: string[] = [];
    const log = await openEncrypted({
      vaultLock: () => {
        order.push('vaultLock');
        return null;
      },
    });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoSave: false } });
    useEditorStore.setState({
      askPaths: () => ['a.md'],
      saveAll: async () => {
        order.push('saveAll');
        return [];
      },
    });
    usePageStore.setState({ path: 'a.md' });
    expect(await useVaultStore.getState().lock('menu')).toBe(true);
    expect(order).toEqual(['saveAll', 'vaultLock']);
    expect(log).toContain('vault_lock');
    const s = useVaultStore.getState();
    expect(s.status).toBe('locked');
    expect(s.lockedPath).toBe('/v');
    expect(s.info).toBeNull();
    expect(usePageStore.getState().path).toBeNull();
  });

  it('lock_aborts_when_a_save_fails', async () => {
    const log = await openEncrypted();
    useEditorStore.setState({ saveAll: async () => ['a.md'] });
    expect(await useVaultStore.getState().lock('idle')).toBe(false);
    expect(log).not.toContain('vault_lock');
    expect(useVaultStore.getState().status).toBe('open');
  });

  it('a non-unlock open from the locked status toasts its error and leaves locked', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'io', message: 'disk' };
      },
    });
    useVaultStore.setState({ status: 'locked', lockedPath: '/old' });
    await useVaultStore.getState().open('/other');
    expect(useVaultStore.getState().status).toBe('closed');
    expect(useVaultStore.getState().lockedPath).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'Something went wrong: disk',
    ]);
  });

  it.each(['closed', 'locked'] as const)('damaged on open from %s shows a toast', async (from) => {
    backend({
      vault_open: () => {
        throw { kind: 'damaged', message: 'bad' };
      },
    });
    useVaultStore.setState({ status: from, lockedPath: from === 'locked' ? '/old' : null });
    await useVaultStore.getState().open('/v');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('cancelUnlock goes back to closed', () => {
    useVaultStore.setState({ status: 'locked', lockedPath: '/v' });
    useVaultStore.getState().cancelUnlock();
    expect(useVaultStore.getState().status).toBe('closed');
    expect(useVaultStore.getState().lockedPath).toBeNull();
  });

  it('a failed vault_lock leaves the vault open and untouched', async () => {
    await openEncrypted({
      vaultLock: () => {
        throw { kind: 'io', message: 'x' };
      },
    });
    expect(await useVaultStore.getState().lock('menu')).toBe(false);
    expect(useVaultStore.getState().status).toBe('open');
    expect(useVaultStore.getState().info).not.toBeNull();
  });

  it('open() from an open vault that answers locked closes the old one and lands on locked', async () => {
    const log = backend({
      vault_unlock: () => info,
      vault_tree: () => [],
      vault_close: () => null,
      vault_open: () => {
        throw { kind: 'locked', message: 'locked' };
      },
    });
    useVaultStore.setState({ status: 'locked', lockedPath: '/v' });
    await useVaultStore.getState().unlock({ kind: 'passphrase', value: 'x'.repeat(12) });
    await useVaultStore.getState().open('/enc2');
    expect(log).toContain('vault_close');
    expect(useVaultStore.getState().status).toBe('locked');
    expect(useVaultStore.getState().lockedPath).toBe('/enc2');
    expect(useVaultStore.getState().info).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('lock saves again when something got dirty while saving', async () => {
    await openEncrypted();
    let saves = 0;
    let dirty: string[] = [];
    useEditorStore.setState({
      dirtyPaths: () => dirty,
      saveAll: async () => {
        saves++;
        // the first save finishes, then the user types again
        dirty = saves === 1 ? ['a.md'] : [];
        return [];
      },
    });
    // dirtied again after the first save, before vault_lock
    expect(await useVaultStore.getState().lock('menu')).toBe(true);
    expect(saves).toBe(2);
  });

  it('keeps the Unlock screen mounted while an unlock is in flight', async () => {
    let release!: () => void;
    backend({
      vault_unlock: () => new Promise((r) => (release = () => r(info))),
      vault_tree: () => [],
    });
    useVaultStore.setState({ status: 'locked', lockedPath: '/v' });
    render(createElement(App));
    expect(screen.getByTestId('unlock-screen')).toBeTruthy();
    const p = useVaultStore.getState().unlock({ kind: 'passphrase', value: 'x'.repeat(12) });
    await waitFor(() => expect(useVaultStore.getState().status).toBe('opening'));
    expect(screen.getByTestId('unlock-screen')).toBeTruthy();
    release();
    await p;
    expect(useVaultStore.getState().unlocking).toBe(false);
  });
});
