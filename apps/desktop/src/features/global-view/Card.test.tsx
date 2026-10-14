import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GvCard } from '../../ipc';
import { Card, SINGLE_CLICK_MS } from './Card';

function card(extra: Partial<GvCard> = {}): GvCard {
  return {
    path: 'Character Design/rex-draft.md',
    kind: 'page',
    title: 'Generator Rex',
    subtitle: 'Hero redesign · v3',
    cover: 'Character Design/assets/rex-cover.png',
    coverRemote: false,
    coverY: 40,
    excerpt: 'Teen agent who builds machines.',
    hasImage: true,
    hasAudio: true,
    indexPage: null,
    pages: 0,
    folders: 0,
    childTitles: [],
    relation: null,
    ...extra,
  };
}

function show(c: GvCard, handlers: Partial<Record<'onOpen' | 'onOpenEditor', () => void>> = {}) {
  const onOpen = handlers.onOpen ?? vi.fn();
  const onOpenEditor = handlers.onOpenEditor ?? vi.fn();
  const view = render(
    <Card
      card={c}
      open={false}
      focusable
      connections="Links to 2 cards, linked from 1."
      onOpen={onOpen}
      onOpenEditor={onOpenEditor}
      onFocus={() => undefined}
    />,
  );
  return { ...view, onOpen, onOpenEditor };
}

afterEach(() => vi.useRealTimers());

describe('Global View card (M3a §4)', () => {
  it('a page: kind, cover at its position, text, media icons and a description', () => {
    show(card());
    expect(screen.getByRole('group', { name: 'Generator Rex, page' })).toBeInTheDocument();
    expect(screen.getByText('Page')).toBeInTheDocument();
    const img = document.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(
      'nimw-asset://localhost/Character%20Design/assets/rex-cover.png',
    );
    expect(img.style.objectPosition).toBe('50% 40%');
    expect(img.getAttribute('alt')).toBe('');
    const open = screen.getByRole('button', { name: 'Generator Rex' });
    expect(open).toHaveAccessibleDescription(
      'Hero redesign · v3 Teen agent who builds machines. Links to 2 cards, linked from 1.',
    );
    expect(screen.getByRole('img', { name: 'Has images' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Has audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See all: Generator Rex' })).toHaveTextContent(
      'See all',
    );
  });

  it('GV-02: a folder without an index note summarises its children', () => {
    show(
      card({
        path: 'Delta',
        kind: 'project',
        title: 'Delta',
        subtitle: 'Delta',
        cover: null,
        coverY: null,
        excerpt: 'Inner · X title · y',
        hasImage: false,
        hasAudio: false,
        pages: 2,
        folders: 1,
      }),
    );
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('2 pages · 1 folder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Has images' })).not.toBeInTheDocument();
  });

  it('GV-03: a folder previewing its index note says so in its kind label', () => {
    show(
      card({
        path: 'Character Design/DMC',
        kind: 'folder',
        indexPage: 'Character Design/DMC/Sparda.md',
      }),
    );
    expect(screen.getByText('Folder · DMC')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Generator Rex, folder' })).toBeInTheDocument();
  });

  it('placeholders: no cover, and a remote cover that is never loaded', () => {
    const { unmount } = show(card({ cover: null }));
    expect(screen.getByText('No cover')).toBeInTheDocument();
    unmount();
    show(card({ cover: null, coverRemote: true }));
    expect(screen.getByText('Remote cover not loaded')).toBeInTheDocument();
  });

  it('GV-11/12/18: a click opens the next level after a pause, a double click the editor; Enter / Shift+Enter', async () => {
    vi.useFakeTimers();
    const { onOpen, onOpenEditor } = show(card());
    const open = screen.getByRole('button', { name: 'Generator Rex' });
    fireEvent.click(open);
    expect(onOpen).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(SINGLE_CLICK_MS));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(open);
    fireEvent.click(open);
    fireEvent.doubleClick(open);
    await act(() => vi.advanceTimersByTimeAsync(SINGLE_CLICK_MS * 2));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpenEditor).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(open, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(open, { key: 'Enter', shiftKey: true });
    expect(onOpenEditor).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'See all: Generator Rex' }));
    expect(onOpenEditor).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('NFR-10: no axe violations (contrast: palettes.test.ts, jsdom has no CSS)', async () => {
    const { container } = show(card());
    await userEvent.setup().tab();
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it('M3b: the connect button opens the card’s menu; Escape gives the keyboard back', async () => {
    const run = vi.fn();
    render(
      <Card
        card={card()}
        open={false}
        focusable
        connections=""
        menu={[{ label: 'Relationships…', run }]}
        onOpen={vi.fn()}
        onOpenEditor={vi.fn()}
        onFocus={() => undefined}
      />,
    );
    const button = screen.getByRole('button', { name: 'Connections of Generator Rex' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'Connections of Generator Rex' });
    expect(screen.getByRole('menuitem', { name: 'Relationships…' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(menu).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Relationships…' }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('M3b: without menu items there is no connect button', () => {
    show(card());
    expect(screen.queryByRole('button', { name: /^Connections of/ })).not.toBeInTheDocument();
  });
});
