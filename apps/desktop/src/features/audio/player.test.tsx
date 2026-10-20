import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePageStore } from '../../stores/pageStore';
import { AudioPlayer, pauseAll } from './AudioPlayer';

// jsdom has no media playback: play and pause just fire their events.
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => {
  pauseAll();
  vi.restoreAllMocks();
});

const loaded = (el: HTMLMediaElement, duration: number) => {
  Object.defineProperty(el, 'duration', { value: duration, configurable: true });
  act(() => void el.dispatchEvent(new Event('loadedmetadata')));
};

describe('AudioPlayer (M6 §4)', () => {
  it('plays and pauses, names the clip, and tells the position', async () => {
    render(<AudioPlayer src="liber-asset://localhost/a.wav" name="a.wav" />);
    const audio = document.querySelector('audio')!;
    expect(audio).toHaveAttribute('preload', 'metadata');
    expect(audio).not.toHaveAttribute('controls');
    loaded(audio, 90);
    const play = screen.getByRole('button', { name: 'Play a.wav' });
    expect(play).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(play);
    expect(screen.getByRole('button', { name: 'Pause a.wav' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const slider = screen.getByRole('slider', { name: 'Position in a.wav' });
    expect(slider).toHaveAttribute('aria-valuetext', '0:00 of 1:30');
    // ←/→ move 5 s; End goes to the end.
    slider.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(audio.currentTime).toBe(10);
    await userEvent.keyboard('{ArrowLeft}');
    expect(audio.currentTime).toBe(5);
    act(() => void audio.dispatchEvent(new Event('timeupdate')));
    expect(slider).toHaveAttribute('aria-valuetext', '0:05 of 1:30');
    expect(screen.getByText('0:05 / 1:30')).toBeInTheDocument();
  });

  it('plays one clip at a time, and stops when the page changes or it goes', async () => {
    const { unmount } = render(
      <>
        <AudioPlayer src="liber-asset://localhost/a.wav" name="a.wav" />
        <AudioPlayer src="liber-asset://localhost/b.wav" name="b.wav" />
      </>,
    );
    const [a, b] = [...document.querySelectorAll('audio')];
    await userEvent.click(screen.getByRole('button', { name: 'Play a.wav' }));
    await userEvent.click(screen.getByRole('button', { name: 'Play b.wav' }));
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(false);
    act(() => usePageStore.setState({ path: 'Other.md' }));
    expect(b.paused).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Play b.wav' }));
    unmount();
    expect(b.paused).toBe(true);
  });

  it('has no axe violations', async () => {
    const { container } = render(<AudioPlayer src="liber-asset://localhost/a.wav" name="a.wav" />);
    loaded(document.querySelector('audio')!, 12);
    const violations = (await axe.run(container)).violations;
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
