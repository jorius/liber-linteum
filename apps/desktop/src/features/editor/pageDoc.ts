import {
  entryCreatePage,
  entryCreateText,
  fileWindowName,
  pageCreateConflictCopy,
  pageRead,
  pageWrite,
  textRead,
  textWrite,
  type IpcResult,
} from '../../ipc';
import { useSettingsStore } from '../../stores/settingsStore';
import { isTextPath } from '../../stores/textFiles';
import { nameOf, parentOf } from '../../stores/tree';
import { detectEol, fromLf, toLf, type Eol } from './eol';
import { TEXT_MAX_BYTES } from './limits';
import { merge3 } from './merge';

/** Autosave delay after the last change (M2a §3.3). */
export const AUTOSAVE_MS = 500;
export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/** `notSaved`: kept, but not being saved (see `PageDoc.unwritable`);
 *  `unsaved`: edited, waiting for ⌘S (auto save off, M5b §6). */
export type SaveStatus = 'saved' | 'saving' | 'retrying' | 'notSaved' | 'unsaved';

/** Pages save themselves as you type unless the user turned it off (M5b §6). */
const autoSave = () => useSettingsStore.getState().settings.autoSave !== false;

/** Why a document's text can't be saved to its file (final review I3):
 *  - `disk`: the file was rewritten outside as something the app can't edit
 *    (not UTF-8, a NUL byte, a text file over 2 MB);
 *  - `text`: the text itself can't be saved as a text file (over 2 MB, a NUL
 *    character). */
export type Unwritable = 'disk' | 'text';

/** The backend's refusals of content it can't take as text. */
const notText = (kind: string) => kind === 'notAText' || kind === 'binary';

/** Whether `text` may be written as a text file (M4b part 2 §6). */
const fitsTextFile = (text: string) =>
  !text.includes('\0') && new TextEncoder().encode(text).length <= TEXT_MAX_BYTES;

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
  /** Unsaved text that can no longer be saved to its file (`unwritable`). */
  onUnwritable?: (doc: PageDoc) => void;
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
  /** Can't be saved to its file (final review I3): the text is kept and never
   *  merged with or written over the file; autosave waits until the file is
   *  text again (`disk`), the text fits again (`text`), or it is saved as a
   *  new file. */
  unwritable: Unwritable | null = null;
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
    if (this.unwritable && this.dirty) return 'notSaved';
    if (this.writing) return 'saving';
    if (!this.dirty) return 'saved';
    return autoSave() ? 'saving' : 'unsaved';
  }

  /** The editor's text changed. */
  edit(text: string): void {
    if (text === this.text) return;
    const wasDirty = this.dirty;
    this.text = text;
    const fits = this.unwritable === 'text' && fitsTextFile(fromLf(text, this.eol));
    if (fits) this.unwritable = null;
    if (!this.orphaned && !this.unwritable && autoSave()) this.schedule(AUTOSAVE_MS);
    if (wasDirty !== this.dirty || fits) this.hooks.onChange(this);
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
        const wasHeld = this.orphaned || this.unwritable === 'disk';
        this.orphaned = false; // it is back (restored, recreated)
        if (this.unwritable === 'disk') this.unwritable = null; // text again
        await this.reconcile(res.value.text, res.value.hash);
        if (wasHeld) this.resume();
      } else if (res.error.kind === 'notFound') this.markDeleted();
      else if (notText(res.error.kind)) this.hold('disk');
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
      if (fileWindowName() !== null) {
        // A single-file window writes its own file only: it is back, so the
        // text merges into it (M4c review m3), never into a copy it can't write.
        await this.sync();
        await this.flush();
        return { ok: true, value: this.path };
      }
      created = await pageCreateConflictCopy(this.path, '');
    }
    if (!created.ok) return created;
    const fresh = await read(created.value);
    if (!fresh.ok) return fresh;
    this.path = created.value;
    this.base = toLf(fresh.value.text);
    this.hash = fresh.value.hash;
    this.orphaned = false;
    this.unwritable = null;
    await this.flush();
    return created;
  }

  /** Don't Save (M5b §6): back to the last saved text; nothing is written. */
  revert(): void {
    this.cancelTimer();
    this.replace(this.base);
    this.hooks.onChange(this);
  }

  /** Auto save was turned on or off: unsaved text saves soon, or waits. */
  settle(): void {
    this.cancelTimer();
    if (autoSave() && this.dirty && !this.orphaned && !this.unwritable && !this.failing) {
      this.schedule(AUTOSAVE_MS);
    }
    this.hooks.onChange(this);
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
    if (this.dirty && autoSave()) this.schedule(0);
    this.hooks.onChange(this);
  }

  /** Stops saving and keeps the text (`unwritable`); says so once when there
   *  is unsaved text to keep. */
  private hold(why: Unwritable): void {
    this.cancelTimer();
    this.failing = false;
    this.retryDelay = 0;
    const was = this.unwritable;
    this.unwritable = why;
    if (was !== why && this.dirty) this.hooks.onUnwritable?.(this);
    this.hooks.onChange(this);
  }

  private async save(): Promise<void> {
    if (!this.dirty || this.orphaned || this.unwritable) return;
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
      if (this.dirty && autoSave()) this.schedule(AUTOSAVE_MS); // typed while saving
    } else if (res.error.kind === 'conflict' && res.error.currentText !== undefined) {
      await this.reconcile(res.error.currentText, res.error.currentHash ?? '');
    } else if (notText(res.error.kind)) {
      // Refused: either this text can't be a text file, or what is on disk now
      // isn't text the app can merge with (it never gets a lossy copy).
      const mine = isTextPath(this.path) && !fitsTextFile(fromLf(text, this.eol));
      this.hold(mine ? 'text' : 'disk');
      return;
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
    if (this.dirty && autoSave()) this.schedule(0);
    this.hooks.onChange(this);
  }

  private replace(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.revision++;
    this.sink?.(text);
  }
}
