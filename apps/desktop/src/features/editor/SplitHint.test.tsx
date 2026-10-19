import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';
import { HINT_KEY } from './SplitHint';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
async function editor(mode: 'split' | 'source') {
  fakeDisk({ 'H.md': 'text\n' });
  const res = await PageDoc.load('H.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  return render(<Editor doc={res.value} mode={mode} label="H" />);
}
const HINT = 'Drag blocks in the preview to reorder them; the Markdown on the left follows.';

beforeEach(() => localStorage.clear());
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe('the Split hint (M4 §4)', () => {
  it('shows once in Split, until dismissed', async () => {
    const view = await editor('split');
    expect(screen.getByText(HINT)).toBeInTheDocument();
    await act(() => screen.getByRole('button', { name: 'Dismiss the hint' }).click());
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(localStorage.getItem(HINT_KEY)).toBe('1');
    view.unmount();
    await editor('split');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('is not shown in Source', async () => {
    await editor('source');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('works without storage (a blocked localStorage)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await editor('split');
    expect(screen.getByText(HINT)).toBeInTheDocument();
    await act(() => screen.getByRole('button', { name: 'Dismiss the hint' }).click());
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
