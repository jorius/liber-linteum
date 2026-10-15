import {
  entryCreatePage,
  entryCreateText,
  pageCreateConflictCopy,
  pageRead,
  pageWrite,
  textRead,
  textWrite,
  type IpcResult,
} from '../../ipc';
import { isTextPath } from '../../stores/textFiles';
import { nameOf, parentOf } from '../../stores/tree';
import { detectEol, fromLf, toLf, type Eol } from './eol';
import { merge3 } from './merge';

/** Autosave delay after the last change (M2a §3.3). */
export const AUTOSAVE_MS = 500;
export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 30_000;

export type SaveStatus = 'saved' | 'saving' | 'retrying';

/** Pages go through `page_*`; text and code files (M4b part 2 §6) through
 *  `text_*`, with the same compare-and-swap and conflict reply. */
const read = (path: string) => (isTextPath(path) ? textRead(path) : pageRead(path));
const write = (path: string, text: string, hash: string) =>
  isTextPath(path) ? textWrite(path, text, hash) : pageWrite(path, text, hash);

export interface PageDocHooks {
  /** Status, path or text changed. */
  onChange: (doc: PageDoc) => void;
  /** Overlapping edits: their version was saved as `copy`. */
  onConflictCopy: (doc: PageDoc, copy: string) => void;
}

/** One open page: the editor text, the last text known to be on disk (the
 *  merge base) and its hash, plus the save loop. Saves, reloads and merges run
 *  one at a time; typing never waits for them. */
export class PageDoc {
  /** Editor text, LF line endings. */
  text: string;
  /** Last text known to be on disk, LF. */
  base: string;
  hash: string;
  eol: Eol;
  /** Deleted on disk while it had unsaved edits (confirmed by the watcher or
   *  a read): kept, not written back until the file is back (rename followed,
   *  restored) or it is saved as a new page. */
  orphaned = false;
  /** Bumped whenever the text changes from outside the editor. */
  revision = 0;
  /** Receives text that changed from outside the editor, synchronously, so a
   *  keystroke can't land between the merge and the editor seeing it. */
  sink: ((text: string) => void) | null = null;

  private writing = false;
  private failing = false;
  private retryDelay = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    public path: string,
    raw: string,
    hash: string,
    private readonly hooks: PageDocHooks,
  ) {
    this.text = this.base = toLf(raw);
    this.hash = hash;
    this.eol = detectEol(raw);
  }

  static async load(path: string, hooks: PageDocHooks): Promise<IpcResult<PageDoc>> {
    const res = await read(path);
    if (!res.ok) return res;
    if (typeof res.value?.text !== 'string' || typeof res.value.hash !== 'string') {
      return {
        ok: false,
        error: { kind: 'io', message: `unexpected page_read reply for ${path}` },
      };
    }
    return { ok: true, value: new PageDoc(path, res.value.text, res.value.hash, hooks) };
  }

  get dirty(): boolean {
    return this.text !== this.base;
  }

  get status(): SaveStatus {
    if (this.failing) return 'retrying';
    return this.writing || this.dirty ? 'saving' : 'saved';
  }

  /** The editor's text changed. */
  edit(text: string): void {
    if (text === this.text) return;
    const wasDirty = this.dirty;
    this.text = text;
    if (!this.orphaned) this.schedule(AUTOSAVE_MS);
    if (wasDirty !== this.dirty) this.hooks.onChange(this);
  }

  /** Saves now (if there is anything to save); resolves when done. */
  flush(): Promise<void> {
    this.cancelTimer();
    return this.enqueue(() => this.save());
  }

  /** The file changed on disk: reload or merge (M2a §3.3). */
  sync(): Promise<void> {
    return this.enqueue(async () => {
      const res = await read(this.path);
      if (res.ok) {
        const wasOrphaned = this.orphaned;
        this.orphaned = false; // it is back (restored, recreated)
        await this.reconcile(res.value.text, res.value.hash);
        if (wasOrphaned) this.resume();
      } else if (res.error.kind === 'notFound') this.markDeleted();
    });
  }

  /** The file was renamed or moved; keeps the text and history. */
  moveTo(path: string): void {
    this.path = path;
    this.orphaned = false; // a write that hit the old path may have orphaned it
    this.resume();
  }

  /** The file is gone. Returns whether there are unsaved edits worth keeping. */
  markDeleted(): boolean {
    if (!this.dirty) return false;
    this.cancelTimer();
    this.orphaned = true;
    this.failing = false;
    this.hooks.onChange(this);
    return true;
  }

  /** Writes an orphaned page's text to a new page next to its old path —
   *  a text file's to a new file of its type (`notes.json`, final review I6). */
  async saveAsNew(): Promise<IpcResult<string>> {
    const dir = parentOf(this.path);
    let created = isTextPath(this.path)
      ? await entryCreateText(dir, nameOf(this.path))
      : await entryCreatePage(dir, nameOf(this.path).replace(/\.md$/i, ''));
    if (!created.ok && created.error.kind === 'alreadyExists') {
      created = await pageCreateConflictCopy(this.path, '');
    }
    if (!created.ok) return created;
    const fresh = await read(created.value);
    if (!fresh.ok) return fresh;
    this.path = created.value;
    this.base = toLf(fresh.value.text);
    this.hash = fresh.value.hash;
    this.orphaned = false;
    await this.flush();
    return created;
  }

  dispose(): void {
    this.cancelTimer();
    this.sink = null;
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job, job);
    return this.queue;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  /** Saves soon if there is anything unsaved (a new path, the file is back). */
  private resume(): void {
    this.retryDelay = 0;
    if (this.dirty) this.schedule(0);
    this.hooks.onChange(this);
  }

  private async save(): Promise<void> {
    if (!this.dirty || this.orphaned) return;
    const text = this.text;
    this.writing = true;
    this.hooks.onChange(this);
    const res = await write(this.path, fromLf(text, this.eol), this.hash);
    this.writing = false;
    if (res.ok) {
      this.base = text;
      this.hash = res.value.hash;
      this.failing = false;
      this.retryDelay = 0;
      if (this.dirty) this.schedule(AUTOSAVE_MS); // typed while saving
    } else if (res.error.kind === 'conflict' && res.error.currentText !== undefined) {
      await this.reconcile(res.error.currentText, res.error.currentHash ?? '');
    } else {
      // NotFound too: the file may only have been renamed or atomically
      // replaced, and the watcher event is still on its way. Only the watcher
      // or a read confirms a deletion (`markDeleted`); until then, retry.
      this.retry();
    }
    this.hooks.onChange(this);
  }

  private retry(): void {
    this.failing = true;
    this.retryDelay = this.retryDelay ? Math.min(this.retryDelay * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
    this.schedule(this.retryDelay);
  }

  /** Brings the disk version (`raw`, `hash`) in: replace when clean, merge
   *  when dirty, conflict copy when the merge fails. */
  private async reconcile(raw: string, hash: string): Promise<void> {
    if (hash === this.hash) return; // our own save, or nothing new
    const theirs = toLf(raw);
    if (raw.includes('\n')) this.eol = detectEol(raw);
    if (!this.dirty) {
      this.base = theirs;
      this.hash = hash;
      this.replace(theirs);
      return;
    }
    const merged = merge3(this.base, this.text, theirs);
    if (merged.clean) {
      this.base = theirs;
      this.hash = hash;
      this.replace(merged.text);
    } else {
      const copy = await pageCreateConflictCopy(this.path, raw);
      if (!copy.ok) {
        this.retry(); // never overwrite their version before it is saved
        return;
      }
      this.base = theirs;
      this.hash = hash;
      this.hooks.onConflictCopy(this, copy.value);
    }
    if (this.dirty) this.schedule(0);
    this.hooks.onChange(this);
  }

  private replace(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.revision++;
    this.sink?.(text);
  }
}
