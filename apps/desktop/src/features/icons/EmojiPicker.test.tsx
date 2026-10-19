import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker';

const anchor = () => ({ top: 10, bottom: 30, left: 10 });

function mount(hasIcon = false) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <EmojiPicker
      anchor={anchor}
      label="Icon for Lore"
      hasIcon={hasIcon}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { onPick, onClose };
}

const cells = () => screen.queryAllByRole('gridcell');

describe('the emoji picker (M5b §4)', () => {
  beforeEach(() => localStorage.clear());

  it('opens on the first group with the search field focused', async () => {
    mount();
    const search = screen.getByRole('searchbox', { name: 'Search emoji' });
    expect(search).toHaveFocus();
    await waitFor(() => expect(cells().length).toBeGreaterThan(50));
    expect(cells()[0]).toHaveAccessibleName('grinning face');
  });

  it('searches in Spanish without accents and picks with the keyboard', async () => {
    const { onPick } = mount();
    await waitFor(() => expect(cells().length).toBeGreaterThan(0));
    await userEvent.type(screen.getByRole('searchbox'), 'cohete');
    await waitFor(() => expect(cells()[0]).toHaveAccessibleName('rocket'));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith('🚀');
    expect(JSON.parse(localStorage.getItem('nimw.recentIcons')!)).toEqual(['🚀']);
  });

  it('moves through the grid with arrows; Escape closes', async () => {
    const { onPick, onClose } = mount();
    await waitFor(() => expect(cells().length).toBeGreaterThan(20));
    act(() => cells()[0].focus());
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    expect(cells()[9]).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(onPick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('switches groups and offers Remove only when there is an icon', async () => {
    const { onPick } = mount(true);
    await waitFor(() => expect(cells().length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole('button', { name: 'Flags' }));
    await waitFor(() => expect(cells()[0]).toHaveAccessibleName('chequered flag'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove icon' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('shows recent picks first and has no axe violations', async () => {
    localStorage.setItem('nimw.recentIcons', JSON.stringify(['🐉']));
    mount();
    await waitFor(() => expect(cells()[0]).toHaveTextContent('🐉'));
    expect(screen.getByRole('button', { name: 'Recent' })).toHaveAttribute('aria-pressed', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Icon for Lore' });
    const violations = await axe
      .run(dialog, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });

  it('a click outside closes it', async () => {
    const { onClose } = mount();
    await userEvent.click(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
