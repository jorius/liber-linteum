import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../../stores/uiStore';
import { DialogHost } from '../dialogs/DialogHost';

afterEach(() => {
  useUiStore.setState({ dialog: null });
  document.body.innerHTML = '';
});

function open(returnTo: HTMLElement | null = null) {
  useUiStore.setState({
    dialog: {
      type: 'diagramPreview',
      html: '<svg viewBox="0 0 200 100"><text>Start</text></svg>',
      kind: 'diagram',
      returnTo,
    },
  });
  render(<DialogHost />);
}

const percent = () => screen.getByText(/^\d+%$/).textContent;

describe('Part B: the diagram preview', () => {
  it('shows the cloned markup', () => {
    open();
    expect(screen.getByRole('dialog', { name: 'Diagram preview' })).toBeInTheDocument();
    const layer = screen.getByRole('img', { name: 'Diagram' });
    expect(layer.querySelector('svg')).not.toBeNull();
    expect(layer).toHaveTextContent('Start');
  });

  it('+ and − change the percentage', async () => {
    open();
    expect(percent()).toBe('100%');
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(percent()).toBe('125%');
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(percent()).toBe('100%');
    await userEvent.keyboard('+');
    expect(percent()).toBe('125%');
    await userEvent.keyboard('-');
    expect(percent()).toBe('100%');
  });

  it('0 fits', async () => {
    open();
    await userEvent.keyboard('++');
    expect(percent()).not.toBe('100%');
    await userEvent.keyboard('0');
    expect(percent()).toBe('100%');
  });

  it("a WebKit pinch (gesture events) zooms and doesn't zoom the page", () => {
    open();
    const box = screen.getByRole('img', { name: 'Diagram' }).parentElement!;
    const gesture = (type: string, scale: number) => {
      const e = Object.assign(new Event(type, { cancelable: true }), {
        scale,
        clientX: 0,
        clientY: 0,
      });
      act(() => void box.dispatchEvent(e));
      return e;
    };
    expect(gesture('gesturestart', 1).defaultPrevented).toBe(true);
    gesture('gesturechange', 2);
    expect(percent()).toBe('200%');
    gesture('gesturechange', 1.5);
    expect(percent()).toBe('150%');
    // A new pinch starts from the current zoom.
    gesture('gesturestart', 1);
    gesture('gesturechange', 2);
    expect(percent()).toBe('300%');
  });

  it('Escape closes and gives the keyboard back to returnTo', async () => {
    const back = document.body.appendChild(document.createElement('button'));
    back.textContent = 'diagram';
    back.focus();
    open(back);
    expect(document.activeElement).not.toBe(back);
    await userEvent.keyboard('{Escape}');
    expect(useUiStore.getState().dialog).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(back);
  });
});
