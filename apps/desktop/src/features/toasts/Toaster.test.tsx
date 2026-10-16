import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../stores/toastStore';
import { Toaster } from './Toaster';

const push = (t: Parameters<ReturnType<typeof useToastStore.getState>['push']>[0]) =>
  act(() => void useToastStore.getState().push(t));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const messages = () => useToastStore.getState().toasts.map((t) => t.message);

// M5b round 2: "Moved to Trash · Undo" toasts never went away, and stacked up.
describe('Toaster timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clear();
  });
  afterEach(() => {
    useToastStore.getState().clear();
    vi.useRealTimers();
  });

  it('a toast with an action goes after 8 s, a plain one after 5 s', () => {
    render(<Toaster />);
    push({ message: 'Moved to Trash', action: { label: 'Undo', run: () => undefined } });
    push({ message: 'Saved a copy' });
    wait(4999);
    expect(messages()).toEqual(['Moved to Trash', 'Saved a copy']);
    wait(1);
    expect(messages()).toEqual(['Moved to Trash']);
    wait(2999);
    expect(messages()).toEqual(['Moved to Trash']);
    wait(1);
    expect(messages()).toEqual([]);
  });

  it('a toast listing details stays until dismissed', () => {
    render(<Toaster />);
    push({ message: 'Some links were not updated', detail: ['a.md'] });
    wait(60_000);
    expect(messages()).toEqual(['Some links were not updated']);
  });

  it('waits while the pointer is over it or focus is in it', () => {
    render(<Toaster />);
    push({ message: 'Moved to Trash', action: { label: 'Undo', run: () => undefined } });
    const toast = screen.getByText('Moved to Trash').closest('[role="status"]')!;
    wait(6000);
    fireEvent.mouseEnter(toast);
    wait(20_000);
    expect(messages()).toEqual(['Moved to Trash']);
    fireEvent.mouseLeave(toast);
    wait(1999);
    expect(messages()).toEqual(['Moved to Trash']);
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }));
    wait(20_000);
    expect(messages()).toEqual(['Moved to Trash']);
    fireEvent.blur(screen.getByRole('button', { name: 'Undo' }));
    wait(1);
    expect(messages()).toEqual([]);
  });

  it('shows at most three; the oldest goes first', () => {
    render(<Toaster />);
    for (const n of [1, 2, 3, 4]) {
      push({ message: `Moved ${n}`, action: { label: 'Undo', run: () => undefined } });
    }
    expect(messages()).toEqual(['Moved 2', 'Moved 3', 'Moved 4']);
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(3);
  });
});
