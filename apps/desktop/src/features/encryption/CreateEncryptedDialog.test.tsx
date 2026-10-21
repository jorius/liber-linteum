// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { CreateEncryptedDialog } from './CreateEncryptedDialog';

const GROUPS = Array.from({ length: 14 }, (_, i) =>
  `G${String(i + 1).padStart(2, '0')}0`.slice(0, 4),
);
const CODE = `LIBER-${GROUPS.join('-')}`;
const info = { name: 'new', root: '/v/new', report: { pages: 0, warnings: [] }, encrypted: true };
const PASS = 'correct horse battery';

function backend(create: () => unknown = () => ({ info, recovery: CODE })) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC(
    (cmd, args) => {
      calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
      if (cmd === 'vault_create_encrypted') return create();
      if (cmd === 'vault_tree') return [];
      return undefined;
    },
    { shouldMockEvents: true },
  );
  return calls;
}

afterEach(async () => {
  await resetVaultStore();
  clearMocks();
  vi.restoreAllMocks();
});

async function toCode(onClose = vi.fn()) {
  const view = render(<CreateEncryptedDialog path="/v/new" onClose={onClose} />);
  await userEvent.type(screen.getByLabelText('Passphrase'), PASS);
  await userEvent.type(screen.getByLabelText('Confirm passphrase'), PASS);
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByTestId('recovery-code');
  return { onClose, view };
}

/** The two group numbers the confirm step asks for. */
const asked = () =>
  screen.getAllByLabelText(/^Group \d+$/).map((el) => ({
    el: el as HTMLInputElement,
    n: Number((el.getAttribute('aria-label') ?? el.id).replace(/\D/g, '')),
  }));

describe('CreateEncryptedDialog', () => {
  it('focuses the passphrase, hides it by default and blocks Continue on a mismatch', async () => {
    backend();
    render(<CreateEncryptedDialog path="/v/new" onClose={() => undefined} />);
    const pass = screen.getByLabelText('Passphrase');
    expect(pass).toHaveFocus();
    expect(pass).toHaveAttribute('type', 'password');
    expect(screen.getByText('Beta')).toBeInTheDocument();
    await userEvent.type(pass, PASS);
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), PASS + 'x');
    expect(screen.getByRole('alert')).toHaveTextContent("The passphrases don't match.");
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Show passphrase'));
    expect(pass).toHaveAttribute('type', 'text');
  });

  it('keeps Continue disabled while the passphrase is too short', async () => {
    backend();
    render(<CreateEncryptedDialog path="/v/new" onClose={() => undefined} />);
    await userEvent.type(screen.getByLabelText('Passphrase'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), 'short');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('creates, opens the vault behind the dialog and shows the code', async () => {
    const calls = backend();
    await toCode();
    expect(calls.find(([c]) => c === 'vault_create_encrypted')?.[1]).toMatchObject({
      path: '/v/new',
      passphrase: PASS,
    });
    expect(useVaultStore.getState().status).toBe('open');
    expect(screen.getByTestId('recovery-code')).toHaveTextContent(CODE);
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
  });

  it('shows a refused folder inline and returns to the passphrase step', async () => {
    backend(() => {
      throw { kind: 'notEmpty', message: 'x' };
    });
    render(<CreateEncryptedDialog path="/v/new" onClose={() => undefined} />);
    await userEvent.type(screen.getByLabelText('Passphrase'), PASS);
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick an empty or new folder.');
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument();
    expect(useVaultStore.getState().status).not.toBe('open');
  });

  it('clears the passphrase after a failed create and refocuses the field', async () => {
    backend(() => {
      throw { kind: 'io', message: 'x' };
    });
    render(<CreateEncryptedDialog path="/v/new" onClose={() => undefined} />);
    await userEvent.type(screen.getByLabelText('Passphrase'), PASS);
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Passphrase')).toHaveValue('');
    expect(screen.getByLabelText('Confirm passphrase')).toHaveValue('');
    await waitFor(() => expect(screen.getByLabelText('Passphrase')).toHaveFocus());
  });

  it('copies the code and tells the user to clear the clipboard', async () => {
    backend();
    const user = userEvent.setup();
    await toCode();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(await screen.findByText(/clear your clipboard/)).toBeInTheDocument();
  });

  it('ignores Escape and the backdrop at the code step', async () => {
    backend();
    const { onClose } = await toCode();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(document.querySelector('[class*="backdrop"]')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('recovery-code')).toBeInTheDocument();
  });

  it('Done needs both groups, read loosely; then the code is gone', async () => {
    backend();
    const { onClose, view } = await toCode();
    await userEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    const [a, b] = asked();
    expect(a.n).toBeLessThan(b.n);
    expect(screen.queryByTestId('recovery-code')).toBeNull();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await userEvent.type(a.el, 'nope');
    await userEvent.type(b.el, GROUPS[b.n - 1]);
    expect(done).toBeDisabled();
    await userEvent.clear(a.el);
    // lower case and spaces; O for 0 and l for 1 as the backend reads them
    await userEvent.type(a.el, ` ${GROUPS[a.n - 1].toLowerCase().replace('0', 'o')} - `);
    await waitFor(() => expect(done).toBeEnabled());
    await userEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Nothing keeps the code: not the DOM, not the store.
    expect(view.container.innerHTML + document.body.innerHTML).not.toContain(GROUPS[0]);
    expect(JSON.stringify(useVaultStore.getState())).not.toContain(CODE);
    expect(JSON.stringify(useVaultStore.getState())).not.toContain(PASS);
  });

  it('passes axe on the passphrase and the code steps', async () => {
    backend();
    const { view } = await toCode();
    expect((await axe.run(view.baseElement)).violations).toEqual([]);
  });
});
