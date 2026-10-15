import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks } from '../../ipc/testing';
import { fakeDisk, hashOf } from '../../test/fakeDisk';
import { AUTOSAVE_MS, PageDoc, type PageDocHooks } from './pageDoc';

const hooks = (): PageDocHooks & { copies: string[] } => {
  const copies: string[] = [];
  return { copies, onChange: () => undefined, onConflictCopy: (_d, copy) => copies.push(copy) };
};

async function load(path: string, h = hooks()) {
  const res = await PageDoc.load(path, h);
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

describe('PageDoc autosave (ED-08, M2a §3.3)', () => {
  it('saves 500 ms after the last change, once, with the latest text', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    doc.edit('one\nt');
    await vi.advanceTimersByTimeAsync(300);
    doc.edit('one\ntwo');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
    expect(disk.writes()).toEqual([]);
    expect(doc.status).toBe('saving');
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.writes()).toEqual([{ path: 'A.md', text: 'one\ntwo' }]);
    expect(doc.status).toBe('saved');
    expect(doc.hash).toBe(hashOf('one\ntwo'));
  });

  it('flush saves immediately and does nothing when clean', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    await doc.flush();
    expect(disk.writes()).toEqual([]);
    doc.edit('two\n');
    await doc.flush();
    expect(disk.files.get('A.md')).toBe('two\n');
  });

  it('retries failed saves with backoff 1 s → 2 s → 4 s and never drops the text', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    disk.failWrites(3);
    doc.edit('two\n');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(doc.status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(999);
    expect(disk.writes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.writes()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(disk.writes()).toHaveLength(3);
    expect(doc.text).toBe('two\n');
    await vi.advanceTimersByTimeAsync(4000);
    expect(disk.writes()).toHaveLength(4);
    expect(doc.status).toBe('saved');
    expect(disk.files.get('A.md')).toBe('two\n');
  });

  it('keeps CRLF files CRLF: the editor sees LF, the disk gets CRLF back', async () => {
    const disk = fakeDisk({ 'W.md': 'one\r\ntwo\r\n' });
    const doc = await load('W.md');
    expect(doc.text).toBe('one\ntwo\n');
    doc.edit('one\nTWO\n');
    await doc.flush();
    expect(disk.files.get('W.md')).toBe('one\r\nTWO\r\n');
  });
});

describe('PageDoc external changes (M2a §3.3)', () => {
  it('reloads a clean page and hands the new text to the editor', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    const seen: string[] = [];
    doc.sink = (t) => seen.push(t);
    disk.files.set('A.md', 'one\nfrom elsewhere\n');
    await doc.sync();
    expect(seen).toEqual(['one\nfrom elsewhere\n']);
    expect(doc.dirty).toBe(false);
    expect(disk.writes()).toEqual([]);
  });

  it('ignores the echo of its own save', async () => {
    fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    const seen: string[] = [];
    doc.sink = (t) => seen.push(t);
    doc.edit('two\n');
    await doc.flush();
    await doc.sync();
    expect(seen).toEqual([]);
  });

  it('merges non-overlapping edits into the editor and saves the result', async () => {
    const disk = fakeDisk({ 'A.md': 'one\ntwo\nthree\nfour\n' });
    const doc = await load('A.md');
    const seen: string[] = [];
    doc.sink = (t) => seen.push(t);
    doc.edit('ONE\ntwo\nthree\nfour\n');
    disk.files.set('A.md', 'one\ntwo\nthree\nFOUR\n');
    await doc.sync();
    expect(seen).toEqual(['ONE\ntwo\nthree\nFOUR\n']);
    await doc.flush();
    expect(disk.files.get('A.md')).toBe('ONE\ntwo\nthree\nFOUR\n');
  });

  it('overlapping edits: keeps mine, saves theirs as a conflict copy, says so', async () => {
    const disk = fakeDisk({ 'A.md': 'one\ntwo\n' });
    const h = hooks();
    const doc = await load('A.md', h);
    doc.edit('one\nMINE\n');
    disk.files.set('A.md', 'one\nTHEIRS\n');
    await doc.sync();
    await doc.flush();
    expect(disk.files.get('A (conflict).md')).toBe('one\nTHEIRS\n');
    expect(disk.files.get('A.md')).toBe('one\nMINE\n');
    expect(h.copies).toEqual(['A (conflict).md']);
  });

  it('a write that hits a changed file takes the same merge path', async () => {
    const disk = fakeDisk({ 'A.md': 'one\ntwo\nthree\nfour\n' });
    const doc = await load('A.md');
    doc.edit('ONE\ntwo\nthree\nfour\n');
    disk.files.set('A.md', 'one\ntwo\nthree\nFOUR\n'); // no watcher event yet
    await doc.flush();
    await doc.flush();
    expect(disk.files.get('A.md')).toBe('ONE\ntwo\nthree\nFOUR\n');
    expect(disk.calls.filter(([c]) => c === 'page_read')).toHaveLength(1); // only the load
  });

  it('deleted while dirty: keeps the text and can save it as a new page', async () => {
    const disk = fakeDisk({ 'notes/A.md': 'one\n' });
    const doc = await load('notes/A.md');
    doc.edit('unsaved\n');
    disk.files.delete('notes/A.md');
    expect(doc.markDeleted()).toBe(true);
    expect(doc.orphaned).toBe(true);
    await doc.flush();
    expect(disk.writes()).toEqual([]);
    const saved = await doc.saveAsNew();
    expect(saved).toEqual({ ok: true, value: 'notes/A.md' });
    expect(disk.files.get('notes/A.md')).toBe('unsaved\n');
    expect(doc.orphaned).toBe(false);
  });

  it('final review I6: a deleted text file is saved as a new text file, not a page', async () => {
    const disk = fakeDisk({ 'conf/notes.json': '{}\n' });
    const doc = await load('conf/notes.json');
    doc.edit('{"unsaved": true}\n');
    disk.files.delete('conf/notes.json');
    expect(doc.markDeleted()).toBe(true);
    const saved = await doc.saveAsNew();
    expect(saved).toEqual({ ok: true, value: 'conf/notes.json' });
    expect(disk.files.get('conf/notes.json')).toBe('{"unsaved": true}\n');
    expect([...disk.files.keys()]).toEqual(['conf/notes.json']);
    expect(disk.calls.map(([c]) => c)).not.toContain('entry_create_page');
    expect(disk.calls.map(([c]) => c)).not.toContain('page_write');
  });

  it('final review I6: when its name is taken again, the copy keeps the type', async () => {
    const disk = fakeDisk({ 'data.csv': 'a,b\n' });
    const doc = await load('data.csv');
    doc.edit('a,b\n1,2\n');
    disk.files.set('data.csv', 'someone else’s\n');
    expect(doc.markDeleted()).toBe(true);
    const saved = await doc.saveAsNew();
    expect(saved).toEqual({ ok: true, value: 'data (conflict).csv' });
    expect(disk.files.get('data (conflict).csv')).toBe('a,b\n1,2\n');
    expect(disk.files.get('data.csv')).toBe('someone else’s\n');
  });

  it('deleted while clean: nothing to keep', async () => {
    fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    expect(doc.markDeleted()).toBe(false);
  });

  it('follows a rename and saves to the new path', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    doc.edit('two\n');
    disk.files.set('B.md', disk.files.get('A.md')!);
    disk.files.delete('A.md');
    doc.moveTo('B.md');
    await doc.flush();
    expect(disk.files.get('B.md')).toBe('two\n');
  });

  it('C2: a write that finds the file missing retries; it is not orphaned yet', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    doc.edit('two\n');
    disk.files.set('B.md', disk.files.get('A.md')!);
    disk.files.delete('A.md'); // renamed outside; the watcher event is still on its way
    await doc.flush();
    expect(doc.orphaned).toBe(false);
    expect(doc.status).toBe('retrying');
    doc.moveTo('B.md'); // the rename event
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.files.get('B.md')).toBe('two\n');
    expect(doc.status).toBe('saved');
  });

  it('C2: following a rename clears orphaned and saves at the new path', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    doc.edit('two\n');
    disk.files.set('B.md', disk.files.get('A.md')!);
    disk.files.delete('A.md');
    expect(doc.markDeleted()).toBe(true);
    doc.moveTo('B.md');
    expect(doc.orphaned).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.files.get('B.md')).toBe('two\n');
    doc.edit('three\n');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(disk.files.get('B.md')).toBe('three\n');
  });

  it('C2: restored after being orphaned: the read clears orphaned and the text saves', async () => {
    const disk = fakeDisk({ 'A.md': 'one\n' });
    const doc = await load('A.md');
    doc.edit('two\n');
    disk.files.delete('A.md');
    await doc.sync(); // the read confirms it is gone
    expect(doc.orphaned).toBe(true);
    disk.files.set('A.md', 'one\n'); // restored from the Trash
    await doc.sync();
    expect(doc.orphaned).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.files.get('A.md')).toBe('two\n');
    expect(doc.status).toBe('saved');
  });
});
