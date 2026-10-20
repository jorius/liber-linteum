import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, emit, mockWindows } from '../../ipc/testing';
import { resetEditorStore, useEditorStore } from '../../stores/editorStore';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { fakeDisk } from '../../test/fakeDisk';
import { dragPixelRatio, embedFor, installFileDrop, pastedName } from './attachments';
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

/** A paste event carrying `files` and, optionally, plain text. */
function paste(files: File[], text = '') {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: {
      files,
      types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
      getData: (t: string) => (t === 'text/plain' ? text : ''),
    },
  });
  viewOf().contentDOM.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  useToastStore.getState().clear();
  // jsdom has no layout: give `elementFromPoint` something to spy on.
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  resetEditorStore();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearMocks();
});

describe('attachment helpers (M2c §5)', () => {
  it('names pasted images like Obsidian (local time)', () => {
    const at = new Date(2026, 9, 14, 9, 5, 7);
    expect(pastedName(at, 'image/png')).toBe('Pasted image 20261014090507.png');
    expect(pastedName(at, 'image/jpeg')).toBe('Pasted image 20261014090507.jpg');
    expect(pastedName(at, 'image/svg+xml')).toBeNull();
  });

  it('embeds media and PDFs, links everything else', () => {
    expect(embedFor('a.png')).toBe('![[a.png]]');
    expect(embedFor('attachments/b.PDF')).toBe('![[attachments/b.PDF]]');
    expect(embedFor('song.m4a')).toBe('![[song.m4a]]');
    expect(embedFor('clip.webm')).toBe('![[clip.webm]]');
    expect(embedFor('data.zip')).toBe('[[data.zip]]');
    expect(embedFor('Draft')).toBe('[[Draft]]');
  });
});

describe('paste (M2c §5.1)', () => {
  it('a pasted image is saved and its embed replaces the selection', async () => {
    const pasted: unknown[] = [];
    fakeDisk(
      { 'P.md': 'see X here\n' },
      {
        attachment_paste: (bytes) => {
          pasted.push(bytes);
          return { path: 'attachments/shot.png', link: 'shot.png', copied: true };
        },
      },
    );
    await mount('P.md');
    act(() => viewOf().dispatch({ selection: { anchor: 4, head: 5 } }));
    const e = paste([new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })]);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(viewOf().state.doc.toString()).toBe('see ![[shot.png]] here\n'));
    expect(pasted).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('text pastes are left to the editor', async () => {
    const disk = fakeDisk({ 'P.md': 'x\n' });
    await mount('P.md');
    // CodeMirror's own paste inserts the text (an image copied with its
    // alt text/URL is pasted as text, as in Obsidian).
    paste([new File(['x'], 'i.png', { type: 'image/png' })], 'plain text');
    expect(viewOf().state.doc.toString()).toBe('plain textx\n');
    expect(disk.calls.some(([c]) => c === 'attachment_paste')).toBe(false);
  });

  it('a failed save says why and inserts nothing', async () => {
    fakeDisk(
      { 'P.md': 'x\n' },
      {
        attachment_paste: () => {
          throw { kind: 'tooLarge', message: 'pasted images are limited to 64 MiB' };
        },
      },
    );
    await mount('P.md');
    paste([new File(['x'], 'i.png', { type: 'image/png' })]);
    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'That file is too large to paste.',
      ),
    );
    expect(viewOf().state.doc.toString()).toBe('x\n');
  });
});

describe('drop (M2c §5.2)', () => {
  const payload = (x: number, y: number, paths?: string[]) => ({
    ...(paths ? { paths } : {}),
    position: { x, y },
  });

  it('files dropped on the text are imported and inserted where they landed', async () => {
    mockWindows('main');
    const imported: unknown[] = [];
    fakeDisk(
      { 'P.md': 'one\ntwo\n' },
      {
        attachment_import: (args) => {
          imported.push(args);
          return [
            { source: '/u/a.png', ok: { path: 'attachments/a.png', link: 'a.png', copied: true } },
            { source: '/u/b.zip', ok: { path: 'attachments/b.zip', link: 'b.zip', copied: true } },
            { source: '/u/dir', err: { kind: 'notAFile', message: 'not a file: /u/dir' } },
          ];
        },
      },
    );
    const stop = await installFileDrop();
    const doc = await mount('P.md');
    await act(() => useEditorStore.setState({ doc, path: 'P.md' }));
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
    vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(4); // start of "two"
    await act(() =>
      emit('tauri://drag-enter', payload(20, 30, ['/u/a.png', '/u/b.zip', '/u/dir'])),
    );
    await act(() => emit('tauri://drag-over', payload(20, 30)));
    expect(viewOf().contentDOM.querySelector('.cm-liber-drop-caret')).not.toBeNull();
    await act(() => emit('tauri://drag-drop', payload(20, 30, ['/u/a.png', '/u/b.zip', '/u/dir'])));
    await vi.waitFor(() =>
      expect(viewOf().state.doc.toString()).toBe('one\n![[a.png]]\n[[b.zip]]two\n'),
    );
    expect(imported).toEqual([{ page: 'P.md', paths: ['/u/a.png', '/u/b.zip', '/u/dir'] }]);
    expect(viewOf().contentDOM.querySelector('.cm-liber-drop-caret')).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Some files weren’t attached');
    expect(useToastStore.getState().toasts.at(-1)?.detail).toEqual([
      "dir: Folders can't be attached.",
    ]);
    await stop();
  });

  it('typing while files copy keeps the drop point', async () => {
    mockWindows('main');
    let release: (v: unknown) => void = () => undefined;
    fakeDisk(
      { 'P.md': 'abc\n' },
      {
        attachment_import: () =>
          new Promise((r) => {
            release = r;
          }),
      },
    );
    const stop = await installFileDrop();
    await mount('P.md');
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
    vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(2);
    await act(() => emit('tauri://drag-drop', payload(1, 1, ['/u/a.png'])));
    act(() => viewOf().dispatch({ changes: { from: 0, insert: 'XX' } }));
    release([{ source: '/u/a.png', ok: { path: 'a.png', link: 'a.png', copied: true } }]);
    await vi.waitFor(() => expect(viewOf().state.doc.toString()).toBe('XXab![[a.png]]c\n'));
    await stop();
  });

  it('a second drag while files copy leaves the first drop point alone (final review minor 4)', async () => {
    mockWindows('main');
    let release: (v: unknown) => void = () => undefined;
    fakeDisk(
      { 'P.md': 'abcdefghij\n' },
      {
        attachment_import: () =>
          new Promise((r) => {
            release = r;
          }),
      },
    );
    const stop = await installFileDrop();
    await mount('P.md');
    act(() => viewOf().dispatch({ selection: { anchor: 9 } }));
    const carets = () => viewOf().contentDOM.querySelectorAll('.cm-liber-drop-caret').length;
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
    const pos = vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(2);
    await act(() => emit('tauri://drag-enter', payload(1, 1, ['/u/a.png'])));
    await act(() => emit('tauri://drag-drop', payload(1, 1, ['/u/a.png'])));
    expect(carets()).toBe(1); // where a.png will land
    // Another file is dragged over the text and away while a.png copies.
    pos.mockReturnValue(5);
    await act(() => emit('tauri://drag-enter', payload(1, 1, ['/u/b.png'])));
    await act(() => emit('tauri://drag-over', payload(1, 1)));
    expect(carets()).toBe(2);
    await act(() => emit('tauri://drag-leave', null));
    expect(carets()).toBe(1);
    act(() => viewOf().dispatch({ changes: { from: 0, insert: 'XX' } }));
    release([{ source: '/u/a.png', ok: { path: 'a.png', link: 'a.png', copied: true } }]);
    await vi.waitFor(() => expect(viewOf().state.doc.toString()).toBe('XXab![[a.png]]cdefghij\n'));
    expect(carets()).toBe(0);
    await stop();
  });

  it('drops copying at the same time each land at their own point', async () => {
    mockWindows('main');
    const releases: ((v: unknown) => void)[] = [];
    fakeDisk(
      { 'P.md': 'abcdefghij\n' },
      {
        attachment_import: () =>
          new Promise((r) => {
            releases.push(r);
          }),
      },
    );
    const stop = await installFileDrop();
    await mount('P.md');
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
    const pos = vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(2);
    await act(() => emit('tauri://drag-drop', payload(1, 1, ['/u/a.png'])));
    pos.mockReturnValue(5);
    await act(() => emit('tauri://drag-drop', payload(1, 1, ['/u/b.png'])));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]([{ source: '/u/b.png', ok: { path: 'b.png', link: 'b.png', copied: true } }]);
    await vi.waitFor(() => expect(viewOf().state.doc.toString()).toBe('abcde![[b.png]]fghij\n'));
    releases[0]([{ source: '/u/a.png', ok: { path: 'a.png', link: 'a.png', copied: true } }]);
    await vi.waitFor(() =>
      expect(viewOf().state.doc.toString()).toBe('ab![[a.png]]cde![[b.png]]fghij\n'),
    );
    await stop();
  });

  describe('drop coordinates (final review C1)', () => {
    // Tauri types drag positions as physical pixels, but only WebView2 reports
    // them so. On macOS wry 0.57.0 passes AppKit points (CSS pixels) through
    // and tauri-runtime-wry 2.12.1 wraps them in PhysicalPosition unscaled.
    const MAC = {
      platform: 'MacIntel',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    };
    const LINUX = {
      platform: 'Linux x86_64',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    };
    const WINDOWS = {
      platform: 'Win32',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    };
    /** A `ratio`× screen on `os`. */
    function on(os: { platform: string; ua: string }, ratio: number) {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(os.platform);
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(os.ua);
      vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(ratio);
    }

    it('only Windows reports physical pixels', () => {
      on(MAC, 2);
      expect(dragPixelRatio()).toBe(1);
      on(LINUX, 2);
      expect(dragPixelRatio()).toBe(1);
      on(WINDOWS, 2);
      expect(dragPixelRatio()).toBe(2);
      on(WINDOWS, 1.5);
      expect(dragPixelRatio()).toBe(1.5);
    });

    async function hoverAt(x: number, y: number) {
      mockWindows('main');
      fakeDisk({ 'P.md': 'x\n' });
      const stop = await installFileDrop();
      await mount('P.md');
      const at = vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
      const pos = vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(1);
      await act(() => emit('tauri://drag-enter', payload(x, y, ['/u/a.png'])));
      await act(() => emit('tauri://drag-over', payload(x, y)));
      await stop();
      return { at, pos };
    }

    it('on a Retina Mac the position is used as is (CSS pixels)', async () => {
      on(MAC, 2);
      const { at, pos } = await hoverAt(40, 60);
      expect(at).toHaveBeenLastCalledWith(40, 60);
      expect(pos).toHaveBeenLastCalledWith({ x: 40, y: 60 });
    });

    it('on Windows the position is divided by devicePixelRatio', async () => {
      on(WINDOWS, 2);
      const { at, pos } = await hoverAt(40, 60);
      expect(at).toHaveBeenLastCalledWith(20, 30);
      expect(pos).toHaveBeenLastCalledWith({ x: 20, y: 30 });
    });
  });

  it('text drags (no files) are ignored: no caret, toast or copy (final review minor 3)', async () => {
    // wry routes every drag through the native handler; a text drag has no paths.
    mockWindows('main');
    const disk = fakeDisk({ 'P.md': 'x\n' });
    const stop = await installFileDrop();
    await mount('P.md');
    const copying: number[] = [];
    const unsubscribe = useEditorStore.subscribe((s) => copying.push(s.copying));
    const at = vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
    vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(1);
    await act(() => emit('tauri://drag-enter', payload(1, 1, [])));
    await act(() => emit('tauri://drag-over', payload(1, 1)));
    expect(viewOf().contentDOM.querySelector('.cm-liber-drop-caret')).toBeNull();
    await act(() => emit('tauri://drag-drop', payload(1, 1, [])));
    // …and dropped outside the text.
    at.mockReturnValue(document.body);
    await act(() => emit('tauri://drag-enter', payload(1, 1, [])));
    await act(() => emit('tauri://drag-over', payload(1, 1)));
    await act(() => emit('tauri://drag-drop', payload(1, 1, [])));
    await act(() => emit('tauri://drag-leave', null));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    unsubscribe();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(disk.calls.some(([c]) => c === 'attachment_import')).toBe(false);
    expect(copying.filter((n) => n > 0)).toEqual([]);
    expect(viewOf().state.doc.toString()).toBe('x\n');
    await stop();
  });

  it('a file drag after a text drag shows the caret again', async () => {
    mockWindows('main');
    fakeDisk({ 'P.md': 'x\n' });
    const stop = await installFileDrop();
    await mount('P.md');
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
    vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(1);
    await act(() => emit('tauri://drag-enter', payload(1, 1, [])));
    await act(() => emit('tauri://drag-leave', null));
    await act(() => emit('tauri://drag-enter', payload(1, 1, ['/u/a.png'])));
    await act(() => emit('tauri://drag-over', payload(1, 1)));
    expect(viewOf().contentDOM.querySelector('.cm-liber-drop-caret')).not.toBeNull();
    await act(() => emit('tauri://drag-leave', null));
    expect(viewOf().contentDOM.querySelector('.cm-liber-drop-caret')).toBeNull();
    await stop();
  });

  it('a drop outside the text explains where to drop', async () => {
    mockWindows('main');
    const disk = fakeDisk({ 'P.md': 'x\n' });
    const stop = await installFileDrop();
    await mount('P.md');
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.body);
    await act(() => emit('tauri://drag-drop', payload(1, 1, ['/u/a.png'])));
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'Drop files onto the page’s text to attach them',
    );
    expect(disk.calls.some(([c]) => c === 'attachment_import')).toBe(false);
    await stop();
  });
});

describe('a page switch while a paste or drop is saved (final review I1)', () => {
  const payload = (paths: string[]) => ({ paths, position: { x: 1, y: 1 } });
  const caretCount = () => viewOf().contentDOM.querySelectorAll('.cm-liber-drop-caret').length;
  /** `attachment_import` held: the drop is copying until `held.release`. */
  function slowImport(files: Record<string, string>) {
    const held: { release: (v: unknown) => void } = { release: () => undefined };
    const disk = fakeDisk(files, {
      attachment_import: () =>
        new Promise((r) => {
          held.release = r;
        }),
    });
    return { disk, held };
  }
  const bigMov = [
    { source: '/u/big.mov', ok: { path: 'A/attachments/big.mov', link: 'big.mov', copied: true } },
  ];
  async function load(path: string) {
    const res = await PageDoc.load(path, hooks);
    if (!res.ok) throw new Error(res.error.message);
    return res.value;
  }
  /** Shows `a` and drops big.mov after its first character. */
  async function dropOnA(a: PageDoc) {
    const shown = render(<Editor doc={a} mode="source" label="P" />);
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(viewOf().contentDOM);
    vi.spyOn(viewOf(), 'posAtCoords').mockReturnValue(1);
    await act(() => emit('tauri://drag-drop', payload(['/u/big.mov'])));
    return shown;
  }

  it('a drop lands in the page it was dropped on, not the one shown now', async () => {
    mockWindows('main');
    const { disk, held } = slowImport({ 'A/a.md': 'AAA\n', 'B/b.md': 'BBB\n' });
    const stop = await installFileDrop();
    const a = await load('A/a.md');
    const b = await load('B/b.md');
    const { rerender } = await dropOnA(a);
    rerender(<Editor doc={b} mode="source" label="P" />);
    held.release(bigMov);
    await vi.waitFor(() => expect(a.text).toBe('A![[big.mov]]AA\n'));
    expect(b.text).toBe('BBB\n');
    expect(viewOf().state.doc.toString()).toBe('BBB\n');
    await a.flush();
    expect(disk.files.get('A/a.md')).toBe('A![[big.mov]]AA\n');
    expect(disk.files.get('B/b.md')).toBe('BBB\n');
    // Back on A: the embed is there, no caret is left, and ⌘Z undoes it.
    rerender(<Editor doc={a} mode="source" label="P" />);
    expect(viewOf().state.doc.toString()).toBe('A![[big.mov]]AA\n');
    expect(caretCount()).toBe(0);
    act(() => void undo(viewOf()));
    expect(viewOf().state.doc.toString()).toBe('AAA\n');
    await stop();
  });

  it('keeps what changed on disk in the background meanwhile', async () => {
    mockWindows('main');
    const { disk, held } = slowImport({ 'A/a.md': 'AAA\n', 'B/b.md': 'BBB\n' });
    const stop = await installFileDrop();
    const a = await load('A/a.md');
    const b = await load('B/b.md');
    const { rerender } = await dropOnA(a);
    rerender(<Editor doc={b} mode="source" label="P" />);
    disk.files.set('A/a.md', 'AAA\nfrom Obsidian\n');
    await a.sync();
    expect(a.text).toBe('AAA\nfrom Obsidian\n');
    held.release(bigMov);
    await vi.waitFor(() => expect(a.text).toBe('A![[big.mov]]AA\nfrom Obsidian\n'));
    rerender(<Editor doc={a} mode="source" label="P" />);
    expect(viewOf().state.doc.toString()).toBe('A![[big.mov]]AA\nfrom Obsidian\n');
    await stop();
  });

  it('a drop that finishes after the editor closed still reaches its page', async () => {
    mockWindows('main');
    const { held } = slowImport({ 'A/a.md': 'AAA\n' });
    const stop = await installFileDrop();
    const a = await load('A/a.md');
    const { unmount } = await dropOnA(a);
    unmount();
    held.release(bigMov);
    await vi.waitFor(() => expect(a.text).toBe('A![[big.mov]]AA\n'));
    await stop();
  });

  it('a drop that finishes after another vault opened is not linked anywhere', async () => {
    mockWindows('main');
    useVaultStore.setState({ info: { name: 'One', root: '/one', report: {} as never } });
    const { held } = slowImport({ 'A/a.md': 'AAA\n' });
    const stop = await installFileDrop();
    const a = await load('A/a.md');
    const { unmount } = await dropOnA(a);
    unmount();
    useVaultStore.setState({ info: { name: 'Two', root: '/two', report: {} as never } });
    held.release(bigMov);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(a.text).toBe('AAA\n');
    useVaultStore.setState({ info: null });
    await stop();
  });

  it('a paste lands in the page it was pasted into', async () => {
    const held: { release: (v: unknown) => void } = { release: () => undefined };
    let asked = false;
    fakeDisk(
      { 'A/a.md': 'AAA\n', 'B/b.md': 'BBB\n' },
      {
        attachment_paste: () =>
          new Promise((r) => {
            asked = true;
            held.release = r;
          }),
      },
    );
    const a = await load('A/a.md');
    const b = await load('B/b.md');
    const { rerender } = render(<Editor doc={a} mode="source" label="P" />);
    act(() => viewOf().dispatch({ selection: { anchor: 1, head: 2 } }));
    paste([new File([new Uint8Array([1])], 'i.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(asked).toBe(true));
    rerender(<Editor doc={b} mode="source" label="P" />);
    held.release({ path: 'A/attachments/shot.png', link: 'shot.png', copied: true });
    await vi.waitFor(() => expect(a.text).toBe('A![[shot.png]]A\n'));
    expect(b.text).toBe('BBB\n');
    expect(viewOf().state.doc.toString()).toBe('BBB\n');
  });
});

describe('pasting other image types (M4b §4)', () => {
  /** jsdom can't decode images: stand-ins for the webview's decoder. */
  function decoder(ok: boolean) {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        if (!ok) throw new Error('cannot decode');
        return { width: 2, height: 1, close: () => undefined };
      }),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob([png], { type: 'image/png' }));
    });
    return png;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('a TIFF (Preview, Photos) is converted to PNG before it is saved', async () => {
    const png = decoder(true);
    const saved: unknown[] = [];
    fakeDisk(
      { 'P.md': 'x\n' },
      {
        attachment_paste: (bytes) => {
          saved.push(bytes);
          return { path: 'attachments/shot.png', link: 'shot.png', copied: true };
        },
      },
    );
    await mount('P.md');
    const e = paste([new File([new Uint8Array([1, 2])], 'clip.tiff', { type: 'image/tiff' })]);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(viewOf().state.doc.toString()).toBe('![[shot.png]]x\n'));
    // The PNG the decoder drew, not the TIFF's own bytes.
    expect(saved).toEqual([png]);
  });

  it('an image the webview can’t decode says so and saves nothing', async () => {
    decoder(false);
    const disk = fakeDisk({ 'P.md': 'x\n' });
    await mount('P.md');
    paste([new File([new Uint8Array([1])], 'odd.heic', { type: 'image/heic' })]);
    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'This image can’t be pasted. Save it as PNG or JPEG first.',
      ),
    );
    expect(disk.calls.some(([c]) => c === 'attachment_paste')).toBe(false);
    expect(viewOf().state.doc.toString()).toBe('x\n');
  });

  it('review focus: one undecodable image among others: the rest are saved, in order', async () => {
    decoder(false);
    const saved: number[][] = [];
    fakeDisk(
      { 'P.md': 'x\n' },
      {
        attachment_paste: (bytes) => {
          saved.push([...(bytes as unknown as Uint8Array)]);
          const link = saved.length === 1 ? 'one.png' : 'two.jpg';
          return { path: `attachments/${link}`, link, copied: true };
        },
      },
    );
    await mount('P.md');
    paste([
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'odd.heic', { type: 'image/heic' }),
      new File([new Uint8Array([3])], 'b.jpg', { type: 'image/jpeg' }),
    ]);
    await vi.waitFor(() =>
      expect(viewOf().state.doc.toString()).toBe('![[one.png]]\n![[two.jpg]]x\n'),
    );
    expect(saved).toEqual([[1], [3]]);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'This image can’t be pasted. Save it as PNG or JPEG first.',
    );
  });

  it('SVG is left to the editor’s own paste (never decoded or saved)', async () => {
    decoder(true);
    const disk = fakeDisk({ 'P.md': 'x\n' });
    await mount('P.md');
    paste([new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })]);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(disk.calls.some(([c]) => c === 'attachment_paste')).toBe(false);
  });
});
