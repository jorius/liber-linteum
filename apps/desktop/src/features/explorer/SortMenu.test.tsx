import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { useToastStore } from '../../stores/toastStore';
import { SortMenu } from './SortMenu';

// Round-2 review M14: the vault's sort button and its menu.
describe('SortMenu', () => {
  beforeEach(() => {
    useToastStore.getState().clear();
    mockIPC((cmd) => {
      if (cmd === 'folder_sort_get') return 'name-asc';
      if (cmd === 'folder_sort_set') throw { kind: 'io', message: 'disk full' };
      return null;
    });
  });
  afterEach(() => clearMocks());

  it('says so when the order could not be saved, and gives focus back on Escape', async () => {
    const onClose = vi.fn();
    render(<SortMenu path="" name="v" anchor={{ x: 0, y: 0 }} onClose={onClose} />);
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Name, Z → A' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0].tone).toBe('error');
    expect(onClose).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenLastCalledWith(true);
  });

  it('leaves a press on its own open button to that button (it toggles the menu)', () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button" aria-haspopup="menu" aria-expanded="true">
          Sort
        </button>
        <SortMenu path="" name="v" anchor={{ x: 0, y: 0 }} onClose={onClose} />
      </>,
    );
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Sort' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
