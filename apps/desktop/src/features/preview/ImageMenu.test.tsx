import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetUrl, externalAssetUrl } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useUiStore } from '../../stores/uiStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { ImageMenuHost, imageOf } from './ImageMenu';

let calls: [string, unknown][] = [];
beforeEach(() => {
  calls = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    return null;
  });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  useUiStore.setState({ dialog: null });
  await resetVaultStore();
  clearMocks();
});

const inPreview = (src: string) => (
  <>
    <ImageMenuHost />
    <div data-preview="">
      <img src={src} alt="moon" />
    </div>
  </>
);

describe('0.1.2: the right-click menu on an image', () => {
  it('reads the image back from its asset URL', () => {
    expect(imageOf(assetUrl('attachments/Big moon.png'))).toEqual({
      path: 'attachments/Big moon.png',
      external: false,
    });
    expect(imageOf('http://liber-asset.localhost/a/b%20c.png')).toEqual({
      path: 'a/b c.png',
      external: false,
    });
    expect(imageOf(externalAssetUrl('/home/me/Pictures/x.png'))).toEqual({
      path: '/home/me/Pictures/x.png',
      external: true,
    });
    expect(imageOf('data:image/png;base64,AAAA')).toBeNull();
    expect(imageOf('https://example.com/x.png')).toBeNull();
  });

  it('offers to open it in the default app or show it in its folder, by keyboard too', async () => {
    render(inPreview(assetUrl('attachments/moon.png')));
    fireEvent.contextMenu(screen.getByRole('img', { name: 'moon' }));
    const menu = screen.getByRole('menu', { name: 'Image menu' });
    const [open, reveal] = screen.getAllByRole('menuitem');
    expect(open).toHaveTextContent('Open in default app');
    expect(reveal).toHaveTextContent('Show in file manager');
    expect(open).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(reveal).toHaveFocus();
    await userEvent.click(reveal);
    expect(calls).toContainEqual(['entry_reveal', { path: 'attachments/moon.png' }]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole('img', { name: 'moon' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in default app' }));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'openFile',
      path: 'attachments/moon.png',
      external: false,
    });
  });

  it('Escape closes it', () => {
    render(inPreview(assetUrl('moon.png')));
    fireEvent.contextMenu(screen.getByRole('img', { name: 'moon' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('a file outside the vault opens and reveals as an outside file', async () => {
    render(inPreview(externalAssetUrl('/home/me/x.png')));
    fireEvent.contextMenu(screen.getByRole('img', { name: 'moon' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Show in file manager' }));
    expect(calls).toContainEqual(['external_reveal', { path: '/home/me/x.png' }]);
    fireEvent.contextMenu(screen.getByRole('img', { name: 'moon' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in default app' }));
    expect(useUiStore.getState().dialog).toEqual({
      type: 'openFile',
      path: '/home/me/x.png',
      external: true,
    });
  });

  it('an encrypted vault offers only Open (revealing would show ciphertext names)', () => {
    useVaultStore.setState({
      info: { name: 'Vault', root: '/v', report: {} as never, encrypted: true } as never,
    });
    render(inPreview(assetUrl('moon.png')));
    fireEvent.contextMenu(screen.getByRole('img', { name: 'moon' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Open in default app',
    ]);
  });

  it('images elsewhere (a Global View card cover) keep their own menu', () => {
    render(
      <>
        <ImageMenuHost />
        <img src={assetUrl('moon.png')} alt="cover" />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole('img', { name: 'cover' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
