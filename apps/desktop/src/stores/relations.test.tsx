import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../features/editor/Editor';
import { clearMocks } from '../ipc/testing';
import { fakeDisk, hashOf } from '../test/fakeDisk';
import { resetEditorStore, useEditorStore } from './editorStore';
import { relate, relationsOf, removeRelation, updateRelation } from './relations';
import { useToastStore } from './toastStore';

const editor = () => useEditorStore.getState();
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);

/** Link targets and resolution as the backend answers them in these tests. */
const extra = {
  link_target: (a: Record<string, unknown>) => String(a.target).replace(/\.md$/, ''),
  links_resolve: (a: Record<string, unknown>) =>
    (a.targets as { target: string }[]).map((t) => `${t.target}.md`),
};

beforeEach(() => useToastStore.getState().clear());
afterEach(() => {
  resetEditorStore();
  clearMocks();
});

describe('relationships written to pages (M3b §5)', () => {
  it('a page not open in the editor: read, edit, written back with its hash', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n', 'B.md': '# B\n' }, extra);
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    const write = disk.calls.find(([c]) => c === 'page_write')![1];
    expect(write.expectedHash).toBe(hashOf('# A\n'));
    // The same target again: nothing written, its entry is answered.
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'exists', index: 0 });
    expect(disk.writes()).toHaveLength(1);
    expect(await relationsOf('A.md')).toEqual([
      {
        source: 'A.md',
        path: 'B.md',
        index: 0,
        link: '[[B]]',
        target: 'B',
        label: null,
        directed: false,
      },
    ]);
  });

  it('the page open in the editor: an undoable change, saved at once', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n', 'B.md': '# B\n' }, extra);
    await act(() => editor().open('A.md'));
    render(<Editor doc={editor().doc!} mode="source" label="A" />);
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!;
    await act(async () => {
      expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    });
    expect(view.state.doc.toString()).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe('# A\n');
  });

  it('a change on disk meanwhile is retried once on the new text', async () => {
    let raced = false;
    const disk = fakeDisk(
      { 'A.md': '# A\n' },
      {
        ...extra,
        page_read: (a: Record<string, unknown>) => {
          const text = disk.files.get(String(a.path))!;
          // Another program writes right after the first read.
          if (!raced) {
            raced = true;
            disk.files.set('A.md', '# A changed\n');
          }
          return { text, hash: hashOf(text) };
        },
      },
    );
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A changed\n');
  });

  it('a page that keeps changing: one toast, the page left as it is', async () => {
    const disk = fakeDisk(
      { 'A.md': '# A\n' },
      {
        ...extra,
        page_write: () => {
          throw { kind: 'conflict', message: 'changed', currentText: 'x', currentHash: 'h:x' };
        },
      },
    );
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'failed' });
    expect(disk.files.get('A.md')).toBe('# A\n');
    expect(toasts()).toEqual(['Couldn’t update A: it changed on disk. Try again.']);
  });

  it('frontmatter it can’t edit safely: refused with the Source-mode toast', async () => {
    const disk = fakeDisk({ 'A.md': '---\nrelated: [oops\n---\n' }, extra);
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'failed' });
    expect(disk.writes()).toEqual([]);
    expect(toasts()).toEqual([
      'NIMW can’t safely change this note’s frontmatter. Edit it in Source mode.',
    ]);
  });

  it('a CRLF page keeps its line endings', async () => {
    const disk = fakeDisk({ 'A.md': '---\r\ntitle: x\r\n---\r\n# A\r\n' }, extra);
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'created' });
    expect(disk.files.get('A.md')).toBe(
      '---\r\ntitle: x\r\nrelated:\r\n  - "[[B]]"\r\n---\r\n# A\r\n',
    );
  });

  it('edits and deletes name the entry they read, and refuse a list that moved', async () => {
    const disk = fakeDisk({ 'A.md': '---\nrelated:\n  - "[[B]]"\n  - "[[C]]"\n---\n' }, extra);
    const [b, c] = await relationsOf('A.md');
    expect(await updateRelation(c, { label: 'why', directed: true })).toBe(true);
    expect(disk.files.get('A.md')).toBe(
      '---\nrelated:\n  - "[[B]]"\n  - { link: "[[C]]", label: why, directed: true }\n---\n',
    );
    expect(await removeRelation(b)).toBe(true);
    expect(disk.files.get('A.md')).toBe(
      '---\nrelated:\n  - { link: "[[C]]", label: why, directed: true }\n---\n',
    );
    // `b` named index 0, which is now C: refused, nothing written.
    const writes = disk.writes().length;
    expect(await removeRelation(b)).toBe(false);
    expect(disk.writes()).toHaveLength(writes);
  });

  it('two quick connects to the same page write one relationship (final review m7)', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n', 'B.md': '# B\n' }, extra);
    const results = await Promise.all([relate('A.md', 'B.md'), relate('A.md', 'B.md')]);
    expect(results.map((r) => r.status).sort()).toEqual(['created', 'exists']);
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
  });

  it('a page open in the background is read from its live text (final review m7)', async () => {
    const disk = fakeDisk({ 'A.md': '# A\n', 'B.md': '# B\n', 'C.md': '# C\n' }, extra);
    await act(() => editor().open('A.md'));
    disk.failWrites(1000);
    expect((await relate('A.md', 'B.md')).status).toBe('created');
    // Switched away while its save keeps failing: A stays a live document.
    await act(() => editor().open('C.md'));
    expect(disk.files.get('A.md')).toBe('# A\n');
    expect((await relationsOf('A.md')).map((r) => r.path)).toEqual(['B.md']);
    expect(await relate('A.md', 'B.md')).toEqual({ status: 'exists', index: 0 });
    disk.failWrites(0);
    await act(() => editor().flushAll());
    expect(disk.files.get('A.md')).toBe('---\nrelated:\n  - "[[B]]"\n---\n# A\n');
  });

  it('turning on an arrow keeps the item’s other keys and its number label (final review I1)', async () => {
    const disk = fakeDisk(
      { 'A.md': '---\nrelated:\n  - { link: "[[B]]", label: 2024, kind: parent }\n---\n# A\n' },
      extra,
    );
    const [r] = await relationsOf('A.md');
    expect(r.label).toBe('2024');
    expect(await updateRelation(r, { label: r.label, directed: true })).toBe(true);
    expect(disk.files.get('A.md')).toBe(
      '---\nrelated:\n  - { link: "[[B]]", label: 2024, kind: parent, directed: true }\n---\n# A\n',
    );
    expect(toasts()).toEqual([]);
  });
});
