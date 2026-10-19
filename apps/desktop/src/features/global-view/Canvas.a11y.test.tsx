// React Flow's own accessibility strings in the Global View (final review
// m5): they must be translated, and React Flow's English defaults (node
// role description, hidden keyboard help) must not leak into the page.
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import i18next from 'i18next';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GvCard } from '../../ipc';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { installReactFlowStubs } from '../../test/reactFlow';
import { GlobalView } from './GlobalView';
import { useGvStore } from './gvStore';

beforeAll(installReactFlowStubs);

const card = (path: string): GvCard => ({
  path,
  kind: 'project',
  title: path,
  subtitle: null,
  cover: null,
  coverRemote: false,
  coverY: null,
  coverX: null,
  coverSide: 'top',
  excerpt: '',
  hasImage: false,
  hasAudio: false,
  indexPage: null,
  pages: 0,
  folders: 0,
  childTitles: [],
  relation: null,
});

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } });
  useGvStore.getState().reset();
  useUiStore.setState({ screen: 'global' });
  mockIPC((cmd) => {
    if (cmd === 'gv_children') return { cards: [card('Alpha'), card('Beta')], centre: null };
    if (cmd === 'gv_edges') return [];
    if (cmd === 'layout_get') return {};
    return null;
  });
  return clearMocks;
});

/** React Flow's default English strings (@xyflow/system defaultAriaLabelConfig). */
const ENGLISH = /Press enter or space to select|select an edge/;

async function show(lng: string) {
  await i18next.changeLanguage(lng);
  const view = render(<GlobalView />);
  await screen.findByRole('button', { name: 'Alpha' });
  return view;
}

describe('Global View canvas accessibility (final review m5)', () => {
  it.each([
    ['en', 'Global View cards', /^Arrow keys move between cards/],
    ['es', 'Tarjetas de la vista global', /^Las flechas mueven entre tarjetas/],
  ])('%s: the canvas (role application) is named and described', async (lng, name, help) => {
    await show(lng);
    expect(screen.getByRole('application', { name })).toHaveAccessibleDescription(help);
  });

  it("no React Flow English strings or role descriptions on a card's wrapper", async () => {
    const { container } = await show('es');
    expect(container.textContent).not.toMatch(ENGLISH);
    expect(container.querySelector('[aria-roledescription]')).toBeNull();
  });

  it('no axe violations', async () => {
    const { container } = await show('es');
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
