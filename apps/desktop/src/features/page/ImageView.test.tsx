import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetUrl } from '../../ipc';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore, useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';

const open = (path: string) => act(() => usePageStore.getState().load(path));

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  usePageStore.getState().clear();
  resetEditorStore();
  useUiStore.setState({ dialog: null });
  await resetVaultStore();
  clearMocks();
});

describe('0.1.2: an image opened from the files shows in the image view', () => {
  it('shows the image, its size once loaded, and opens or reveals it', async () => {
    const disk = fakeDisk(
      { 'attachments/moon.png': '', 'A.md': '# A\n' },
      { entry_reveal: () => null },
    );
    render(<PageScreen />);
    await open('A.md');
    await open('attachments/moon.png');
    // Nothing to edit: the page that was open is closed.
    expect(useEditorStore.getState().doc).toBeNull();
    const img = screen.getByRole('img', { name: 'moon.png' });
    expect(img).toHaveAttribute('src', assetUrl('attachments/moon.png'));
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('attachments');
    Object.defineProperty(img, 'naturalWidth', { value: 640 });
    Object.defineProperty(img, 'naturalHeight', { value: 480 });
    fireEvent.load(img);
    expect(screen.getByText('640 × 480 px')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open in default app' }));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'openFile',
      path: 'attachments/moon.png',
      external: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Show in file manager' }));
    expect(disk.calls).toContainEqual(['entry_reveal', { path: 'attachments/moon.png' }]);
  });

  it('an encrypted vault offers no reveal (it would show ciphertext names)', async () => {
    fakeDisk({ 'moon.png': '' });
    useVaultStore.setState({
      info: { name: 'Vault', root: '/v', report: {} as never, encrypted: true } as never,
    });
    render(<PageScreen />);
    await open('moon.png');
    expect(screen.getByRole('button', { name: 'Open in default app' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show in file manager' })).not.toBeInTheDocument();
  });

  it('an image that fails to load says so', async () => {
    fakeDisk({ 'broken.jpg': '' });
    render(<PageScreen />);
    await open('broken.jpg');
    fireEvent.error(screen.getByRole('img', { name: 'broken.jpg' }));
    expect(screen.getByText('This image couldn’t be shown.')).toBeInTheDocument();
  });
});
