// @vitest-environment jsdom
// E4 final review: leaving a vault (lock, Close, Back) leaves nothing of it on
// screen or in memory, except a recovery code still to be confirmed; the
// voided-key prompt comes back after the next unlock of that vault.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore, type DialogState } from '../../stores/uiStore';
import { onLeaveVault } from '../../stores/leaveVault';
import { openNewVault } from './CreateEncryptedHost';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { useBinStore } from '../bin/binStore';
import { confirmUnsaved } from '../editor/unsavedPrompt';
import { useEditorStore } from '../../stores/editorStore';

const PASS = 'correct horse battery';
const GROUPS = Array.from({ length: 14 }, (_, i) => `G${String(i + 1).padStart(2, '0')}0`);
const CODE = `LIBER-${GROUPS.join('-')}`;
const info = (root: string, extra: object = {}) => ({
  name: root.slice(1),
  root,
  report: { pages: 0, warnings: [] },
  encrypted: true,
  ...extra,
});

let voidOnce: Set<string>;
let release: (() => void) | null;
let calls: string[];
let failRecovery: boolean;

beforeEach(() => {
  voidOnce = new Set(['/v']);
  release = null;
  failRecovery = false;
  calls = [];
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useToastStore.getState().clear();
  mockIPC(
    (cmd, raw) => {
      calls.push(cmd);
      const args = (raw ?? {}) as Record<string, unknown>;
      if (cmd === 'vault_unlock') {
        const root = args.path as string;
        // E3 reports a voided key once: on the unlock that merged the headers.
        const voided = voidOnce.delete(root);
        return info(root, voided ? { recoveryVoid: true } : {});
      }
      if (cmd === 'vault_open') return info(args.path as string, { encrypted: false });
      if (cmd === 'vault_tree') return [];
      if (cmd === 'vault_lock' || cmd === 'vault_close') return null;
      if (cmd === 'bin_list')
        return { trash: [{ path: '.trash/a.md', from: 'a.md' }], archive: [] };
      if (cmd === 'security_new_recovery') {
        if (!release) return CODE;
        return new Promise(
          (r, no) =>
            (release = () => (failRecovery ? no({ kind: 'io', message: 'gone' }) : r(CODE))),
        );
      }
      if (cmd === 'settings_set') return { ...DEFAULT_SETTINGS, ...(args.patch as object) };
      return null;
    },
    { shouldMockEvents: true },
  );
});

afterEach(async () => {
  useUiStore.getState().closeDialog();
  await resetVaultStore();
  useToastStore.getState().clear();
  clearMocks();
  vi.restoreAllMocks();
});

const unlock = (root: string) =>
  act(async () => {
    useVaultStore.setState({ status: 'locked', lockedPath: root });
    await useVaultStore.getState().unlock({ kind: 'passphrase', value: PASS });
  });

const unlockField = () => screen.getByLabelText('Passphrase') as HTMLInputElement;

/** Types the two groups the confirm step asks for, then Done. */
async function confirmCode() {
  await userEvent.click(screen.getByRole('button', { name: "I've saved it" }));
  for (const el of screen.getAllByLabelText(/^Group \d+$/)) {
    const n = Number(el.id.replace(/.*-/, ''));
    await userEvent.type(el, GROUPS[n - 1]);
  }
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
}

/** Settings → Security → New recovery key, up to the code. */
async function newRecoveryCode() {
  act(() => void useUiStore.getState().openDialog({ type: 'newRecovery', root: '/other' }));
  const dialog = screen.getByRole('dialog', { name: 'New recovery key' });
  await userEvent.type(within(dialog).getByLabelText('Current passphrase'), PASS);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  await screen.findByTestId('recovery-code');
}

describe('C1: the voided-key prompt and a lock', () => {
  it('a lock closes the prompt; the next unlock of that vault shows it again, not another vault', async () => {
    render(<App />);
    await unlock('/v');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('replaced on another device');

    await act(() => useVaultStore.getState().lock('idle'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useUiStore.getState().dialog).toBeNull();
    unlockField().focus();
    expect(unlockField()).toHaveFocus();

    // Back, another vault: no prompt there.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await unlock('/other');
    expect(useVaultStore.getState().status).toBe('open');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(() => useVaultStore.getState().lock('menu'));

    // The voided vault again: E3 doesn't report it this time, the prompt still comes back.
    await unlock('/v');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('replaced on another device');
    expect(localStorage.length).toBe(0);
  });

  it('a lock while making the new key from the prompt parks the prompt too', async () => {
    render(<App />);
    await unlock('/v');
    await userEvent.click(await screen.findByRole('button', { name: 'Make a new recovery key' }));
    expect(screen.getByRole('dialog', { name: 'New recovery key' })).toBeInTheDocument();
    await act(() => useVaultStore.getState().lock('idle'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await unlock('/v');
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('is shown only while a vault is open', () => {
    render(<App />);
    act(() => {
      useVaultStore.setState({ status: 'locked', lockedPath: '/v' });
      useUiStore.setState({ dialog: { type: 'recoveryVoid', root: '/v' } });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('I1: a new recovery key outlives Settings, lock and Close', () => {
  it('Settings → New recovery key opens the app-level dialog in place of Settings', async () => {
    render(<App />);
    await unlock('/other');
    act(() => void useUiStore.getState().openDialog({ type: 'settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    await userEvent.click(within(settings).getByRole('button', { name: /^Security/ }));
    await userEvent.click(within(settings).getByRole('button', { name: 'New recovery key…' }));
    expect(useUiStore.getState().dialog).toEqual({ type: 'newRecovery', root: '/other' });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New recovery key' })).toBeInTheDocument();
  });

  it('the code stays over the Unlock screen after a lock, keeps the keyboard, and Done drops it', async () => {
    render(<App />);
    await unlock('/other');
    await newRecoveryCode();
    await act(() => useVaultStore.getState().lock('sleep'));
    expect(useVaultStore.getState().status).toBe('locked');
    expect(screen.getByTestId('unlock-screen')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-code')).toHaveTextContent(CODE);
    expect(screen.getByRole('dialog', { name: 'New recovery key' })).toContainElement(
      document.activeElement as HTMLElement,
    );
    await confirmCode();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState()).toMatchObject({ dialog: null, held: false });
    await waitFor(() => expect(unlockField()).toHaveFocus());
  });

  it('a lock while the new key is being made still shows the code', async () => {
    render(<App />);
    await unlock('/other');
    release = () => undefined; // the backend answers later
    act(() => void useUiStore.getState().openDialog({ type: 'newRecovery', root: '/other' }));
    await userEvent.type(screen.getByLabelText('Current passphrase'), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Escape can't drop it while the backend is replacing the key.
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'New recovery key' })).toBeInTheDocument();
    await act(() => useVaultStore.getState().lock('idle'));
    act(() => release!());
    expect(await screen.findByTestId('recovery-code')).toHaveTextContent(CODE);
  });

  it('Vault → Close keeps the code on screen', async () => {
    render(<App />);
    await unlock('/other');
    await newRecoveryCode();
    await act(() => useVaultStore.getState().close());
    expect(useVaultStore.getState().status).toBe('closed');
    expect(screen.getByTestId('recovery-code')).toHaveTextContent(CODE);
  });

  it('⌘O’s unsaved question is refused (Cancel) while the code is held', async () => {
    render(<App />);
    await unlock('/other');
    await newRecoveryCode();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoSave: false } });
    vi.spyOn(useEditorStore.getState(), 'askPaths').mockReturnValue(['a.md']);
    expect(await confirmUnsaved()).toBe(false);
    expect(useUiStore.getState().dialog).toEqual({ type: 'newRecovery', root: '/other' });
  });
});

describe('I2: leaving a vault leaves nothing of it behind', () => {
  async function openWithLeftovers() {
    await unlock('/other');
    await act(() => useBinStore.getState().refresh());
    expect(useBinStore.getState().trash).toHaveLength(1);
    useToastStore.getState().push({ message: 'Recovered clip', detail: ['/other/Audio/a.wav'] });
    useUiStore.getState().openDialog({ type: 'move', path: 'secret/plan.md' });
  }

  function expectNothingLeft(clear: () => void) {
    expect(useUiStore.getState().dialog).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useBinStore.getState().trash).toEqual([]);
    expect(clear).toHaveBeenCalled();
  }

  it.each([
    ['lock', () => useVaultStore.getState().lock('idle')],
    ['lockedByBackend', async () => useVaultStore.getState().lockedByBackend('/other')],
    ['close', () => useVaultStore.getState().close()],
  ])('%s closes the dialog, clears toasts, the bin and content caches', async (_, leave) => {
    const clear = vi.fn();
    onLeaveVault(clear);
    await openWithLeftovers();
    await leave();
    expectNothingLeft(clear);
  });

  it('a pending unsaved question is answered Cancel', async () => {
    await unlock('/other');
    const answer = vi.fn();
    useUiStore.getState().openDialog({ type: 'unsaved', id: 1, paths: ['a.md'], answer });
    await useVaultStore.getState().lock('menu');
    expect(answer).toHaveBeenCalledWith('cancel');
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('a pending bin clash is answered no', async () => {
    await unlock('/other');
    const answer = vi.fn();
    useUiStore.getState().openDialog({ type: 'binClash', kind: 'trash', path: 'a.md', answer });
    await useVaultStore.getState().lock('menu');
    expect(answer).toHaveBeenCalledWith(false);
  });

  it('the shell is inert while the lock runs', async () => {
    let done!: () => void;
    mockIPC(
      (cmd, raw) => {
        if (cmd === 'vault_unlock') return info((raw as { path: string }).path);
        if (cmd === 'vault_lock') return new Promise((r) => (done = () => r(null)));
        return cmd === 'vault_tree' ? [] : null;
      },
      { shouldMockEvents: true },
    );
    const { container } = render(<App />);
    await unlock('/other');
    let locked!: Promise<boolean>;
    act(() => void (locked = useVaultStore.getState().lock('menu')));
    await waitFor(() => expect(container.querySelector('[inert]')).not.toBeNull());
    await act(async () => {
      done();
      await locked;
    });
    expect(container.querySelector('[inert]')).toBeNull();
  });
});

describe('second pass: the voided-key prompt belongs to its vault', () => {
  it('opening a plain vault parks it under its own vault, never the plain one', async () => {
    render(<App />);
    await unlock('/v');
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    // ⌘O to a plain vault (auto save on): the prompt doesn't follow.
    await act(() => useVaultStore.getState().open('/p'));
    expect(useVaultStore.getState().info?.root).toBe('/p');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useUiStore.getState().dialog).toBeNull();
    // Closing and reopening the plain vault: still nothing.
    await act(() => useVaultStore.getState().close());
    await act(() => useVaultStore.getState().open('/p'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(() => useVaultStore.getState().close());
    // The voided vault: back.
    await unlock('/v');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('replaced on another device');
  });

  it('switching from an encrypted vault to a plain one leaves nothing of it', async () => {
    const clear = vi.fn();
    onLeaveVault(clear);
    await unlock('/other');
    await act(() => useBinStore.getState().refresh());
    useToastStore.getState().push({ message: 'Recovered clip', detail: ['/other/Audio/a.wav'] });
    useUiStore.getState().openDialog({ type: 'move', path: 'secret/plan.md' });
    await useVaultStore.getState().open('/p');
    expect(useUiStore.getState().dialog).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(clear).toHaveBeenCalled();
  });

  it('a failed new key after a lock, then Cancel and Back, keeps the reminder for its vault', async () => {
    render(<App />);
    await unlock('/v');
    await userEvent.click(await screen.findByRole('button', { name: 'Make a new recovery key' }));
    release = () => undefined; // the backend answers later
    failRecovery = true;
    await userEvent.type(screen.getByLabelText('Current passphrase'), PASS);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(() => useVaultStore.getState().lock('idle'));
    await act(async () => release!());
    const dialog = await screen.findByRole('dialog', { name: 'New recovery key' });
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(useUiStore.getState().dialog).toBeNull();
    await unlock('/v');
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('second pass: New vault never drops a question or an import', () => {
  it.each([
    { type: 'unsaved', id: 1, paths: ['a.md'], answer: () => undefined },
    { type: 'binClash', kind: 'trash', path: 'a.md', answer: () => undefined },
    { type: 'notionImport' },
    { type: 'scratchpadSetup', then: 'quickNote' },
  ] satisfies Exclude<DialogState, null>[])('is refused over $type', async (d) => {
    useUiStore.getState().openDialog(d);
    await openNewVault();
    expect(useUiStore.getState().dialog).toBe(d);
  });

  it('takes the place of Settings', async () => {
    useUiStore.getState().openDialog({ type: 'settings' });
    await openNewVault();
    expect(useUiStore.getState().dialog).toEqual({ type: 'newVault' });
  });
});
