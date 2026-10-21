// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { UnreadableList } from './UnreadableList';

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

const backend = (list: unknown[]) => {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
    return cmd === 'vault_unreadable' ? list : null;
  });
  return calls;
};

describe('UnreadableList', () => {
  it('renders nothing when the list is empty', async () => {
    backend([]);
    const { container } = render(<UnreadableList />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each file's reason and reveals the one clicked", async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh');
    const calls = backend([
      { osPath: '/enc/aaa', reason: 'name could not be decrypted' },
      { osPath: '/enc/bbb', reason: 'name is corrupt' },
    ]);
    render(<UnreadableList />);
    expect(await screen.findByText("Couldn't read")).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/never deleted/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Show in Finder' })[1]);
    expect(calls.find(([c]) => c === 'vault_reveal_unreadable')?.[1]).toEqual({
      osPath: '/enc/bbb',
    });
  });
});
