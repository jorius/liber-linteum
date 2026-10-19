import { EditorView } from '@codemirror/view';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { mayClose, resetEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { resetVaultStore, useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { PageScreen } from '../../test/pageScreen';
import { clipName, resetRecorder, useRecorderStore } from './recorderStore';

const open = (path: string) => act(() => usePageStore.getState().load(path));
const view = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
const text = () => view().state.doc.toString();

const level = (elapsedMs: number, peak = 0.4, ended: 'deviceLost' | null = null) =>
  act(() =>
    useRecorderStore.getState().onLevel({ recordingId: 7, rms: peak / 2, peak, elapsedMs, ended }),
  );

/** A backend with one synthetic microphone; Stop saves `clip-…wav`. */
function disk(pages: Record<string, string>) {
  return fakeDisk(pages, {
    audio_devices: () => [{ id: 'mic', name: 'Built-in Microphone', isDefault: true }],
    audio_record_start: () => ({ recordingId: 7 }),
    audio_record_stop: () => ({
      path: 'attachments/clip-20261018-101500.wav',
      link: 'clip-20261018-101500.wav',
      copied: true,
    }),
    audio_record_cancel: () => null,
    audio_pick: () => ({ path: 'attachments/memo.m4a', link: 'memo.m4a', copied: true }),
    vault_tree: () => [],
  });
}

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useVaultStore.setState({ info: { name: 'Vault', root: '/v', report: {} as never } });
});
afterEach(async () => {
  resetRecorder();
  usePageStore.getState().clear();
  resetEditorStore();
  await resetVaultStore();
  vi.useRealTimers();
  clearMocks();
});

describe('Recorder (M6 §2)', () => {
  it('names clips by the local time they start', () => {
    expect(clipName(new Date(2026, 9, 18, 10, 15, 0))).toBe('clip-20261018-101500');
    expect(clipName(new Date(2026, 0, 2, 3, 4, 5))).toBe('clip-20260102-030405');
  });

  it('records into the cursor of the page it started on, through edits made meanwhile', async () => {
    const d = disk({ 'A.md': '# A\n\nStart end\n', 'B.md': '# B\n' });
    render(<PageScreen />);
    await open('A.md');
    await waitFor(() => expect(text()).toContain('Start end'));
    act(() => view().dispatch({ selection: { anchor: '# A\n\nStart'.length } }));
    await userEvent.click(screen.getByRole('button', { name: 'Record clip' }));
    const bar = await screen.findByRole('region', { name: 'Recorder' });
    expect(within(bar).getByRole('combobox', { name: 'Microphone' })).toHaveValue('mic');
    await userEvent.click(within(bar).getByRole('button', { name: 'Start recording' }));
    expect(d.calls.find(([c]) => c === 'audio_record_start')?.[1]).toMatchObject({
      page: 'A.md',
      device: 'mic',
    });
    expect(within(bar).getByRole('button', { name: 'Stop & insert' })).toHaveFocus();
    level(12_000);
    expect(within(bar).getByText('0:12')).toBeInTheDocument();
    // An edit before the reserved place moves it.
    act(() => view().dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' }));
    // Another page is shown before the take ends: the clip still goes to A.
    await open('B.md');
    await userEvent.click(screen.getByRole('button', { name: 'Stop & insert' }));
    await waitFor(() => expect(useRecorderStore.getState().phase).toBe('closed'));
    const landed = 'X# A\n\nStart![[clip-20261018-101500.wav]] end\n';
    // Into A, saved in the background, not into B on screen.
    await waitFor(() => expect(d.files.get('A.md')).toBe(landed), { timeout: 3000 });
    expect(text()).toBe('# B\n');
    await open('A.md');
    await waitFor(() => expect(text()).toBe(landed));
  });

  it('Cancel inserts nothing; Escape while recording asks first', async () => {
    const d = disk({ 'A.md': 'Body\n' });
    render(<PageScreen />);
    await open('A.md');
    await userEvent.click(await screen.findByRole('button', { name: 'Record clip' }));
    const bar = await screen.findByRole('region', { name: 'Recorder' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Start recording' }));
    await userEvent.keyboard('{Escape}');
    expect(within(bar).getByText('Discard this recording?')).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Keep recording' }));
    expect(useRecorderStore.getState().phase).toBe('recording');
    await userEvent.click(within(bar).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(useRecorderStore.getState().phase).toBe('closed'));
    expect(d.calls.some(([c]) => c === 'audio_record_cancel')).toBe(true);
    expect(text()).toBe('Body\n');
  });

  it('announces the time every 10 s; notices silence and a lost microphone', async () => {
    disk({ 'A.md': 'Body\n' });
    render(<PageScreen />);
    await open('A.md');
    await userEvent.click(await screen.findByRole('button', { name: 'Record clip' }));
    const bar = await screen.findByRole('region', { name: 'Recorder' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Start recording' }));
    const live = within(bar).getByRole('status');
    level(9_950);
    expect(live).toHaveTextContent('');
    level(10_000);
    expect(live).toHaveTextContent('Recording, 10 seconds');
    for (let ms = 10_050; ms <= 13_100; ms += 50) level(ms, 0);
    expect(within(bar).getByText(/No sound is reaching the app/)).toBeInTheDocument();
    level(13_150, 0.3);
    expect(within(bar).queryByText(/No sound is reaching the app/)).toBeNull();
    level(13_200, 0, 'deviceLost');
    expect(within(bar).getByText(/The microphone was disconnected/)).toBeInTheDocument();
  });

  it('Upload clip inserts the picked file at the cursor', async () => {
    disk({ 'A.md': 'Body\n' });
    render(<PageScreen />);
    await open('A.md');
    act(() => view().dispatch({ selection: { anchor: 4 } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Record clip' }));
    const bar = await screen.findByRole('region', { name: 'Recorder' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Upload clip…' }));
    await waitFor(() => expect(text()).toBe('Body![[memo.m4a]]\n'));
  });

  it('closing the window stops the take and inserts it before saving', async () => {
    disk({ 'A.md': 'Body\n' });
    render(<PageScreen />);
    await open('A.md');
    await userEvent.click(await screen.findByRole('button', { name: 'Record clip' }));
    const bar = await screen.findByRole('region', { name: 'Recorder' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Start recording' }));
    await act(async () => {
      expect(await mayClose()).toBe(true);
    });
    expect(text()).toContain('![[clip-20261018-101500.wav]]');
    expect(useRecorderStore.getState().phase).toBe('closed');
  });

  it('is not offered on archived pages; the bar passes axe', async () => {
    disk({ '.archive/Old.md': '# Old\n', 'A.md': 'Body\n' });
    render(<PageScreen />);
    await open('.archive/Old.md');
    await waitFor(() => expect(document.querySelector('.cm-editor')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Record clip' })).toBeNull();
    await open('A.md');
    await userEvent.click(await screen.findByRole('button', { name: 'Record clip' }));
    const bar = await screen.findByRole('region', { name: 'Recorder' });
    expect(within(bar).getByRole('button', { name: 'Start recording' })).toHaveFocus();
    const violations = (await axe.run(bar)).violations;
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
