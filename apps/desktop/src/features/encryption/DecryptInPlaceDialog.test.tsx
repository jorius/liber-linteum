// @vitest-environment jsdom
// Decrypt in place (encryption UX §10.2): intro and warnings, the blocked
// list, both secrets required and each checked on its own, progress with
// Stop and undo, done.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { useEditorStore } from '../../stores/editorStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { openDecryptInPlace } from './decryptInPlace';
import { EncryptInPlaceHost } from './EncryptInPlaceDialog';

const PASS = 'correct horse battery';
const CODE = 'LIBER-AAAA-BBBB';
const ROOT = '/v/Myproject';
const report = {
  files: 0,
  pages: 0,
  parsed: 0,
  skippedUnchanged: 0,
  removed: 0,
  warnings: [],
  durationMs: 1,
};
const encrypted = { name: 'Myproject', root: ROOT, report, encrypted: true };
const plain = { name: 'Myproject', root: ROOT, report, encrypted: false };

interface Deferred {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

let calls: [string, Record<string, unknown>][] = [];
let runGate: Deferred | null = null;
/** The session the backend holds: begin closes it. */
let sessionOpen = true;

function backend(opts: { blocked?: { path: string; reason: string }[]; archives?: string[] } = {}) {
  calls = [];
  sessionOpen = true;
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push([cmd, a]);
      if (cmd === 'vault_decrypt_preflight')
        return {
          files: 1204,
          bytes: 9,
          blocked: opts.blocked ?? [],
          archives: opts.archives ?? [],
        };
      if (cmd === 'vault_open') {
        sessionOpen = true;
        return plain;
      }
      if (cmd === 'vault_decrypt_begin') {
        const pass = a.passphrase === PASS;
        const code = a.recovery === CODE;
        if (!pass || !code) {
          const which = !pass && !code ? 'both' : !pass ? 'passphrase' : 'recovery';
          throw { kind: 'decryptWrongSecret', message: which };
        }
        sessionOpen = false;
        return null;
      }
      if (cmd === 'vault_decrypt_run')
        return new Promise((resolve, reject) => {
          runGate = { resolve, reject };
        });
      if (cmd === 'vault_tree') {
        if (!sessionOpen) throw { kind: 'noVault', message: 'no vault is open' };
        return [];
      }
      return null;
    },
    { shouldMockEvents: true },
  );
}

const sent = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

async function start() {
  useVaultStore.setState({ status: 'open', info: encrypted });
  useEditorStore.setState({ saveAll: async () => [] });
  render(<EncryptInPlaceHost />);
  act(() => openDecryptInPlace());
  return screen.findByRole('dialog', { name: 'Decrypt “Myproject”' });
}

async function toSecrets(dialog: HTMLElement) {
  await within(dialog).findByText(/1,204 files\./);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
}

const fill = async (dialog: HTMLElement, pass: string, code: string) => {
  const p = within(dialog).getByLabelText('Passphrase');
  const c = within(dialog).getByLabelText('Recovery key');
  await userEvent.clear(p);
  if (pass) await userEvent.type(p, pass);
  await userEvent.clear(c);
  if (code) await userEvent.type(c, code);
};

const secretsKept = () =>
  JSON.stringify([
    useUiStore.getState(),
    useVaultStore.getState(),
    useToastStore.getState().toasts,
  ]);

beforeEach(() => {
  runGate = null;
});

afterEach(async () => {
  useUiStore.getState().closeDialog();
  useToastStore.getState().clear();
  await resetVaultStore();
  clearMocks();
});

describe('Decrypt in place: intro and preflight', () => {
  it('names the vault with the Beta chip, counts the files and warns plainly', async () => {
    backend();
    const dialog = await start();
    expect(within(dialog).getByText('Beta')).toHaveClass('liber-chip');
    expect(await within(dialog).findByText(/1,204 files\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/anyone with access to this disk/)).toBeVisible();
    expect(within(dialog).getByText(/version history keeps them/)).toBeVisible();
    expect(within(dialog).getByText(/stop working for good/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toHaveFocus();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(useUiStore.getState().dialog).toBeNull();
    expect(sent('vault_decrypt_begin')).toEqual([]);
  });

  it('only for an open encrypted vault', async () => {
    backend();
    useVaultStore.setState({ status: 'open', info: plain });
    openDecryptInPlace();
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('a blocked preflight lists each path and why, and only closes', async () => {
    backend({
      blocked: [
        { path: 'd/xyz.libere', reason: 'unreadable' },
        { path: 'Notes.md', reason: 'taken' },
        { path: 'Inner', reason: 'vault' },
      ],
    });
    const dialog = await start();
    expect(await within(dialog).findByText('d/xyz.libere')).toBeInTheDocument();
    expect(within(dialog).getByText(/its name couldn't be decrypted/)).toBeVisible();
    expect(within(dialog).getByText(/beside the vault already has this name/)).toBeVisible();
    expect(within(dialog).getByText(/an encrypted vault of its own/)).toBeVisible();
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Close']);
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});

describe('Decrypt in place: both secrets', () => {
  it('needs both, and says which one is wrong, keeping the other', async () => {
    backend();
    const dialog = await start();
    await toSecrets(dialog);
    // The form is drawn again after each try: always the current button.
    const button = () => within(dialog).getByRole('button', { name: 'Decrypt' });
    expect(within(dialog).getByLabelText('Passphrase')).toHaveFocus();
    expect(button()).toBeDisabled();
    await fill(dialog, PASS, '');
    expect(button()).toBeDisabled();
    await fill(dialog, '', CODE);
    expect(button()).toBeDisabled();
    expect((await axe.run(document.body)).violations).toEqual([]);

    await fill(dialog, 'not it at all', CODE);
    await userEvent.click(button());
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "The passphrase doesn't open this vault.",
    );
    expect(within(dialog).getByLabelText('Passphrase')).toHaveValue('');
    expect(within(dialog).getByLabelText('Passphrase')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByLabelText('Recovery key')).toHaveValue(CODE);
    expect((await axe.run(document.body)).violations).toEqual([]);

    await fill(dialog, PASS, 'LIBER-WRONG');
    await userEvent.click(button());
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        "The recovery key doesn't open this vault.",
      ),
    );
    expect(within(dialog).getByLabelText('Passphrase')).toHaveValue(PASS);
    expect(within(dialog).getByLabelText('Recovery key')).toHaveValue('');
    expect(within(dialog).getByLabelText('Recovery key')).toHaveFocus();

    await fill(dialog, 'nope nope nope', 'LIBER-WRONG');
    await userEvent.click(button());
    await waitFor(() => expect(within(dialog).getAllByRole('alert')).toHaveLength(2));
    expect(sent('vault_decrypt_begin')).toHaveLength(3);
    // Still open, nothing held, and no secret kept anywhere.
    expect(useVaultStore.getState().status).toBe('open');
    expect(useUiStore.getState().held).toBe(false);
    expect(secretsKept()).not.toContain(PASS);
    expect(sent('vault_decrypt_run')).toEqual([]);
  });
});

describe('Decrypt in place: decrypting and done', () => {
  async function toRun() {
    backend();
    const dialog = await start();
    await toSecrets(dialog);
    await fill(dialog, PASS, CODE);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decrypt' }));
    await waitFor(() => expect(runGate).not.toBeNull());
    return dialog;
  }

  it('shows progress, held, then done: the vault opens as a plain vault', async () => {
    const dialog = await toRun();
    expect(sent('vault_decrypt_begin')).toEqual([{ passphrase: PASS, recovery: CODE }]);
    expect(secretsKept()).not.toContain(PASS);
    expect(secretsKept()).not.toContain(CODE);
    // The encrypted session closed: the Unlock screen waits behind the dialog.
    expect(useVaultStore.getState().status).toBe('locked');
    await act(() => emit('vault:decrypt-progress', { done: 3, total: 1204 }));
    expect(
      within(dialog).getByText(
        '3 of 1,204 files · each one is checked before anything encrypted is removed',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('progressbar', { name: 'Decrypting' })).toHaveAttribute(
      'value',
      '3',
    );
    expect(within(dialog).getByRole('status')).toHaveTextContent('3 of 1,204 files decrypted');
    expect(within(dialog).getByRole('button', { name: 'Stop and undo' })).toHaveFocus();
    expect(useUiStore.getState().held).toBe(true);
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
    expect((await axe.run(document.body)).violations).toEqual([]);
    await act(async () => runGate!.resolve(plain));
    expect(
      await within(dialog).findByText(
        '1,204 files decrypted and checked. “Myproject” is no longer encrypted, and its passphrase and recovery key no longer work.',
      ),
    ).toBeInTheDocument();
    expect(useVaultStore.getState().status).toBe('open');
    expect(useVaultStore.getState().info?.encrypted).toBe(false);
    expect(useUiStore.getState().held).toBe(false);
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('Stop and undo: back as it was, still encrypted, at the Unlock screen', async () => {
    const dialog = await toRun();
    expect(within(dialog).getByRole('button', { name: 'Stop and undo' })).toBeDisabled();
    await act(() => emit('vault:decrypt-progress', { done: 1, total: 1204 }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop and undo' }));
    expect(sent('vault_decrypt_cancel')).toHaveLength(1);
    await act(async () => runGate!.reject({ kind: 'cancelled', message: 'stopped' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Stopped. The vault is back as it was.',
    );
    expect(useVaultStore.getState().status).toBe('locked');
    expect(useVaultStore.getState().lockedPath).toBe(ROOT);
    expect(useUiStore.getState().held).toBe(false);
  });

  it.each([
    [
      'changedDuringDecrypt',
      'Files changed while decrypting — probably a sync service. The vault is still encrypted. Pause syncing and try again.',
    ],
    [
      'decryptUndoFailed',
      `Undoing the decryption of ${ROOT} didn't finish. The encrypted vault is safe in its hidden .liber-encrypted folder. Open the folder again to finish the undo.`,
    ],
  ])('%s says what happened', async (kind, text) => {
    const dialog = await toRun();
    await act(async () => runGate!.reject({ kind, message: ROOT }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
  });

  it('a run in progress refuses switching vaults: it says to wait', async () => {
    await toRun();
    await act(() => useVaultStore.getState().open('/other'));
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Wait until decrypting finishes.');
    expect(sent('vault_open')).toEqual([]);
  });

  it('Stop and undo turns off once the last file is done (review L9)', async () => {
    const dialog = await toRun();
    await act(() => emit('vault:decrypt-progress', { done: 1203, total: 1204 }));
    expect(within(dialog).getByRole('button', { name: 'Stop and undo' })).toBeEnabled();
    await act(() => emit('vault:decrypt-progress', { done: 1204, total: 1204 }));
    expect(within(dialog).getByRole('button', { name: 'Stop and undo' })).toBeDisabled();
  });

  it('a cleanup that did not finish is said, never "no longer work" (review 6e)', async () => {
    const dialog = await toRun();
    const left = `${ROOT}/.liber-encrypted`;
    await act(async () => runGate!.resolve({ ...plain, keysLeft: left }));
    expect(await within(dialog).findByText(/cleaning up didn't finish/)).toBeVisible();
    expect(within(dialog).getByText(left)).toBeVisible();
    expect(within(dialog).queryByText(/no longer work/)).toBeNull();
    expect((await axe.run(document.body)).violations).toEqual([]);
  });

  it('a failure past staged opens the folder as the plain vault it is (review L8)', async () => {
    const dialog = await toRun();
    await act(async () => runGate!.reject({ kind: 'decryptFinishFailed', message: ROOT }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/couldn't finish yet/);
    expect(sent('vault_open')).toEqual([{ path: ROOT }]);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(useVaultStore.getState().info?.encrypted).toBe(false);
  });
});

describe('Decrypt in place: sync archives (review 6c)', () => {
  it('are named in the intro', async () => {
    backend({ archives: ['.stversions'] });
    const dialog = await start();
    expect(
      await within(dialog).findByText(/^\.stversions at the top of this folder/),
    ).toBeVisible();
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});
