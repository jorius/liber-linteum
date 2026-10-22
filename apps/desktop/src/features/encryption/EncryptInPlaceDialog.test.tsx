// @vitest-environment jsdom
// Encrypt in place (encryption UX §4.2 as amended by §8): intro, preflight,
// passphrase, the recovery key BEFORE copying, progress, done, and errors.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockIPC } from '../../ipc/testing';
import { mayClose, useEditorStore } from '../../stores/editorStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { openAnotherVault } from '../shell/shellMenu';
import { openNewVault } from './CreateEncryptedHost';
import { EncryptInPlaceHost, OriginalsBanner } from './EncryptInPlaceDialog';
import { openEncryptInPlace } from './encryptInPlace';

const prompt = vi.hoisted(() => ({ asked: 0 }));
vi.mock('../editor/unsavedPrompt', () => ({
  needsUnsavedPrompt: () => true,
  confirmUnsaved: async () => {
    prompt.asked++;
    return true;
  },
}));

const CODE = `LIBER-${Array.from({ length: 14 }, (_, i) => `G${String(i + 1).padStart(2, '0')}X`).join('-')}`;
const PASS = 'correct horse battery';
const ROOT = '/v/Smartjob';
const report = {
  files: 0,
  pages: 0,
  parsed: 0,
  skippedUnchanged: 0,
  removed: 0,
  warnings: [],
  durationMs: 1,
};
const plain = { name: 'Smartjob', root: ROOT, report };
const encrypted = (pending = false) => ({ ...plain, encrypted: true, originalsPending: pending });

interface Deferred {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

let calls: [string, Record<string, unknown>][] = [];
let order: string[] = [];
let runGate: Deferred | null = null;
let beginGate: Deferred | null = null;
let backupGate: Deferred | null = null;

function backend(
  opts: {
    blocked?: { path: string; reason: string }[];
    preflightError?: object;
    beginError?: object;
    closesOpen?: boolean;
    holdBegin?: boolean;
    kind?: string;
    pending?: boolean;
    /** §9: what the backup folder dialog picks (after the checks). */
    pick?: string | null;
    pickError?: object;
  } = {},
) {
  calls = [];
  order = [];
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push([cmd, a]);
      order.push(cmd);
      if (cmd === 'folder_kind') return opts.kind ?? 'plain';
      if (cmd === 'vault_encrypt_preflight') {
        if (opts.preflightError) throw opts.preflightError;
        return {
          files: 1204,
          bytes: 9,
          blocked: opts.blocked ?? [],
          closesOpen: opts.closesOpen ?? false,
        };
      }
      if (cmd === 'vault_encrypt_begin') {
        if (opts.beginError) throw opts.beginError;
        if (opts.holdBegin)
          return new Promise((resolve, reject) => {
            beginGate = { resolve, reject };
          });
        return { recovery: CODE };
      }
      if (cmd === 'vault_encrypt_run')
        return new Promise((resolve, reject) => {
          runGate = { resolve, reject };
        });
      if (cmd === 'vault_encrypt_pick_backup') {
        if (opts.pickError) throw opts.pickError;
        return opts.pick ?? null;
      }
      if (cmd === 'vault_encrypt_backup')
        return new Promise((resolve, reject) => {
          backupGate = { resolve, reject };
        });
      if (cmd === 'vault_open') return plain;
      if (cmd === 'vault_tree') return [];
      return null;
    },
    { shouldMockEvents: true },
  );
}

const sent = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

/** The plain vault open on screen, its pages saved by `saveAll`. */
function openPlain(unsaved: string[] = []) {
  useVaultStore.setState({ status: 'open', info: plain });
  useEditorStore.setState({
    saveAll: async () => {
      order.push('saveAll');
      return unsaved;
    },
  });
}

async function start(root = ROOT) {
  render(<EncryptInPlaceHost />);
  await act(() => openEncryptInPlace(root));
  const dialog = await screen.findByRole('dialog', { name: 'Encrypt “Smartjob”' });
  return dialog;
}

async function toPassphrase(dialog: HTMLElement) {
  await within(dialog).findByText(/1,204 files\./);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  // §9: no readable copy (the backup step has its own tests).
  await userEvent.click(within(dialog).getByRole('radio', { name: "Don't keep a copy" }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Choose a passphrase…' }));
  expect(within(dialog).getByLabelText('Passphrase')).toHaveFocus();
  await userEvent.type(within(dialog).getByLabelText('Passphrase'), PASS);
  await userEvent.type(within(dialog).getByLabelText('Confirm passphrase'), PASS);
}

/** Through the passphrase to the recovery key. */
async function toKey(dialog: HTMLElement) {
  await toPassphrase(dialog);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  expect(await within(dialog).findByTestId('recovery-code')).toHaveTextContent(CODE);
}

/** Types back the two groups asked for and confirms. */
async function confirmKey(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole('button', { name: "I've saved it" }));
  for (const input of within(dialog).getAllByRole('textbox')) {
    const n = Number(/Group (\d+)/.exec(input.closest('label')!.textContent!)![1]);
    await userEvent.type(input, CODE.split('-')[n]);
  }
  await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
}

const secretsKept = () =>
  JSON.stringify([
    useUiStore.getState(),
    useVaultStore.getState(),
    useToastStore.getState().toasts,
  ]);

beforeEach(() => {
  prompt.asked = 0;
  runGate = null;
  beginGate = null;
  backupGate = null;
});

afterEach(async () => {
  useUiStore.getState().closeDialog();
  useToastStore.getState().clear();
  await resetVaultStore();
  clearMocks();
});

describe('Encrypt in place: intro and preflight', () => {
  it('names the vault with the Beta chip, counts the files and warns about copies and sync', async () => {
    backend();
    openPlain();
    const dialog = await start();
    expect(within(dialog).getByText('Beta')).toHaveClass('liber-chip');
    expect(
      within(dialog).getByText(/Every page, folder name and attachment in this folder/),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText(/1,204 files\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/backups, Time Machine/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Pause Dropbox, iCloud or other sync for this folder while it runs.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Syncthing, its \.stversions folder keeps/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toHaveFocus();
    expect((await axe.run(document.body)).violations).toEqual([]);
    // Cancel: nothing changes.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(useUiStore.getState().dialog).toBeNull();
    expect(sent('vault_encrypt_begin')).toEqual([]);
    expect(useVaultStore.getState().status).toBe('open');
  });

  it('a blocked preflight lists each path and why, and only closes', async () => {
    backend({
      blocked: [
        { path: 'a:b.md', reason: 'badChar' },
        { path: '.git', reason: 'git' },
        { path: 'Photos/x.jpg.icloud', reason: 'cloud' },
      ],
    });
    openPlain();
    const dialog = await start();
    expect(await within(dialog).findByText('a:b.md')).toBeInTheDocument();
    expect(within(dialog).getByText(/a git repository: encrypting it would break/)).toBeVisible();
    expect(within(dialog).getByText('Photos/x.jpg.icloud')).toBeInTheDocument();
    expect(within(dialog).getByText(/only in the cloud: download it first/)).toBeVisible();
    expect(within(dialog).getByText('Rename or remove these, then try again.')).toBeVisible();
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Close']);
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().dialog).toBeNull();
    expect(sent('vault_encrypt_begin')).toEqual([]);
  });

  it('a refused preflight says why and only closes', async () => {
    backend({ preflightError: { kind: 'damaged', message: 'x' } });
    const dialog = await start();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('damaged');
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Close']);
  });
});

describe('Encrypt in place: the readable backup (§9)', () => {
  const COPY = '/backups/Smartjob copy';

  async function toBackup(dialog: HTMLElement) {
    await within(dialog).findByText(/1,204 files\./);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    return within(dialog).getByRole('group', { name: 'Keep a readable copy?' });
  }

  it('asks, with no default; keeping one needs a folder, and says plainly it is not encrypted', async () => {
    backend({ pick: COPY });
    openPlain();
    const dialog = await start();
    const group = await toBackup(dialog);
    const keep = within(group).getByRole('radio', { name: 'Keep a readable copy' });
    const skip = within(group).getByRole('radio', { name: "Don't keep a copy" });
    expect(keep).not.toBeChecked();
    expect(skip).not.toBeChecked();
    expect(keep).toHaveFocus();
    expect(within(dialog).getByText(/Trash as “Smartjob \(unencrypted originals\)”/)).toBeVisible();
    const next = within(dialog).getByRole('button', { name: 'Choose a passphrase…' });
    expect(next).toBeDisabled();
    await userEvent.click(keep);
    expect(within(dialog).getByText(/The copy is not encrypted/)).toBeVisible();
    expect(within(dialog).getByText(/before anything is encrypted/)).toBeVisible();
    expect(next).toBeDisabled();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose…' }));
    expect(sent('vault_encrypt_pick_backup')).toEqual([{ path: ROOT }]);
    expect(await within(dialog).findByText(COPY)).toBeInTheDocument();
    expect(next).toBeEnabled();
    expect((await axe.run(document.body)).violations).toEqual([]);
    // Don't keep one: no folder needed.
    await userEvent.click(skip);
    expect(within(dialog).queryByText(/The copy is not encrypted/)).toBeNull();
    expect(next).toBeEnabled();
  });

  it('a refused folder says why, and Choose a passphrase stays off', async () => {
    backend({ pickError: { kind: 'backupNotEmpty', message: '/backups/full' } });
    openPlain();
    const dialog = await start();
    const group = await toBackup(dialog);
    await userEvent.click(within(group).getByRole('radio', { name: 'Keep a readable copy' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose…' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "/backups/full isn't empty. Pick an empty or new folder for the copy.",
    );
    expect(within(dialog).getByRole('button', { name: 'Choose a passphrase…' })).toBeDisabled();
    expect((await axe.run(document.body)).violations).toEqual([]);
  });

  async function toCopying() {
    backend({ pick: COPY });
    openPlain();
    const dialog = await start();
    const group = await toBackup(dialog);
    await userEvent.click(within(group).getByRole('radio', { name: 'Keep a readable copy' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose…' }));
    await within(dialog).findByText(COPY);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose a passphrase…' }));
    await userEvent.type(within(dialog).getByLabelText('Passphrase'), PASS);
    await userEvent.type(within(dialog).getByLabelText('Confirm passphrase'), PASS);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(backupGate).not.toBeNull());
    return dialog;
  }

  it('copies and checks it after begin and before the key; done says where it is', async () => {
    const dialog = await toCopying();
    expect(sent('vault_encrypt_begin')).toEqual([{ path: ROOT, passphrase: PASS, backup: true }]);
    // The key waits for the copy (nothing is encrypted before it is made).
    expect(within(dialog).queryByTestId('recovery-code')).toBeNull();
    await act(() => emit('vault:encrypt-progress', { done: 2, total: 1204 }));
    expect(
      within(dialog).getByText(
        '2 of 1,204 files copied · each copy is checked before anything is encrypted',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('progressbar', { name: 'Copying' })).toHaveAttribute(
      'value',
      '2',
    );
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 of 1,204 files copied');
    expect(within(dialog).getByRole('button', { name: 'Stop and undo' })).toHaveFocus();
    expect(useUiStore.getState().held).toBe(true);
    expect((await axe.run(document.body)).violations).toEqual([]);
    expect(sent('vault_encrypt_run')).toEqual([]);
    await act(async () => backupGate!.resolve(null));
    expect(await within(dialog).findByTestId('recovery-code')).toHaveTextContent(CODE);
    await confirmKey(dialog);
    await waitFor(() => expect(runGate).not.toBeNull());
    await act(async () => runGate!.resolve(encrypted()));
    expect(await within(dialog).findByText(/A readable copy is in this folder/)).toBeVisible();
    expect(within(dialog).getByText(COPY)).toBeVisible();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: /^Show in / }));
    expect(sent('vault_reveal_backup')).toHaveLength(1);
  });

  it('a copy that fails encrypts nothing: said why, and the plain vault is back', async () => {
    const dialog = await toCopying();
    await act(async () =>
      backupGate!.reject({ kind: 'backupFailed', message: 'Notes.md: disk full' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "The readable copy couldn't be made (Notes.md: disk full). Nothing was encrypted.",
    );
    expect(within(dialog).queryByTestId('recovery-code')).toBeNull();
    expect(sent('vault_encrypt_run')).toEqual([]);
    expect(sent('vault_open')).toEqual([{ path: ROOT }]);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(useUiStore.getState().held).toBe(false);
    expect(secretsKept()).not.toContain(CODE);
  });

  it('Stop and undo during the copy undoes the begin', async () => {
    const dialog = await toCopying();
    await act(() => emit('vault:encrypt-progress', { done: 1, total: 1204 }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop and undo' }));
    expect(sent('vault_encrypt_cancel')).toHaveLength(1);
    await act(async () => backupGate!.reject({ kind: 'cancelled', message: 'stopped' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Stopped. The vault is back as it was.',
    );
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
  });
});

describe('Encrypt in place: passphrase and recovery key', () => {
  it('saves every page without asking, leaves the vault, begins, then shows the key before any copy', async () => {
    backend();
    openPlain();
    const dialog = await start();
    await toPassphrase(dialog);
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByTestId('recovery-code')).toHaveTextContent(CODE);
    expect(prompt.asked).toBe(0);
    expect(order.indexOf('saveAll')).toBeLessThan(order.indexOf('vault_encrypt_begin'));
    expect(sent('vault_encrypt_begin')).toEqual([{ path: ROOT, passphrase: PASS, backup: false }]);
    // Begin closed the plain session: the shell went with it.
    expect(useVaultStore.getState().status).toBe('closed');
    // Not yet: the key is confirmed first (§8.1).
    expect(sent('vault_encrypt_run')).toEqual([]);
    expect(secretsKept()).not.toContain(PASS);
    expect(secretsKept()).not.toContain(CODE);
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: "I've saved it" }));
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(sent('vault_encrypt_run')).toEqual([]);
  });

  it('a page that cannot be saved stops it: the unsaved toast, no begin, the passphrase cleared', async () => {
    backend();
    openPlain(['Notes/Plan.md']);
    const dialog = await start();
    await toPassphrase(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/Plan/));
    expect(sent('vault_encrypt_begin')).toEqual([]);
    expect(useVaultStore.getState().status).toBe('open');
    expect(within(dialog).getByLabelText('Passphrase')).toHaveValue('');
    expect(within(dialog).getByLabelText('Confirm passphrase')).toHaveValue('');
    expect(useUiStore.getState().held).toBe(false);
  });

  it('a refused begin is said inline, the passphrase cleared and the plain vault back', async () => {
    backend({ beginError: { kind: 'convertWindowsOpen', message: ROOT } });
    openPlain();
    const dialog = await start();
    await toPassphrase(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    // Final review I1: the backend's reason, not "That isn't allowed here."
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Close the windows showing files from this folder first.',
    );
    expect(within(dialog).getByLabelText('Passphrase')).toHaveValue('');
    expect(sent('vault_open')).toEqual([{ path: ROOT }]);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(useUiStore.getState().held).toBe(false);
    expect(secretsKept()).not.toContain(PASS);
  });

  it('is held from begin: nothing replaces it, Escape, a lock or Close leave it up', async () => {
    backend();
    // Another vault, encrypted, open behind (the New vault dialog's way in).
    useVaultStore.setState({
      status: 'open',
      info: { ...plain, name: 'Enc', root: '/v/Enc', encrypted: true },
    });
    useEditorStore.setState({ saveAll: async () => [] });
    const dialog = await start();
    await toKey(dialog);
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('recovery-code')).toBeInTheDocument();
    await act(() => useVaultStore.getState().lock('idle'));
    expect(useVaultStore.getState().status).toBe('locked');
    expect(screen.getByTestId('recovery-code')).toBeInTheDocument();
    // Back from Unlock is a vault switch: refused while converting.
    await act(() => useVaultStore.getState().cancelUnlock());
    expect(useVaultStore.getState().status).toBe('locked');
    expect(screen.getByTestId('recovery-code')).toBeInTheDocument();
    expect(useUiStore.getState().dialog).toEqual({ type: 'encryptInPlace', root: ROOT });
  });
});

describe('Encrypt in place: final round', () => {
  it('Cancel at the recovery-key step undoes the begin: no copy, the plain vault back', async () => {
    backend();
    openPlain();
    const dialog = await start();
    await toKey(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Stopped. The vault is back as it was.',
    );
    expect(sent('vault_encrypt_cancel')).toHaveLength(1);
    expect(sent('vault_encrypt_run')).toEqual([]);
    expect(sent('vault_open')).toEqual([{ path: ROOT }]);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(useUiStore.getState().held).toBe(false);
    expect(within(dialog).queryByTestId('recovery-code')).toBeNull();
    expect(secretsKept()).not.toContain(CODE);
  });

  it('the open vault begin closes under another spelling (preflight says so) is left, and comes back', async () => {
    backend({ closesOpen: true });
    useVaultStore.setState({ status: 'open', info: { ...plain, root: '/private/v/Smartjob' } });
    useEditorStore.setState({ saveAll: async () => [] });
    const dialog = await start();
    await toKey(dialog);
    expect(useVaultStore.getState().status).toBe('closed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sent('vault_open')).toEqual([{ path: '/private/v/Smartjob' }]));
  });

  it('from begin until it ends, no entry point switches vaults: it says to wait', async () => {
    backend();
    openPlain();
    const dialog = await start();
    await toKey(dialog);
    const wait = 'Wait until encrypting finishes.';
    const said = () => useToastStore.getState().toasts.at(-1)?.message;
    for (const [name, attempt] of [
      ['open', () => useVaultStore.getState().open('/v/Other')],
      ['Quick notes', () => useVaultStore.getState().openScratchpad()],
      ['create', () => useVaultStore.getState().create('/v/New')],
      ['close', () => useVaultStore.getState().close()],
      ['menu lock', () => useVaultStore.getState().lock('menu')],
      ['New vault', () => openNewVault()],
      ['Open another vault', async () => openAnotherVault()],
    ] as const) {
      useToastStore.getState().clear();
      await act(async () => {
        await attempt();
      });
      expect(said(), name).toBe(wait);
    }
    expect(sent('vault_open')).toEqual([]);
    expect(sent('scratchpad_open')).toEqual([]);
    expect(sent('vault_create')).toEqual([]);
    expect(sent('plugin:dialog|open')).toEqual([]);
    expect(useUiStore.getState().dialog).toEqual({ type: 'encryptInPlace', root: ROOT });
    // Once it ends, switching works again.
    await confirmKey(dialog);
    await waitFor(() => expect(runGate).not.toBeNull());
    await act(async () => runGate!.resolve(encrypted()));
    await within(dialog).findByRole('button', { name: 'Open' });
    useToastStore.getState().clear();
    await act(() => useVaultStore.getState().open('/v/Other'));
    expect(sent('vault_open')).toEqual([{ path: '/v/Other' }]);
  });
});

describe('Encrypt in place: encrypting, done and errors', () => {
  async function toRun() {
    backend();
    openPlain();
    const dialog = await start();
    await toKey(dialog);
    await confirmKey(dialog);
    await waitFor(() => expect(runGate).not.toBeNull());
    return dialog;
  }

  it('shows progress, still held, then done: the vault opens unlocked in the shell', async () => {
    const dialog = await toRun();
    expect(within(dialog).queryByTestId('recovery-code')).toBeNull();
    await act(() => emit('vault:encrypt-progress', { done: 3, total: 1204 }));
    // M1: announced, but not every file (every 10 % or 5 s).
    expect(within(dialog).getByRole('status')).toHaveTextContent('3 of 1,204 files encrypted');
    await act(() => emit('vault:encrypt-progress', { done: 4, total: 1204 }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('3 of 1,204 files encrypted');
    await act(() => emit('vault:encrypt-progress', { done: 200, total: 1204 }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('200 of 1,204 files encrypted');
    await act(() => emit('vault:encrypt-progress', { done: 3, total: 1204 }));
    expect(
      within(dialog).getByText(
        '3 of 1,204 files · each one is checked before the original is moved',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('progressbar', { name: 'Encrypting' })).toHaveAttribute(
      'value',
      '3',
    );
    expect(within(dialog).getByRole('button', { name: 'Stop and undo' })).toHaveFocus();
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
    expect((await axe.run(document.body)).violations).toEqual([]);
    await act(() => emit('vault:encrypt-progress', { done: 1204, total: 1204 }));
    await act(async () => runGate!.resolve(encrypted()));
    expect(
      await within(dialog).findByText(
        "1,204 files encrypted and checked. The unencrypted originals are in the Trash as “Smartjob (unencrypted originals)”: empty it when you're happy.",
      ),
    ).toBeInTheDocument();
    expect(useVaultStore.getState().status).toBe('open');
    expect(useVaultStore.getState().info?.encrypted).toBe(true);
    expect(useUiStore.getState().held).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Open' })).toHaveFocus();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    expect(useUiStore.getState().dialog).toBeNull();
    expect(sent('vault_open')).toEqual([]);
    expect(secretsKept()).not.toContain(PASS);
  });

  it('Stop and undo cancels; the plain vault is back and the dialog lets go', async () => {
    const dialog = await toRun();
    // M3: Stop waits for the run to have started.
    expect(within(dialog).getByRole('button', { name: 'Stop and undo' })).toBeDisabled();
    await act(() => emit('vault:encrypt-progress', { done: 1, total: 1204 }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop and undo' }));
    expect(sent('vault_encrypt_cancel')).toHaveLength(1);
    await act(async () => runGate!.reject({ kind: 'cancelled', message: 'stopped' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Stopped. The vault is back as it was.',
    );
    expect(sent('vault_open')).toEqual([{ path: ROOT }]);
    await waitFor(() => expect(useVaultStore.getState().info?.root).toBe(ROOT));
    expect(useVaultStore.getState().status).toBe('open');
    expect(useUiStore.getState().held).toBe(false);
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it.each([
    [
      'changedDuringConvert',
      'Files changed while encrypting — probably a sync service. Nothing was changed. Pause syncing and try again.',
    ],
    [
      'convertingElsewhere',
      'This vault is being encrypted on another device. Finish there, or wait for sync to finish.',
    ],
  ])('%s is said, and the plain vault is back', async (kind, text) => {
    const dialog = await toRun();
    await act(async () => runGate!.reject({ kind, message: 'x' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
    expect(sent('vault_open')).toEqual([{ path: ROOT }]);
    expect(useUiStore.getState().held).toBe(false);
  });

  it('originals the Trash refused: said, with Move to Trash and Show in Finder', async () => {
    const dialog = await toRun();
    await act(async () => runGate!.resolve(encrypted(true)));
    expect(
      await within(dialog).findByText(
        /couldn't be moved to the Trash: they're still in the vault folder/,
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Show in / }));
    expect(sent('vault_reveal_originals')).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }));
    expect(sent('vault_trash_originals')).toHaveLength(1);
    expect(
      await within(dialog).findByText(/in the Trash as “Smartjob \(unencrypted originals\)”/),
    ).toBeInTheDocument();
    expect(useVaultStore.getState().info?.originalsPending).toBe(false);
  });
});

describe('Encrypt in place: final review', () => {
  async function toRun() {
    backend();
    openPlain();
    const dialog = await start();
    await toKey(dialog);
    return dialog;
  }

  it.each([
    ['convertUndoFailed', /Your notes are safe in its hidden \.liber-plain folder/],
    ['convertFinishFailed', /stopped part-way and couldn't finish yet/],
    ['convertCollision', /is in the way.*Nothing was overwritten/],
    ['convertMismatch', /didn't read back the same after encrypting/],
  ])('%s says what happened, naming the folder', async (kind, text) => {
    const dialog = await toRun();
    await confirmKey(dialog);
    await waitFor(() => expect(runGate).not.toBeNull());
    await act(async () => runGate!.reject({ kind, message: ROOT }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).toHaveTextContent(ROOT);
  });

  it.each(['key', 'run'])(
    'a sleep or screen lock during the conversion (%s step) locks the vault once it opens',
    async (when) => {
      const dialog = await toRun();
      if (when === 'run') {
        await confirmKey(dialog);
        await waitFor(() => expect(runGate).not.toBeNull());
      }
      await act(() => emit('vault:lock-request', { reason: 'sleep' }));
      expect(sent('vault_lock')).toEqual([]);
      if (when === 'key') {
        await confirmKey(dialog);
        await waitFor(() => expect(runGate).not.toBeNull());
      }
      await act(async () => runGate!.resolve(encrypted()));
      await waitFor(() => expect(useVaultStore.getState().status).toBe('locked'));
      expect(sent('vault_lock')).toHaveLength(1);
      // The Done step stays, over the Unlock screen.
      expect(within(dialog).getByRole('button', { name: 'Open' })).toBeInTheDocument();
    },
  );

  it('quitting while it runs asks in the dialog; Keep encrypting goes back, Quit anyway quits', async () => {
    const dialog = await toRun();
    await confirmKey(dialog);
    await waitFor(() => expect(runGate).not.toBeNull());
    await act(() => emit('vault:encrypt-progress', { done: 1, total: 1204 }));
    const stop = within(dialog).getByRole('button', { name: 'Stop and undo' });
    expect(stop).toHaveFocus();
    expect(await act(() => mayClose())).toBe(false);
    const question = within(dialog).getByRole('alert');
    expect(question).toHaveTextContent(
      'Encrypting “Smartjob”… Quit anyway? It will finish or undo itself next time you open it.',
    );
    const keep = within(question).getByRole('button', { name: 'Keep encrypting' });
    expect(keep).toHaveFocus();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(keep);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(stop).toHaveFocus();
    expect(sent('window_close_self')).toEqual([]);
    expect(await act(() => mayClose())).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quit anyway' }));
    await waitFor(() => expect(sent('window_close_self')).toHaveLength(1));
  });

  it('a sleep while begin is still working (Argon2) also locks the vault once it opens', async () => {
    backend({ holdBegin: true });
    openPlain();
    const dialog = await start();
    await toPassphrase(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(beginGate).not.toBeNull());
    await act(() => emit('vault:lock-request', { reason: 'screenLock' }));
    await act(async () => beginGate!.resolve({ recovery: CODE }));
    await within(dialog).findByTestId('recovery-code');
    await confirmKey(dialog);
    await waitFor(() => expect(runGate).not.toBeNull());
    await act(async () => runGate!.resolve(encrypted()));
    await waitFor(() => expect(useVaultStore.getState().status).toBe('locked'));
  });

  it("another device's unfinished copy: Undo it on this device, confirmed, then it opens", async () => {
    let undone = false;
    calls = [];
    mockIPC(
      (cmd, args) => {
        calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
        if (cmd === 'vault_open') {
          if (!undone) throw { kind: 'convertingElsewhere', message: ROOT };
          return plain;
        }
        if (cmd === 'vault_encrypt_undo_elsewhere') undone = true;
        if (cmd === 'vault_tree') return [];
        return null;
      },
      { shouldMockEvents: true },
    );
    render(<EncryptInPlaceHost />);
    await act(() => useVaultStore.getState().open(ROOT));
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.message).toMatch(/being encrypted on another device/);
    expect(toast.action?.label).toBe('Undo it on this device…');
    act(() => toast.action!.run());
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Undo encrypting on this device?',
    });
    expect(confirm).toHaveTextContent(
      "Only do this if the other device isn't encrypting this folder right now. The vault goes back to unencrypted.",
    );
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Undo it on this device' }));
    expect(sent('vault_encrypt_undo_elsewhere')).toEqual([{ path: ROOT }]);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(useUiStore.getState().dialog).toBeNull();
  });
});

describe('the originals banner (§8.8)', () => {
  function shell(pending: boolean) {
    useVaultStore.setState({ status: 'open', info: encrypted(pending) });
    return render(<OriginalsBanner />);
  }

  it('shows for an unlocked vault whose originals are still there; its actions call the backend', async () => {
    backend();
    shell(true);
    expect(
      screen.getByText('The unencrypted originals of this vault are still in its folder.'),
    ).toBeInTheDocument();
    expect((await axe.run(document.body)).violations).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: /^Show in / }));
    expect(sent('vault_reveal_originals')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(sent('vault_trash_originals')).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByText(/unencrypted originals of this vault/)).toBeNull(),
    );
    expect(useVaultStore.getState().info?.originalsPending).toBe(false);
  });

  it('a refused Move to Trash is toasted and the banner stays', async () => {
    mockIPC((cmd) => {
      if (cmd === 'vault_trash_originals') throw { kind: 'io', message: 'no trash' };
    });
    shell(true);
    await userEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'Something went wrong: no trash',
      ),
    );
    expect(screen.getByText(/unencrypted originals of this vault/)).toBeInTheDocument();
  });

  it('dismissed, it stays away for this session', async () => {
    backend();
    const first = shell(true);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/unencrypted originals of this vault/)).toBeNull();
    first.unmount();
    shell(true);
    expect(screen.queryByText(/unencrypted originals of this vault/)).toBeNull();
  });

  it('is not shown when nothing is pending', () => {
    backend();
    shell(false);
    expect(screen.queryByText(/unencrypted originals of this vault/)).toBeNull();
  });
});
