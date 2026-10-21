// @vitest-environment jsdom
// Encryption UX round §2: one "New vault" dialog, plain or encrypted.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { CreateEncryptedHost, openNewVault } from './CreateEncryptedHost';
import { openEncryptInPlace } from './encryptInPlace';

vi.mock('./encryptInPlace', async (orig) => ({
  ...(await orig<typeof import('./encryptInPlace')>()),
  openEncryptInPlace: vi.fn(),
}));

const prompt = vi.hoisted(() => ({ needs: false, answer: true, order: [] as string[] }));
vi.mock('../editor/unsavedPrompt', () => ({
  needsUnsavedPrompt: () => prompt.needs,
  confirmUnsaved: async () => {
    prompt.order.push('prompt');
    return prompt.answer;
  },
}));

const CODE = `LIBER-${Array.from({ length: 14 }, () => 'ABCD').join('-')}`;
const PASS = 'correct horse battery';
const info = (encrypted = false) => ({
  name: 'Notes',
  root: '/v/Notes',
  report: { pages: 0, warnings: [] },
  encrypted,
});

/** `picks`: what each folder picker answers, in turn; `kinds`: folder_kind by path. */
function backend(picks: (string | null)[], kinds: Record<string, string> = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push([cmd, a]);
      if (cmd === 'plugin:dialog|open') {
        prompt.order.push('picker');
        return picks.length ? picks.shift() : null;
      }
      if (cmd === 'folder_kind') return kinds[a.path as string] ?? 'empty';
      if (cmd === 'vault_create' || cmd === 'vault_open') {
        if (kinds[a.path as string] === 'encrypted') throw { kind: 'locked', message: 'locked' };
        return info();
      }
      if (cmd === 'vault_create_encrypted') return { info: info(true), recovery: CODE };
      if (cmd === 'vault_tree') return [];
      return undefined;
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const sent = (calls: [string, Record<string, unknown>][], cmd: string) =>
  calls.filter(([c]) => c === cmd).map(([, a]) => a);

async function start() {
  render(<CreateEncryptedHost />);
  await act(() => openNewVault());
  return screen.getByRole('dialog', { name: 'New vault' });
}

beforeEach(() => {
  Object.assign(prompt, { needs: false, answer: true, order: [] });
});

afterEach(async () => {
  useUiStore.getState().closeDialog();
  await resetVaultStore();
  clearMocks();
  vi.mocked(openEncryptInPlace).mockClear();
});

describe('New vault dialog', () => {
  it('opens the folder picker straight away and shows the chosen folder; Plain is the default', async () => {
    backend(['/v/Notes']);
    const dialog = await start();
    expect(await within(dialog).findByText('/v/Notes')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Plain' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Encrypted Beta' })).not.toBeChecked();
    // The cards' hints describe their radios; the names stay short.
    expect(within(dialog).getByRole('radio', { name: 'Plain' })).toHaveAccessibleDescription(
      'Ordinary Markdown files any app can open.',
    );
    expect(
      within(dialog).getByRole('radio', { name: 'Encrypted Beta' }),
    ).toHaveAccessibleDescription('Names and contents encrypted. Needs a passphrase to open.');
    // The Encrypted card carries the one Beta chip.
    const beta = within(dialog).getByText('Beta');
    expect(beta).toHaveClass('liber-chip');
    expect(
      within(dialog).getByRole('radio', { name: 'Encrypted Beta' }).closest('label'),
    ).toContainElement(beta);
  });

  it('a cancelled picker leaves the dialog open with no folder; Choose… picks again', async () => {
    const calls = backend([null, '/v/Later']);
    const dialog = await start();
    await waitFor(() => expect(sent(calls, 'plugin:dialog|open')).toHaveLength(1));
    expect(within(dialog).getByText('No folder chosen')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose…' }));
    expect(await within(dialog).findByText('/v/Later')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled(),
    );
  });

  it.each([
    // An empty folder opens: vault_create refuses what a failed encrypted
    // create leaves (README.txt, empty d/), which folder_kind calls empty.
    ['empty', 'vault_open'],
    ['missing', 'vault_create'],
    ['plain', 'vault_open'],
  ])('Plain on a folder that is %s runs %s and closes', async (kind, cmd) => {
    const calls = backend(['/v/Notes'], { '/v/Notes': kind });
    const dialog = await start();
    const go = within(dialog).getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(sent(calls, cmd)).toEqual([{ path: '/v/Notes' }]);
    expect(sent(calls, 'vault_create_encrypted')).toEqual([]);
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('Encrypted on an empty folder: passphrase, then the recovery key, held until confirmed', async () => {
    const calls = backend(['/v/Notes'], { '/v/Notes': 'empty' });
    const dialog = await start();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Encrypted Beta' }));
    const go = within(dialog).getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    const steps = screen.getByRole('dialog', { name: 'New vault' });
    expect(within(steps).getByLabelText('Passphrase')).toHaveFocus();
    expect(within(steps).getByText('1 Passphrase')).toHaveAttribute('aria-current', 'step');
    await userEvent.type(within(steps).getByLabelText('Passphrase'), PASS);
    await userEvent.type(within(steps).getByLabelText('Confirm passphrase'), PASS);
    await userEvent.click(within(steps).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('recovery-code')).toHaveTextContent(CODE);
    expect(screen.getByText('2 Recovery key')).toHaveAttribute('aria-current', 'step');
    expect(sent(calls, 'vault_create_encrypted')[0]).toMatchObject({ path: '/v/Notes' });
    // Sticky: nothing replaces it, Escape doesn't close it.
    expect(useUiStore.getState().openDialog({ type: 'settings' })).toBe(false);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('recovery-code')).toBeInTheDocument();
    expect(JSON.stringify(useUiStore.getState())).not.toContain(PASS);
  });

  it('Encrypted on a folder with notes offers to encrypt it in place', async () => {
    const calls = backend(['/v/Notes'], { '/v/Notes': 'plain' });
    const dialog = await start();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Encrypted Beta' }));
    const go = within(dialog).getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(
      within(dialog).getByText('This folder already has notes. Encrypt it in place?'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Encrypt in place…' })).toHaveFocus();
    // Back keeps the folder and the choice.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByText('/v/Notes')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Encrypted Beta' })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Encrypt in place…' }));
    expect(openEncryptInPlace).toHaveBeenCalledWith('/v/Notes');
    expect(useUiStore.getState().dialog).toBeNull();
    expect(sent(calls, 'vault_create_encrypted')).toEqual([]);
    expect(sent(calls, 'vault_create')).toEqual([]);
  });

  it('a folder never encrypted in place (§8.10): no offer, it says why; Plain still opens it', async () => {
    const calls = backend(['/Users/jose/Documents'], { '/Users/jose/Documents': 'refused' });
    const dialog = await start();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Encrypted Beta' }));
    const go = within(dialog).getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Encrypt a vault folder, not Documents.',
    );
    expect(within(dialog).queryByRole('button', { name: 'Encrypt in place…' })).toBeNull();
    expect(openEncryptInPlace).not.toHaveBeenCalled();
    expect(sent(calls, 'vault_create_encrypted')).toEqual([]);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Plain' }));
    await userEvent.click(go);
    await waitFor(() => expect(useVaultStore.getState().status).toBe('open'));
    expect(sent(calls, 'vault_open')).toEqual([{ path: '/Users/jose/Documents' }]);
  });

  it.each(['plain', 'encrypted'])(
    'a folder that is already an encrypted vault (%s chosen) offers to open it',
    async (choice) => {
      const calls = backend(['/v/Enc'], { '/v/Enc': 'encrypted' });
      const dialog = await start();
      if (choice === 'encrypted')
        await userEvent.click(within(dialog).getByRole('radio', { name: 'Encrypted Beta' }));
      const go = within(dialog).getByRole('button', { name: 'Continue' });
      await waitFor(() => expect(go).toBeEnabled());
      await userEvent.click(go);
      expect(within(dialog).getByText('This folder is already an encrypted vault.')).toBeVisible();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Open it' }));
      await waitFor(() => expect(useVaultStore.getState().status).toBe('locked'));
      expect(sent(calls, 'vault_open')).toEqual([{ path: '/v/Enc' }]);
      expect(useUiStore.getState().dialog).toBeNull();
    },
  );

  it('a damaged encrypted folder is said inline and cannot continue', async () => {
    backend(['/v/Bad'], { '/v/Bad': 'damaged' });
    const dialog = await start();
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('damaged');
    expect(within(dialog).getByRole('button', { name: 'Choose…' })).toHaveAttribute(
      'aria-describedby',
      alert.id,
    );
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('Cancel closes without creating anything', async () => {
    const calls = backend(['/v/Notes']);
    const dialog = await start();
    await within(dialog).findByText('/v/Notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(useUiStore.getState().dialog).toBeNull();
    expect(calls.map(([c]) => c)).not.toContain('vault_create');
  });

  it('asks about unsaved text before the dialog (and its picker) opens; Cancel stops', async () => {
    backend(['/v/Notes']);
    prompt.needs = true;
    render(<CreateEncryptedHost />);
    prompt.answer = false;
    await act(() => openNewVault());
    expect(prompt.order).toEqual(['prompt']);
    expect(useUiStore.getState().dialog).toBeNull();
    prompt.answer = true;
    await act(() => openNewVault());
    await waitFor(() => expect(prompt.order).toEqual(['prompt', 'prompt', 'picker']));
    expect(useUiStore.getState().dialog).toEqual({ type: 'newVault' });
  });

  it('is axe-clean', async () => {
    backend(['/v/Notes']);
    const dialog = await start();
    await within(dialog).findByText('/v/Notes');
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});
