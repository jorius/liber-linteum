// A fake vault behind mockIPC for editor tests: content hashes, compare-and-swap
// writes with the M2a conflict payload, conflict copies, page creation and
// header data. `extra` overrides or adds commands per test.
import { mockIPC } from '../ipc/testing';
import { parsePage } from '../markdown/parse';
import { isTextPath } from '../stores/textFiles';

export const hashOf = (text: string) => `h:${text}`;

export interface FakeDisk {
  files: Map<string, string>;
  calls: [string, Record<string, unknown>][];
  writes: () => { path: string; text: string }[];
  /** Makes the next `n` writes fail with an io error. */
  failWrites: (n: number) => void;
  /** Holds writes until the returned function is called. */
  holdWrites: () => () => void;
}

type Extra = Record<string, (args: Record<string, unknown>) => unknown>;

const err = (kind: string, message: string, extra: object = {}) => ({ kind, message, ...extra });

/** What the backend can read as text: a NUL byte stands for bytes that aren't
 *  UTF-8 (Windows-1252 from Excel); a text file (M4b part 2 §6) is also at
 *  most 2 MB. Anything else is `notAText` (text files) or `binary` (pages),
 *  and a refused write's conflict reply carries no text (final review I3). */
const readable = (cmd: string, text: string) =>
  !text.includes('\0') &&
  (!cmd.startsWith('text_') || new TextEncoder().encode(text).length <= 2 * 1024 * 1024);
const unreadable = (cmd: string, path: string) =>
  err(cmd.startsWith('text_') ? 'notAText' : 'binary', path);

/** First `# Heading`, else the file name (enough for header tests). */
const titleOf = (path: string, text: string) =>
  /^# (.+)$/m.exec(text)?.[1] ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');

/** `#tag`s in the text, like the index's (enough for tests: no code or
 *  front matter awareness). */
function tagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1]))];
}

/** Header fields from the note's frontmatter, as the index reads them. */
function headerOf(text: string) {
  const data = parsePage(text).frontmatter?.data ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const y = data['cover-y'];
  return {
    subtitle: str(data.subtitle),
    cover: str(data.cover),
    coverY: typeof y === 'number' ? Math.min(100, Math.max(0, Math.round(y))) : null,
  };
}

export function fakeDisk(initial: Record<string, string>, extra: Extra = {}): FakeDisk {
  const files = new Map(Object.entries(initial));
  const calls: [string, Record<string, unknown>][] = [];
  let failing = 0;
  let gate: Promise<void> | null = null;
  mockIPC(
    async (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, string>;
      calls.push([cmd, args]);
      if (extra[cmd]) return extra[cmd](args);
      switch (cmd) {
        case 'page_read':
        case 'text_read': {
          const text = files.get(args.path);
          if (text === undefined) throw err('notFound', args.path);
          if (!readable(cmd, text)) throw unreadable(cmd, args.path);
          return { text, hash: hashOf(text) };
        }
        case 'page_write':
        case 'text_write': {
          if (gate) await gate;
          if (failing > 0) {
            failing--;
            throw err('io', 'disk full');
          }
          // Text that would no longer be an eligible text file isn't written.
          if (cmd === 'text_write' && !readable(cmd, args.text)) throw unreadable(cmd, args.path);
          const current = files.get(args.path);
          if (current === undefined) throw err('notFound', args.path);
          if (hashOf(current) !== args.expectedHash) {
            if (!readable(cmd, current)) throw unreadable(cmd, args.path);
            throw err('conflict', 'changed', {
              currentText: current,
              currentHash: hashOf(current),
            });
          }
          files.set(args.path, args.text);
          return { hash: hashOf(args.text) };
        }
        case 'page_create_conflict_copy': {
          // A text file's copy keeps its extension (final review I6).
          const text = isTextPath(args.path);
          const dot = args.path.lastIndexOf('.');
          const hasExt = dot > args.path.lastIndexOf('/') + 1;
          const stem = text
            ? hasExt
              ? args.path.slice(0, dot)
              : args.path
            : args.path.replace(/\.md$/, '');
          const ext = text ? (hasExt ? args.path.slice(dot) : '') : '.md';
          let copy = `${stem} (conflict)${ext}`;
          for (let n = 2; files.has(copy); n++) copy = `${stem} (conflict ${n})${ext}`;
          files.set(copy, args.text);
          return copy;
        }
        case 'entry_create_page': {
          const name = args.name.endsWith('.md') ? args.name : `${args.name}.md`;
          const path = args.dir ? `${args.dir}/${name}` : name;
          if (files.has(path)) throw err('alreadyExists', path);
          files.set(path, '');
          return path;
        }
        case 'entry_create_text': {
          const path = args.dir ? `${args.dir}/${args.name}` : args.name;
          if (!isTextPath(path)) throw err('notAText', path);
          if (files.has(path)) throw err('alreadyExists', path);
          files.set(path, '');
          return path;
        }
        case 'page_get': {
          const text = files.get(args.path);
          if (text === undefined) throw err('notFound', args.path);
          return {
            path: args.path,
            title: titleOf(args.path, text),
            ...headerOf(text),
            tags: tagsOf(text),
            links: 0,
            backlinks: 0,
            text,
            truncated: false,
            binary: !readable(cmd, text),
          };
        }
        case 'entry_rename': {
          const text = files.get(args.from);
          if (text === undefined) throw err('notFound', args.from);
          // Case-insensitive like macOS/Windows; a case-only rename is fine.
          const lower = args.to.toLowerCase();
          if ([...files.keys()].some((k) => k.toLowerCase() === lower && k !== args.from)) {
            throw err('alreadyExists', args.to);
          }
          files.delete(args.from);
          files.set(args.to, text);
          return { moved: [[args.from, args.to]], updatedFiles: [], updatedLinks: 0, failed: [] };
        }
        case 'vault_tree':
          return [...files.keys()].map((path) => ({
            path,
            kind: /\.md$/i.test(path) ? 'page' : 'attachment',
          }));
        case 'links_resolve':
          // A wiki target names a page on the disk by its name (enough for
          // embeds in tests); anything else resolves to nothing.
          return (raw as { targets: { kind: string; target: string }[] }).targets.map(
            ({ kind, target }) => {
              if (kind !== 'wiki' && kind !== 'embed') return null;
              const name = `${target.replace(/#.*$/, '')}.md`.toLowerCase();
              return (
                [...files.keys()].find((f) => f.split('/').pop()!.toLowerCase() === name) ?? null
              );
            },
          );
        case 'settings_set':
          return { version: 1, ...(raw as { patch: object }).patch };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  return {
    files,
    calls,
    writes: () =>
      calls
        .filter(([c]) => c === 'page_write' || c === 'text_write')
        .map(([, a]) => ({ path: a.path as string, text: a.text as string })),
    failWrites: (n) => {
      failing = n;
    },
    holdWrites: () => {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}
