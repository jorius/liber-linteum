// M4b part 3 (wide elements §3): tables keep their words whole and scroll
// sideways in their own box; that box is a named, focusable region only
// while it actually overflows (axe scrollable-region-focusable).
import { render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { Preview } from './Preview';

const TABLE = '| Category | Rank |\n| --- | --- |\n| Pre-Commissioned | Cadet |\n';

/** Pretends every table box is `scroll` px wide inside `client` px. */
function sizes(scroll: number, client: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client);
}

const show = () => {
  mockIPC(() => null);
  return render(<Preview text={TABLE} path="A.md" delay={0} />);
};

afterEach(() => {
  vi.restoreAllMocks();
  clearMocks();
});

describe('tables (M4b part 3 wide elements §3)', () => {
  it('render inside their own box, which is plain while the table fits', async () => {
    sizes(400, 400);
    show();
    const table = await screen.findByRole('table');
    const box = table.parentElement!;
    expect(box).toHaveAttribute('data-table-scroll');
    expect(box).not.toHaveAttribute('role');
    expect(box).not.toHaveAttribute('tabindex');
    expect(box).not.toHaveAttribute('aria-label');
  });

  it('a table wider than its box makes the box a focusable region that says it scrolls', async () => {
    sizes(900, 400);
    show();
    const region = await screen.findByRole('region', { name: 'Table, scrolls sideways' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
    const res = await axe.run(region, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations).toEqual([]);
  });

  it('follows the box: a window grown wide enough turns the region back into a box', async () => {
    sizes(900, 400);
    show();
    await screen.findByRole('region', { name: 'Table, scrolls sideways' });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());
  });
});
