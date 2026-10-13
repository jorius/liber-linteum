import { act, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from '../../ipc';
import { usePageStore } from '../../stores/pageStore';
import { PageView } from './PageView';

const page: Page = {
  path: 'Character Design/rex-draft.md',
  title: 'Generator Rex',
  subtitle: 'Hero redesign · v3',
  cover: 'assets/rex-cover.png',
  tags: ['character', 'redesign'],
  links: 8,
  backlinks: 1,
  text: '---\nsubtitle: Hero redesign · v3\n---\n# Generator Rex\n\nBody [[Sparda]]\n',
  truncated: false,
  binary: false,
};

const show = (state: Partial<ReturnType<typeof usePageStore.getState>>) =>
  act(() => usePageStore.setState({ path: null, page: null, state: 'empty', ...state }));

afterEach(() => usePageStore.getState().clear());

describe('PageView (EXP-05)', () => {
  it('shows the empty state when nothing is selected', () => {
    render(<PageView />);
    expect(screen.getByText('Pick a page in the explorer')).toBeInTheDocument();
  });

  it('shows title, subtitle, tags, path, link counts and the raw Markdown', () => {
    render(<PageView />);
    show({ path: page.path, page, state: 'ready' });
    expect(screen.getByRole('heading', { level: 1, name: 'Generator Rex' })).toBeInTheDocument();
    expect(screen.getByText('Hero redesign · v3')).toBeInTheDocument();
    const tags = screen.getByRole('list', { name: 'Tags' });
    expect(tags).toHaveTextContent('#character');
    expect(tags).toHaveTextContent('#redesign');
    expect(screen.getByText('Character Design/rex-draft.md')).toBeInTheDocument();
    expect(screen.getByText('8 links · 1 backlink')).toBeInTheDocument();
    expect(screen.getByText(/Body \[\[Sparda\]\]/).tagName).toBe('PRE');
  });

  it('shows loading, deleted, truncated and binary states', () => {
    render(<PageView />);
    show({ path: 'a.md', state: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    show({ path: 'a.md', state: 'deleted' });
    expect(screen.getByText('This page was deleted outside the app.')).toBeInTheDocument();
    show({ path: page.path, page: { ...page, truncated: true }, state: 'ready' });
    expect(screen.getByText('Showing the first 1 MB of this page.')).toBeInTheDocument();
    show({
      path: 'latin1.md',
      page: { ...page, title: 'latin1', binary: true, text: '' },
      state: 'ready',
    });
    expect(
      screen.getByText("This file isn't valid UTF-8 text, so it can't be shown."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Body/)).not.toBeInTheDocument();
  });

  it('NFR-10 has no axe violations', async () => {
    const { container } = render(<PageView />);
    show({ path: page.path, page, state: 'ready' });
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
