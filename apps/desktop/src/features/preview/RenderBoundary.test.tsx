import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderBoundary } from './RenderBoundary';

function Boom(): never {
  throw new Error('render bug');
}

afterEach(() => vi.restoreAllMocks());

describe('RenderBoundary (I4: a render bug never blanks the app)', () => {
  it('shows a localized fallback instead of a throwing child', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <p>outside</p>
        <RenderBoundary resetKey="a">
          <Boom />
        </RenderBoundary>
      </div>,
    );
    expect(screen.getByText('outside')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'This page couldn’t be shown. The text is safe in the editor.',
    );
  });

  it('tries again when its input changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <RenderBoundary resetKey="a">
        <Boom />
      </RenderBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(
      <RenderBoundary resetKey="b">
        <p>fine</p>
      </RenderBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
