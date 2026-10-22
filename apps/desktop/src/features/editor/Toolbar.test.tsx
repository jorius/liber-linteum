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

describe('tables from the Format bar', () => {
  const TABLE = '| Name | Moons |\n|---|---|\n| Kessari | 2 |\n| Oruk | 0 |';
  const key = (k: string, extra: KeyboardEventInit = {}) =>
    act(() => {
      viewOf().contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }),
      );
    });

  it('the size picker inserts a table; the button then shows the cursor is in one', async () => {
    await show('Intro\n\n', 7);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Table' }));
    const picker = screen.getByRole('dialog', { name: 'Insert a table' });
    expect(within(picker).getByText('2 × 2')).toBeInTheDocument();
    await userEvent.hover(within(picker).getByRole('button', { name: '3 by 2 table' }));
    expect(within(picker).getByText('3 × 2')).toBeInTheDocument();
    await userEvent.click(within(picker).getByRole('button', { name: '3 by 2 table' }));
    expect(viewOf().state.doc.toString()).toBe(
      'Intro\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(viewOf().hasFocus).toBe(true);
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: 'Table' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('the picker works from the keyboard and Escape gives the keyboard back', async () => {
    await show('x\n', 2);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    const button = within(bar).getByRole('button', { name: 'Table' });
    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}{Enter}');
    expect(viewOf().state.doc.toString()).toBe('x\n\n|     |\n| --- |');
  });

  it('in a table it opens the table menu; the header row cannot be deleted', async () => {
    await show(TABLE, TABLE.indexOf('Kessari') + 3);
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: 'Table' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await userEvent.click(within(bar).getByRole('button', { name: 'Table' }));
    const menu = screen.getByRole('menu', { name: 'Table' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Add row below' }));
    expect(viewOf().state.doc.toString()).toBe(
      '| Name    | Moons |\n| ------- | ----- |\n| Kessari | 2     |\n|         |       |\n| Oruk    | 0     |',
    );
    act(() => viewOf().dispatch({ selection: { anchor: 3 } }));
    await userEvent.click(within(bar).getByRole('button', { name: 'Table' }));
    const again = screen.getByRole('menu', { name: 'Table' });
    expect(within(again).getByRole('menuitem', { name: 'Delete row' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(again).getByRole('menuitemradio', { name: 'Center column' }));
    expect(viewOf().state.doc.toString().split('\n')[1]).toBe('| :-----: | ----- |');
  });

  it('Tab and Enter move between cells in the editor, before list continuation', async () => {
    await show(TABLE, TABLE.indexOf('Kessari') + 7);
    key('Tab');
    const doc = () => viewOf().state.doc.toString();
    const sel = () => viewOf().state.selection.main;
    expect(doc().slice(sel().from, sel().to)).toBe('2');
    key('Enter');
    expect(doc().split('\n')[3]).toBe('| Oruk    | 0     |');
    expect(viewOf().state.doc.lineAt(sel().head).number).toBe(4);
    key('Tab', { shiftKey: true });
    expect(doc().slice(sel().from, sel().to)).toBe('Oruk');
  });

  it('in Live Preview, a click on a cell puts the cursor at the end of its text', async () => {
    const text = `${TABLE}\n\nAfter`;
    await show(text, text.length);
    const cell = await screen.findByRole('cell', { name: 'Oruk' });
    act(() => {
      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(viewOf().state.selection.main.head).toBe(text.indexOf('Oruk') + 4);
  });
});
