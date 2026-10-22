import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { TitleBar } from './TitleBar';

let calls: { cmd: string; args: unknown }[] = [];

beforeEach(() => {
  calls = [];
  mockWindows('main');
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'window_maximized') return false;
      if (cmd === 'window_toggle_maximize') return true;
      return null;
    },
    { shouldMockEvents: true },
  );
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbar: true } });
  act(() =>
    useVaultStore.setState({
      status: 'open',
      info: { name: 'Kessari', root: '/v/Kessari', report: {} as never, encrypted: false },
    }),
  );
  document.title = 'The Salt Courts — Kessari';
});

afterEach(() => {
  // Unmount first: the bar stops listening while the event mocks are there.
  cleanup();
  clearMocks();
  resetVaultStore();
});

const commands = () => calls.map((c) => c.cmd).filter((c) => !c.startsWith('plugin:'));
const activated = () =>
  calls.filter((c) => c.cmd === 'menu_activate').map((c) => (c.args as { id: string }).id);

describe('the drawn title bar (custom title bar §2, §3)', () => {
  it("shows the menus, the page's title and the window buttons, accessibly", async () => {
    const { container } = render(<TitleBar main />);
    const bar = screen.getByRole('menubar', { name: 'Menus' });
    expect(
      within(bar)
        .getAllByRole('menuitem')
        .map((b) => b.textContent),
    ).toEqual(['Liber Linteum', 'File', 'Vault', 'Edit', 'View', 'Window']);
    expect(screen.getByText('The Salt Courts — Kessari')).toBeInTheDocument();
    for (const name of ['Minimize', 'Maximize', 'Close window'])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it('runs a menu item as the macOS menu would, and closes the menu', async () => {
    const user = userEvent.setup();
    render(<TitleBar main />);
    await user.click(screen.getByRole('menuitem', { name: 'File' }));
    const menu = screen.getByRole('menu', { name: 'File' });
    expect(within(menu).getByRole('menuitem', { name: /Save/ })).toHaveTextContent('Ctrl+S');
    await user.click(within(menu).getByRole('menuitem', { name: /Save/ }));
    expect(activated()).toEqual(['liber-save']);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('checks the View toggles that are on; disabled items do nothing', async () => {
    const user = userEvent.setup();
    render(<TitleBar main />);
    await user.click(screen.getByRole('menuitem', { name: 'View' }));
    expect(screen.getByRole('menuitemcheckbox', { name: /Formatting toolbar/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: /Outline/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await user.click(screen.getByRole('menuitem', { name: 'Vault' }));
    const lock = screen.getByRole('menuitem', { name: /Lock vault/ });
    expect(lock).toHaveAttribute('aria-disabled', 'true');
    // Nothing is highlighted until the pointer or the keyboard picks an item.
    expect(screen.getByRole('menu').querySelector('[data-active]')).toBeNull();
    await user.click(lock);
    expect(activated()).toEqual([]);
  });

  it('F10 takes the keyboard to the menus; arrows move, Escape gives it back', async () => {
    const user = userEvent.setup();
    render(
      <>
        <TitleBar main />
        <input aria-label="note" />
      </>,
    );
    const note = screen.getByRole('textbox', { name: 'note' });
    note.focus();
    await user.keyboard('{F10}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'About Liber Linteum' })).toHaveFocus(),
    );
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByRole('menu', { name: 'File' })).toBeInTheDocument());
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(note).toHaveFocus();
  });

  it('answers the keys only the macOS menu had: Ctrl+Q, Alt+Ctrl+W, F11', () => {
    render(<TitleBar main />);
    fireEvent.keyDown(window, { key: 'q', code: 'KeyQ', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: 'F11' });
    expect(activated()).toEqual(['liber-quit', 'liber-vault-close']);
    expect(commands()).toContain('window_toggle_fullscreen');
  });

  it('the bar moves the window, a double click maximizes it, and the buttons work', async () => {
    const user = userEvent.setup();
    render(<TitleBar main />);
    const title = screen.getByText('The Salt Courts — Kessari');
    fireEvent.mouseDown(title, { button: 0, detail: 1 });
    fireEvent.mouseDown(title, { button: 0, detail: 2 });
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    await user.click(screen.getByRole('button', { name: 'Close window' }));
    expect(commands()).toEqual(
      expect.arrayContaining([
        'window_start_drag',
        'window_toggle_maximize',
        'window_minimize',
        'window_close_request',
      ]),
    );
    // A press on a menu name opens it, it doesn't drag.
    calls = [];
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Edit' }), { button: 0 });
    expect(commands()).not.toContain('window_start_drag');
  });

  it('a file window has no Vault menu and no close-vault key', () => {
    render(<TitleBar main={false} />);
    expect(screen.queryByRole('menuitem', { name: 'Vault' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true, altKey: true });
    expect(activated()).toEqual([]);
  });

  it('About shows the app and closes', async () => {
    const user = userEvent.setup();
    render(<TitleBar main />);
    await user.click(screen.getByRole('menuitem', { name: 'Liber Linteum' }));
    await user.click(screen.getByRole('menuitem', { name: 'About Liber Linteum' }));
    const dialog = await screen.findByRole('dialog', { name: 'About Liber Linteum' });
    expect(dialog).toHaveTextContent('GNU GPL');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
