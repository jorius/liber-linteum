// M4b part 3 §7: the Format bar's Attach button opens the OS file dialog
// (Rust side), then asks whether to copy the picked files into the vault or
// link them where they are; files already in the vault are linked at once.
// §8: a paste in the "absolute" link format writes the file: URL.
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickedFile } from '../../ipc';
import { clearMocks } from '../../ipc/testing';
import { resetEditorStore } from '../../stores/editorStore';
import { useToastStore } from '../../stores/toastStore';
import { fakeDisk } from '../../test/fakeDisk';
import { fileLinkFor } from './attachments';
import { Editor } from './Editor';
import { PageDoc } from './pageDoc';

const hooks = { onChange: () => undefined, onConflictCopy: () => undefined };
const viewOf = (): EditorView =>
  EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;

async function mount(path: string) {
  const res = await PageDoc.load(path, hooks);
  if (!res.ok) throw new Error(res.error.message);
  render(<Editor doc={res.value} mode="source" label="P" />);
  return res.value;
}

const outside = (name: string): PickedFile => ({
  path: `/Users/u/${name}`,
  name,
  url: `file:///Users/u/${encodeURIComponent(name)}`,
  inVault: null,
});

const attachButton = () => screen.getByRole('button', { name: 'Attach a file or image…' });

afterEach(() => {
  resetEditorStore();
  useToastStore.getState().clear();
  vi.restoreAllMocks();
  clearMocks();
});

describe('Attach (M4b part 3 §7)', () => {
  it('writes embeds for media and PDFs, links for the rest', () => {
    expect(fileLinkFor('a b.png', 'file:///u/a%20b.png')).toBe('![](file:///u/a%20b.png)');
    expect(fileLinkFor('brief.PDF', 'file:///u/brief.PDF')).toBe('![](file:///u/brief.PDF)');
    expect(fileLinkFor('data.zip', 'file:///u/data.zip')).toBe('[data.zip](file:///u/data.zip)');
    // Brackets in the name can't end the link text early.
    expect(fileLinkFor('a]b.zip', 'file:///u/a%5Db.zip')).toBe('[a b.zip](file:///u/a%5Db.zip)');
  });

  it('Copy into the vault imports the picks and embeds them at the cursor', async () => {
    const disk = fakeDisk(
      { 'P.md': 'one\ntwo\n' },
      {
        file_pick: () => [outside('a.png'), outside('b.pdf')],
        attachment_import: (args) =>
          (args.paths as string[]).map((source) => {
            const name = source.split('/').pop()!;
            return { source, ok: { path: `attachments/${name}`, link: name, copied: true } };
          }),
      },
    );
    await mount('P.md');
    act(() => viewOf().dispatch({ selection: { anchor: 4 } }));
    fireEvent.click(attachButton());
    const choice = await screen.findByRole('dialog', { name: 'Attach 2 files' });
    expect(choice.textContent).toContain('a.png');
    expect(choice.textContent).toContain(
      'Copies travel with the vault and open in Obsidian. Links keep the file where it is.',
    );
    expect(screen.getByRole('button', { name: 'Copy into the vault' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Copy into the vault' }));
    await vi.waitFor(() =>
      expect(viewOf().state.doc.toString()).toBe('one\n![[a.png]]\n![[b.pdf]]two\n'),
    );
    expect(disk.calls.find(([c]) => c === 'file_pick')?.[1]).toEqual({ page: 'P.md' });
    expect(disk.calls.find(([c]) => c === 'attachment_import')?.[1]).toEqual({
      page: 'P.md',
      paths: ['/Users/u/a.png', '/Users/u/b.pdf'],
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Link to where it is writes file: URLs in one undo step and copies nothing', async () => {
    const disk = fakeDisk(
      { 'P.md': 'x\n' },
      { file_pick: () => [outside('my pic.png'), outside('data.zip')] },
    );
    await mount('P.md');
    act(() => viewOf().dispatch({ selection: { anchor: 0 } }));
    fireEvent.click(attachButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Link to where it is' }));
    await vi.waitFor(() =>
      expect(viewOf().state.doc.toString()).toBe(
        '![](file:///Users/u/my%20pic.png)\n[data.zip](file:///Users/u/data.zip)x\n',
      ),
    );
    expect(disk.calls.some(([c]) => c === 'attachment_import')).toBe(false);
    expect(viewOf().hasFocus).toBe(true);
    act(() => {
      undo(viewOf());
    });
    expect(viewOf().state.doc.toString()).toBe('x\n');
  });

  it('files already in the vault are linked without asking', async () => {
    const disk = fakeDisk(
      { 'P.md': 'x\n' },
      {
        file_pick: () => [{ ...outside('in.png'), inVault: 'Pics/in.png' }],
        attachment_import: () => [
          { source: '/Users/u/in.png', ok: { path: 'Pics/in.png', link: 'in.png', copied: false } },
        ],
      },
    );
    await mount('P.md');
    act(() => viewOf().dispatch({ selection: { anchor: 0 } }));
    fireEvent.click(attachButton());
    await vi.waitFor(() => expect(viewOf().state.doc.toString()).toBe('![[in.png]]x\n'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(disk.calls.find(([c]) => c === 'attachment_import')?.[1]).toEqual({
      page: 'P.md',
      paths: ['/Users/u/in.png'],
    });
  });

  it('Escape cancels and gives the keyboard back to the editor', async () => {
    const disk = fakeDisk({ 'P.md': 'x\n' }, { file_pick: () => [outside('a.png')] });
    await mount('P.md');
    fireEvent.click(attachButton());
    const copy = await screen.findByRole('button', { name: 'Copy into the vault' });
    fireEvent.keyDown(copy, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(viewOf().hasFocus).toBe(true);
    expect(viewOf().state.doc.toString()).toBe('x\n');
    expect(disk.calls.some(([c]) => c === 'attachment_import')).toBe(false);
  });

  it('a cancelled dialog changes nothing', async () => {
    fakeDisk({ 'P.md': 'x\n' }, { file_pick: () => [] });
    await mount('P.md');
    fireEvent.click(attachButton());
    await vi.waitFor(() => expect(viewOf().hasFocus).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(viewOf().state.doc.toString()).toBe('x\n');
  });
});

describe('the absolute link format (M4b part 3 §8)', () => {
  it('a pasted image is written as its file: URL', async () => {
    fakeDisk(
      { 'P.md': 'x\n' },
      {
        attachment_paste: () => ({
          path: 'attachments/shot.png',
          link: 'shot.png',
          url: 'file:///Users/u/Vault/attachments/shot.png',
          copied: true,
        }),
      },
    );
    await mount('P.md');
    act(() => viewOf().dispatch({ selection: { anchor: 0 } }));
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', {
      value: {
        files: [new File([new Uint8Array([1])], 'i.png', { type: 'image/png' })],
        types: ['Files'],
        getData: () => '',
      },
    });
    viewOf().contentDOM.dispatchEvent(e);
    await vi.waitFor(() =>
      expect(viewOf().state.doc.toString()).toBe(
        '![](file:///Users/u/Vault/attachments/shot.png)x\n',
      ),
    );
  });
});
