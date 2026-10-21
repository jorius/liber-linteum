// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { usePageStore } from '../../stores/pageStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { useGvStore } from '../global-view/gvStore';
import { useSearchStore } from '../search/searchStore';
import { App } from '../../app/App';
import { UnlockScreen } from './UnlockScreen';

type Handler = (args: Record<string, unknown>) => unknown;

function backend(handlers: Record<string, Handler>) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push([cmd, a]);
      return handlers[cmd]?.(a);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const info = {
  name: 'Secret',
  root: '/v/Secret',
  report: { pages: 0, warnings: [] },
  encrypted: true,
};
const fail =
  (kind: string, message = 'm') =>
  () => {
    throw { kind, message };
  };
const PASS = 'correct horse battery';

beforeEach(() => {
  useToastStore.getState().clear();
  useVaultStore.setState({ status: 'locked', lockedPath: '/v/Secret' });
});

afterEach(async () => {
  await resetVaultStore();
  clearMocks();
});

const field = () => screen.getByLabelText(/^(Passphrase|Recovery key)$/) as HTMLInputElement;

describe('UnlockScreen', () => {
  it('shows the vault name, a Beta pill and an autofocused password field', () => {
    backend({});
    render(<UnlockScreen />);
    expect(screen.getByRole('heading', { name: 'Secret' })).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(field()).toHaveAttribute('type', 'password');
    expect(field()).toHaveFocus();
    expect(field()).toHaveAttribute('spellcheck', 'false');
    expect(field()).toHaveAttribute('autocomplete', 'off');
  });

  it('unlock_wrong_then_right: the text stays selected for editing, then clears on success', async () => {
    let good = false;
    const calls = backend({
      vault_unlock: (a) => {
        if ((a.secret as { value: string }).value !== PASS)
          throw { kind: 'wrongSecret', message: 'x' };
        good = true;
        return info;
      },
      vault_tree: () => [],
    });
    render(<UnlockScreen />);
    await userEvent.type(field(), 'wrong passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That passphrase doesn't open this vault.");
    expect(field()).toHaveAttribute('aria-describedby', alert.id);
    expect(field()).toHaveFocus();
    expect(field().value).toBe('wrong passphrase');
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe('wrong passphrase'.length);
    expect(useToastStore.getState().toasts).toEqual([]);
    // Typing replaces the selection; the right one opens the vault.
    await userEvent.keyboard(PASS);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(good).toBe(true));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(field().value).toBe('');
    expect(calls.filter(([c]) => c === 'vault_unlock')).toHaveLength(2);
  });

  it('unlock_with_loose_recovery_key: the exact typed text reaches vaultUnlock', async () => {
    const calls = backend({ vault_unlock: fail('invalidInput') });
    render(<UnlockScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
    expect(field()).toHaveAttribute('placeholder', 'LIBER-XXXX-…');
    expect(field()).toHaveFocus();
    await userEvent.type(field(), '  liber-abcd efgh  ');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That doesn't look like a recovery key.",
    );
    expect(calls.find(([c]) => c === 'vault_unlock')?.[1]).toEqual({
      path: '/v/Secret',
      secret: { kind: 'recovery', value: '  liber-abcd efgh  ' },
    });
  });

  it('a wrong recovery key says so', async () => {
    backend({ vault_unlock: fail('wrongSecret') });
    render(<UnlockScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Use recovery key instead' }));
    await userEvent.type(field(), 'LIBER-AAAA');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That recovery key doesn't open this vault.",
    );
  });

  it('rollback_message, and the field is cleared', async () => {
    backend({ vault_unlock: fail('rollback') });
    render(<UnlockScreen />);
    await userEvent.type(field(), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This vault's key file is older than one this computer has already seen. It may have been restored from a backup or replaced. It wasn't opened.",
    );
    expect(field().value).toBe('');
  });

  it('other errors use the usual message', async () => {
    backend({ vault_unlock: fail('io', 'disk gone') });
    render(<UnlockScreen />);
    await userEvent.type(field(), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong: disk gone');
  });

  it('shows the unlocking status while the call runs', async () => {
    let release: (v: unknown) => void = () => {};
    backend({ vault_unlock: () => new Promise((r) => (release = r)) });
    render(<UnlockScreen />);
    await userEvent.type(field(), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Unlocking… (this takes a second on purpose)',
      ),
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    release(info);
  });

  it('damaged: the reset needs a confirm, then asks to try again (R1)', async () => {
    const calls = backend({
      vault_unlock: fail('damaged', 'vault-epochs.json'),
      security_reset_rollback_memory: () => null,
    });
    render(<UnlockScreen />);
    await userEvent.type(field(), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('damaged');
    await userEvent.click(
      screen.getByRole('button', { name: "Reset this computer's rollback memory…" }),
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Liber Linteum remembers each encrypted vault');
    expect(calls.some(([c]) => c === 'security_reset_rollback_memory')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Reset rollback memory' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Rollback memory reset. Try unlocking again.',
      ),
    );
    await waitFor(() => expect(field()).toHaveFocus());
    expect(calls.filter(([c]) => c === 'security_reset_rollback_memory')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('damaged: cancelling the confirm resets nothing; a refused reset says the files are damaged', async () => {
    const calls = backend({
      vault_unlock: fail('damaged'),
      security_reset_rollback_memory: fail('notPermitted'),
    });
    render(<UnlockScreen />);
    await userEvent.type(field(), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    const reset = await screen.findByRole('button', { name: /Reset this computer/ });
    await userEvent.click(reset);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some(([c]) => c === 'security_reset_rollback_memory')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: /Reset this computer/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset rollback memory' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("This vault's files are damaged."),
    );
    await waitFor(() => expect(field()).toHaveFocus());
    expect(screen.queryByRole('button', { name: /Reset this computer/ })).toBeNull();
  });

  it('the reset link is only for a damaged vault', async () => {
    backend({ vault_unlock: fail('wrongSecret') });
    render(<UnlockScreen />);
    expect(screen.queryByRole('button', { name: /Reset this computer/ })).toBeNull();
    await userEvent.type(field(), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /Reset this computer/ })).toBeNull();
  });

  it('back_from_unlock_leaves_nothing', async () => {
    backend({
      vault_open: () => ({ ...info, root: '/v/Secret' }),
      vault_tree: () => [{ path: 'a.md', kind: 'page' }],
      vault_lock: () => null,
    });
    useVaultStore.setState({ status: 'closed', lockedPath: null });
    await useVaultStore.getState().open('/v/Secret');
    useSearchStore.setState({ text: 'secret words' });
    usePageStore.setState({ path: 'a.md' });
    useGvStore.setState({ expanded: [{ kind: 'folder', path: 'a' } as never] });
    expect(await useVaultStore.getState().lock('menu')).toBe(true);
    render(<UnlockScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    const v = useVaultStore.getState();
    expect([v.status, v.lockedPath, v.info, v.nodes]).toEqual(['closed', null, null, []]);
    expect(usePageStore.getState().path).toBeNull();
    expect(usePageStore.getState().page).toBeNull();
    expect(useSearchStore.getState().text).toBe('');
    expect(useGvStore.getState().expanded).toEqual([]);
  });

  it('the passphrase never reaches a store, a toast or the console', async () => {
    const logged: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => {
      const orig = console[k];
      console[k] = (...a: unknown[]) => void logged.push(a);
      return () => (console[k] = orig);
    });
    backend({ vault_unlock: fail('wrongSecret') });
    render(<UnlockScreen />);
    await userEvent.type(field(), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByRole('alert');
    spies.forEach((restore) => restore());
    expect(JSON.stringify(logged)).not.toContain(PASS);
    expect(JSON.stringify(useToastStore.getState().toasts)).not.toContain(PASS);
    expect(
      JSON.stringify({ ...useVaultStore.getState(), children: null, expanded: null }),
    ).not.toContain(PASS);
  });

  it('through App, the opening overlay does not cover the Unlocking text', async () => {
    let release: (v: unknown) => void = () => {};
    backend({ vault_unlock: () => new Promise((r) => (release = r)), vault_tree: () => [] });
    render(<App />);
    await userEvent.type(field(), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('opening'));
    expect(screen.getByText('Unlocking… (this takes a second on purpose)')).toBeVisible();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByText('Reading the folder…')).toBeNull();
    release(info);
  });

  it('has no axe violations', async () => {
    backend({});
    const { container } = render(<UnlockScreen />);
    const res = await axe.run(container);
    expect(res.violations).toEqual([]);
  });
});
