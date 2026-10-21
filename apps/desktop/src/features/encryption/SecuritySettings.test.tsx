// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { resetSettingsCategory, SettingsDialog } from '../dialogs/SettingsDialog';
import { CreateEncryptedHost } from './CreateEncryptedHost';
import { useUiStore } from '../../stores/uiStore';

const OLD = 'correct horse battery';
const NEW = 'another long passphrase';
const CODE = `LIBER-${Array.from({ length: 14 }, (_, i) => `G${String(i + 1).padStart(2, '0')}0`).join('-')}`;
const info = { name: 'enc', root: '/enc', report: { pages: 0, warnings: [] }, encrypted: true };

let calls: [string, Record<string, unknown>][];
let fail: { change?: string; recovery?: string };

beforeEach(() => {
  resetSettingsCategory();
  calls = [];
  fail = {};
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useToastStore.setState({ toasts: [] } as never);
  mockIPC((cmd, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    calls.push([cmd, args]);
    if (cmd === 'settings_set') return { ...DEFAULT_SETTINGS, ...(args.patch as object) };
    if (cmd === 'security_change_passphrase' && fail.change)
      throw { kind: fail.change, message: 'x' };
    if (cmd === 'security_new_recovery') {
      if (fail.recovery) throw { kind: fail.recovery, message: 'x' };
      return CODE;
    }
    if (cmd === 'vault_unreadable') return [];
    if (cmd === 'fonts_list') return [];
    return null;
  });
});
afterEach(async () => {
  await resetVaultStore();
  clearMocks();
  useUiStore.getState().closeDialog();
  vi.restoreAllMocks();
});

const openSecurity = async (encrypted: boolean) => {
  useVaultStore.setState({ info: encrypted ? (info as never) : null, status: 'open' });
  render(
    <>
      <SettingsDialog onClose={() => undefined} />
      <CreateEncryptedHost />
    </>,
  );
  await userEvent.click(
    within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', {
      name: /Security/,
    }),
  );
};

describe('Settings → Security', () => {
  it('is in the category list, with a Beta pill, and search finds it by "lock" and "passphrase"', async () => {
    render(<SettingsDialog onClose={() => undefined} />);
    const nav = screen.getByRole('navigation', { name: 'Settings categories' });
    const names = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names.indexOf('Security Beta')).toBe(names.indexOf('Files and quick notes') + 1);
    const security = () => within(screen.getByRole('group', { name: 'Security' }));
    await userEvent.type(screen.getByRole('searchbox'), 'lock');
    expect(security().getByText('Lock after inactivity')).toBeVisible();
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'passphrase');
    expect(security().getByText(/Open an encrypted vault to change its passphrase/)).toBeVisible();
  });

  it('saves the auto-lock choice, including Never', async () => {
    await openSecurity(false);
    const select = screen.getByRole('combobox', { name: 'Lock after inactivity' });
    await userEvent.selectOptions(select, '5');
    await userEvent.selectOptions(select, 'never');
    const patches = calls.filter(([c]) => c === 'settings_set').map(([, a]) => a.patch);
    expect(patches).toEqual([{ autoLockMinutes: 5 }, { autoLockMinutes: null }]);
  });

  it('without an encrypted vault, only says to open one', async () => {
    await openSecurity(false);
    expect(
      screen.getByText('Open an encrypted vault to change its passphrase or recovery key.'),
    ).toBeVisible();
    expect(screen.queryByLabelText('Current passphrase')).toBeNull();
  });

  const fill = async () => {
    await userEvent.type(screen.getByLabelText('Current passphrase'), OLD);
    await userEvent.type(screen.getByLabelText('New passphrase'), NEW);
    await userEvent.type(screen.getByLabelText('Confirm passphrase'), NEW);
    await userEvent.click(screen.getByRole('button', { name: 'Change passphrase' }));
  };

  it('changes the passphrase, toasts, and clears the fields', async () => {
    await openSecurity(true);
    await fill();
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Passphrase changed'),
    );
    expect(calls.find(([c]) => c === 'security_change_passphrase')?.[1]).toEqual({
      current: OLD,
      next: NEW,
    });
    expect(screen.getByLabelText('Current passphrase')).toHaveValue('');
    expect(screen.getByLabelText('New passphrase')).toHaveValue('');
    expect(JSON.stringify(useToastStore.getState().toasts)).not.toContain(NEW);
  });

  it('a wrong current passphrase is an inline error tied to its field', async () => {
    fail.change = 'wrongSecret';
    await openSecurity(true);
    await fill();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That passphrase doesn't open this vault.");
    expect(screen.getByLabelText('Current passphrase')).toHaveAccessibleDescription(
      "That passphrase doesn't open this vault.",
    );
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(screen.getByLabelText('New passphrase')).toHaveValue('');
    expect(screen.getByLabelText('Confirm passphrase')).toHaveValue('');
    expect(screen.getByLabelText('Current passphrase')).toHaveFocus();
  });

  it('new recovery key asks for the passphrase, then shows the code to confirm', async () => {
    await openSecurity(true);
    expect(screen.getByText('Your old recovery key stops working.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New recovery key…' }));
    // The app hosts it, so closing Settings can't take the code with it.
    expect(useUiStore.getState().dialog).toEqual({ type: 'newRecovery' });
    const dialog = screen.getByRole('dialog', { name: 'New recovery key' });
    await userEvent.type(within(dialog).getByLabelText('Current passphrase'), OLD);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('recovery-code')).toHaveTextContent(CODE);
    expect(useUiStore.getState().held).toBe(true);
    expect(calls.find(([c]) => c === 'security_new_recovery')?.[1]).toEqual({ passphrase: OLD });
    await userEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    expect(screen.getAllByLabelText(/^Group \d+$/)).toHaveLength(2);
  });

  it('a recovery key changed on another device says to try again', async () => {
    fail.recovery = 'conflict';
    await openSecurity(true);
    await userEvent.click(screen.getByRole('button', { name: 'New recovery key…' }));
    const dialog = screen.getByRole('dialog', { name: 'New recovery key' });
    await userEvent.type(within(dialog).getByLabelText('Current passphrase'), OLD);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Another device changed this vault's keys. Lock the vault and unlock it again, then try.",
    );
  });
});

describe('the voided recovery key prompt', () => {
  it('opens after the vault opens, cannot be dismissed, and leads to the new-code flow', async () => {
    useVaultStore.setState({ info: { ...info, recoveryVoid: true } as never, status: 'open' });
    useUiStore.getState().openDialog({ type: 'recoveryVoid' });
    render(<CreateEncryptedHost />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      'Your recovery key for this vault was replaced on another device and no longer works. Make a new one now.',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Make a new recovery key' }));
    await userEvent.type(screen.getByLabelText('Current passphrase'), OLD);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('recovery-code')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: "I've saved it" }));
    const typed = screen.getAllByLabelText(/^Group \d+$/);
    expect(typed).toHaveLength(2);
  });

  it('is opened by the vault store when the opened vault has a voided key', async () => {
    mockIPC((cmd) => {
      if (cmd === 'vault_open') return { ...info, recoveryVoid: true };
      if (cmd === 'vault_tree') return [];
      return null;
    });
    await useVaultStore.getState().open('/enc');
    expect(useUiStore.getState().dialog).toEqual({ type: 'recoveryVoid' });
  });
});

describe('a refused dialog', () => {
  it('confirmUnsaved and a bin clash resolve as cancel while the voided prompt shows', async () => {
    const { confirmUnsaved } = await import('../editor/unsavedPrompt');
    const { useEditorStore } = await import('../../stores/editorStore');
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoSave: false } });
    vi.spyOn(useEditorStore.getState(), 'askPaths').mockReturnValue(['a.md']);
    useVaultStore.setState({ status: 'open' });
    useUiStore.getState().openDialog({ type: 'recoveryVoid' });
    // Settings from the native menu leaves the prompt in place.
    const { openSettings } = await import('../shell/shellMenu');
    openSettings();
    expect(useUiStore.getState().dialog).toEqual({ type: 'recoveryVoid' });
    const answered = await Promise.race([
      confirmUnsaved(),
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ]);
    expect(answered).toBe(false);
    expect(useUiStore.getState().dialog).toEqual({ type: 'recoveryVoid' });
  });
});
