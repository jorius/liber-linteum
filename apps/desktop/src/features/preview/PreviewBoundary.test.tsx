import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { Preview } from './Preview';

vi.mock('../../markdown/sanitize', async (load) => ({
  ...(await load<typeof import('../../markdown/sanitize')>()),
  toSafeHast: () => {
    throw new Error('render bug');
  },
}));

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe('Preview (I4)', () => {
  it('a render bug in the pane shows the fallback, not a blank app', () => {
    mockIPC(() => null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <main>
        <h1>Header stays</h1>
        <Preview text="# Hi" path="Notes/Page.md" />
      </main>,
    );
    expect(screen.getByText('Header stays')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
