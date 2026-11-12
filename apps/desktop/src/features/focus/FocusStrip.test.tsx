import { act, render, screen } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { clearMocks, mockIPC } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { useTrailStore } from '../../stores/trailStore';
import { useUiStore } from '../../stores/uiStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from '../editor/Editor';
import { PageDoc } from '../editor/pageDoc';
import { FocusStrip } from './FocusStrip';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };

afterEach(async () => {
  // Unmount the editor and let its pending IPC settle before the mocks go.
  cleanup();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  act(() => {
    useUiStore.setState({ focus: false });
    useEditorStore.setState({ doc: null, path: null });
    useTrailStore.setState({ back: [], forward: [] });
  });
  clearMocks();
});

describe('FocusStrip', () => {
  it('renders nothing out of focus', () => {
    usePageStore.setState({ state: 'ready', path: 'A.md' });
    useTrailStore.setState({ back: [{ path: 'B.md' }] as never });
    const { container } = render(<FocusStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows words and save status for a page', async () => {
    fakeDisk({ 'A.md': 'One two three.\n' });
    const res = await PageDoc.load('A.md', hooks);
    if (!res.ok) throw new Error(res.error.message);
    usePageStore.setState({ state: 'ready', path: 'A.md' });
    useEditorStore.setState({ doc: res.value, path: 'A.md', status: 'saved' });
    useUiStore.setState({ focus: true });
    render(
      <>
        <FocusStrip />
        <Editor doc={res.value} mode="livePreview" label="A" />
      </>,
    );
    const strip = document.querySelector('[data-focus-strip]')!;
    expect(strip).toHaveTextContent('3 words');
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('shows only the back arrow and light / dark for an image', () => {
    usePageStore.setState({ state: 'ready', path: 'pic.png' });
    useTrailStore.setState({ back: [{ path: 'B.md' }] as never });
    useUiStore.setState({ focus: true });
    render(<FocusStrip />);
    const strip = document.querySelector('[data-focus-strip]')!;
    expect(strip.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /B/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('the night button swaps light and dark and says what it will do', async () => {
    mockIPC((cmd, raw) =>
      cmd === 'settings_set'
        ? { ...useSettingsStore.getState().settings, ...(raw as { patch: object }).patch }
        : null,
    );
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } });
    usePageStore.setState({ state: 'ready', path: 'pic.png' });
    useUiStore.setState({ focus: true });
    render(<FocusStrip />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(await screen.findByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.theme).toBe('dark');
  });
});
