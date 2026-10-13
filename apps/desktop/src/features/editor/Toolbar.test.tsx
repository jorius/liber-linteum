import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import { fakeDisk } from '../../test/fakeDisk';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

async function show(text: string, cursor: number) {
  fakeDisk({ 'T.md': text });
  const res = await PageDoc.load('T.md', hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(<Editor doc={res.value} mode="livePreview" label="T" />);
  act(() => viewOf().dispatch({ selection: { anchor: cursor } }));
}

beforeEach(() => useSettingsStore.setState({ settings: DEFAULT_SETTINGS }));
afterEach(() => clearMocks());

describe('formatting toolbar (M2b §6)', () => {
  it('runs a format on the editor and keeps the editor focused', async () => {
    await show('hello world\n', 8);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Bold' }));
    expect(viewOf().state.doc.toString()).toBe('hello **world**\n');
    expect(viewOf().hasFocus).toBe(true);
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: 'Bold' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await userEvent.selectOptions(within(bar).getByRole('combobox', { name: 'Text style' }), '2');
    expect(viewOf().state.doc.toString()).toBe('## hello **world**\n');
    await userEvent.click(within(bar).getByRole('button', { name: 'Task list' }));
    expect(viewOf().state.doc.toString()).toBe('- [ ] ## hello **world**\n');
  });

  it('the heading menu follows the cursor', async () => {
    await show('### Three\n\nplain\n', 4);
    const style = screen.getByRole('combobox', { name: 'Text style' });
    await waitFor(() => expect(style).toHaveValue('3'));
    act(() => viewOf().dispatch({ selection: { anchor: 13 } }));
    await waitFor(() => expect(style).toHaveValue('0'));
  });

  it('one Tab stop; arrow keys, Home and End move between the controls', async () => {
    await show('x\n', 0);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    const items = within(bar).getAllByRole('button');
    const tabbable = [...bar.querySelectorAll('button, select')].filter(
      (el) => (el as HTMLElement).tabIndex === 0,
    );
    expect(tabbable).toHaveLength(1);
    items[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(items.at(-1));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(items.at(-1));
  });

  it('has no axe violations and is hidden when the setting is off', async () => {
    await show('x\n', 0);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    const violations = await axe
      .run(bar, { rules: { 'color-contrast': { enabled: false } } })
      .then((r) => r.violations);
    expect(violations).toEqual([]);
    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, toolbar: false } }));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});
