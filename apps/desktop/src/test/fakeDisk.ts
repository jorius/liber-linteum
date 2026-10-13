// A fake vault behind mockIPC for editor tests: content hashes, compare-and-swap
// writes with the M2a conflict payload, conflict copies and page creation.
import { mockIPC } from '../ipc/testing';

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

const err = (kind: string, message: string, extra: object = {}) => ({ kind, message, ...extra });

export function fakeDisk(initial: Record<string, string>): FakeDisk {
  const files = new Map(Object.entries(initial));
  const calls: [string, Record<string, unknown>][] = [];
  let failing = 0;
  let gate: Promise<void> | null = null;
  mockIPC(
    async (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, string>;
      calls.push([cmd, args]);
      switch (cmd) {
        case 'page_read': {
          const text = files.get(args.path);
          if (text === undefined) throw err('notFound', args.path);
          return { text, hash: hashOf(text) };
        }
        case 'page_write': {
          if (gate) await gate;
          if (failing > 0) {
            failing--;
            throw err('io', 'disk full');
          }
          const current = files.get(args.path);
          if (current === undefined) throw err('notFound', args.path);
          if (hashOf(current) !== args.expectedHash) {
            throw err('conflict', 'changed', {
              currentText: current,
              currentHash: hashOf(current),
            });
          }
          files.set(args.path, args.text);
          return { hash: hashOf(args.text) };
        }
        case 'page_create_conflict_copy': {
          const stem = args.path.replace(/\.md$/, '');
          let copy = `${stem} (conflict).md`;
          for (let n = 2; files.has(copy); n++) copy = `${stem} (conflict ${n}).md`;
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
        .filter(([c]) => c === 'page_write')
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
