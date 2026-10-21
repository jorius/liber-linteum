import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
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
      vault_unlock: () => ({ ...info, recovered: ['Audio/clip.wav'] }),
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
});
