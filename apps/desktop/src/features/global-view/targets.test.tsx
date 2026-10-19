import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GvCard } from '../../ipc';
import { Card } from './Card';

const CARD: GvCard = {
  path: 'A.md',
  kind: 'page',
  title: 'A',
  subtitle: 'Sub',
  cover: null,
  coverRemote: false,
  coverY: null,
  coverX: null,
  coverSide: 'top',
  excerpt: 'Some text.',
  hasImage: false,
  hasAudio: false,
  indexPage: null,
  pages: 0,
  folders: 0,
  childTitles: [],
  relation: null,
};

const show = () =>
  render(
    <Card
      card={CARD}
      open={false}
      focusable
      connections=""
      onOpen={() => undefined}
      onOpenEditor={() => undefined}
      onFocus={() => undefined}
    />,
  );

describe('Global View card targets (M3a §4)', () => {
  it('the move handle is 36 × 36', () => {
    show();
    const grip = getComputedStyle(document.querySelector('.gv-grip')!);
    expect([grip.width, grip.height]).toEqual(['36px', '36px']);
  });

  it('the card button covers the body but holds no text: its name is the title (m5)', () => {
    // axe's label-content-name-mismatch (real engines only): a button named
    // "A" must not show "No cover A Sub Some text." inside itself.
    show();
    const press = screen.getByRole('button', { name: 'A' });
    expect(press).toHaveTextContent(/^$/);
    expect(press).toHaveAccessibleDescription('Sub Some text.');
    expect(getComputedStyle(press).position).toBe('absolute');
    expect(press.parentElement).toHaveTextContent('No coverASubSome text.');
  });
});
