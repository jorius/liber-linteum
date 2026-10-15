import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { mayClose, resetEditorStore, useEditorStore } from '../../stores/editorStore';
import { usePageStore } from '../../stores/pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { fakeDisk } from '../../test/fakeDisk';
import { DialogHost } from '../dialogs/DialogHost';
import { confirmUnsaved } from './unsavedPrompt';

const editor = () => useEditorStore.getState();
const autoSave = (on: boolean) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoSave: on } });

beforeEach(() => {
  autoSave(false);
  useUiStore.setState({ dialog: null });
  usePageStore.getState().clear();
});
afterEach(() => {
  resetEditorStore();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  clearMocks();
});

async function editA(disk = fakeDisk({ 'A.md': 'a\n', 'B.md': 'b\n' })) {
  await usePageStore.getState().load('A.md');
  editor().doc!.edit('a edited\n');
  return disk;
}

describe('Save / Don’t Save / Cancel (M5b §6, auto save off)', () => {
  it('asks nothing with auto save on, or with nothing unsaved', async () => {
    autoSave(true);
    await editA();
    expect(await confirmUnsaved()).toBe(true);
    autoSave(false);
    editor().doc!.revert();
    expect(await confirmUnsaved()).toBe(true);
    expect(useUiStore.getState().dialog).toBeNull();
  });

  it('Save writes the page, then lets it go', async () => {
    const disk = await editA();
    render(<DialogHost />);
    const asked = confirmUnsaved();
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await asked).toBe(true);
    expect(disk.files.get('A.md')).toBe('a edited\n');
  });

  it('Don’t Save drops the text and writes nothing', async () => {
    const disk = await editA();
    render(<DialogHost />);
    const asked = confirmUnsaved();
    await userEvent.click(await screen.findByRole('button', { name: 'Don’t Save' }));
    expect(await asked).toBe(true);
    expect(disk.writes()).toEqual([]);
    expect(editor().doc!.text).toBe('a\n');
  });

  it('Cancel (and Escape) keep the text, unsaved', async () => {
    const disk = await editA();
    render(<DialogHost />);
    let asked = confirmUnsaved();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await asked).toBe(false);
    asked = confirmUnsaved();
    await screen.findByRole('dialog', { name: 'Save changes to “A”?' });
    await userEvent.keyboard('{Escape}');
    expect(await asked).toBe(false);
    expect(editor().doc!.text).toBe('a edited\n');
    expect(disk.writes()).toEqual([]);
  });

  it('is axe-clean', async () => {
    await editA();
    const { container } = render(<DialogHost />);
    void confirmUnsaved();
    await screen.findByRole('dialog');
    const violations = await axe
      .run(container, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
  });

  it('review focus 1: opening another page asks first; Cancel stays on the page', async () => {
    await editA();
    render(<DialogHost />);
    const loading = usePageStore.getState().load('B.md');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await loading;
    expect(usePageStore.getState().path).toBe('A.md');
    expect(editor().path).toBe('A.md');
    expect(editor().doc!.text).toBe('a edited\n');
  });

  it('review focus 1: Don’t Save, then the other page opens', async () => {
    const disk = await editA();
    render(<DialogHost />);
    const loading = usePageStore.getState().load('B.md');
    await userEvent.click(await screen.findByRole('button', { name: 'Don’t Save' }));
    await loading;
    expect(editor().path).toBe('B.md');
    expect(disk.writes()).toEqual([]);
  });

  it('review focus 2: closing the window asks; Cancel keeps it open', async () => {
    await editA();
    render(<DialogHost />);
    const closing = mayClose();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await closing).toBe(false);
  });

  it('a second question replaces the first, which counts as Cancel', async () => {
    await editA();
    render(<DialogHost />);
    const first = confirmUnsaved();
    await screen.findByRole('dialog');
    const second = confirmUnsaved();
    expect(await first).toBe(false);
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(await second).toBe(true);
  });
});
