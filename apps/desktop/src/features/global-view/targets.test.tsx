import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GvCard } from '../../ipc';
import { Card } from './Card';

const CARD: GvCard = {
  path: 'A.md',
  kind: 'page',
  title: 'A',
  subtitle: null,
  cover: null,
  coverRemote: false,
  coverY: null,
  excerpt: '',
  hasImage: false,
  hasAudio: false,
  indexPage: null,
  pages: 0,
  folders: 0,
  childTitles: [],
  relation: null,
};

describe('Global View card targets (M3a §4)', () => {
  it('the move handle is 36 × 36', () => {
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
    const grip = getComputedStyle(document.querySelector('.gv-grip')!);
    expect([grip.width, grip.height]).toEqual(['36px', '36px']);
  });
});
