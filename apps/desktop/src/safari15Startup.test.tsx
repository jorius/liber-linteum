// The app starts on WKWebView 15.0–15.3 (macOS 12.0–12.2), which lacks what
// Safari 15.4 added (final review C1). jsCompat.test.ts reads only the app's
// own TypeScript; this loads the app's module graph — its dependencies
// included — as if those APIs were missing, so a library that calls one at
// load time (lowlight's `createLowlight(common)` did, through
// `Object.hasOwn`) fails here instead of leaving a blank window.
//
// The test runner itself (Vite's module runner, Vitest, jsdom) uses these
// APIs while it loads modules, so they can't simply be deleted: each one is
// replaced by a stand-in that throws, as Safari 15.0 would ("… is not a
// function"), when the app or one of its libraries calls it, and answers as
// usual for the test tooling.
import type { Element, Root } from 'hast';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What Safari 15.0 lacks, and where it lives. */
const MISSING: [object, string, string][] = [
  [Object, 'hasOwn', 'Object.hasOwn'],
  [globalThis, 'structuredClone', 'structuredClone'],
  [Array.prototype, 'at', 'Array.prototype.at'],
  [String.prototype, 'at', 'String.prototype.at'],
  [Array.prototype, 'findLast', 'Array.prototype.findLast'],
  [Array.prototype, 'findLastIndex', 'Array.prototype.findLastIndex'],
];

/** The test runner and Node, which load modules (never in the app's bundle). */
const RUNNER =
  /\/node_modules\/(?:vite|vitest|@vitest\/[^/]+|tinyspy|chai|@testing-library\/[^/]+)\/|\(node:|at node:/;
/** jsdom stands in for WebKit's own DOM code, libraries included. */
const DOM = /\/node_modules\/jsdom\//;
const LIBRARY = /\/node_modules\//;

/** The frames below the stand-in, its caller first. */
function callers(): string[] {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  // "Error", `callers`, the stand-in, then its caller.
  return stack.split('\n').slice(3);
}

/** Whether the test tooling made the call, not the app or a library it
 *  bundles. A library called by jsdom is jsdom's; one whose module is being
 *  loaded (the runner below it) or called by app code is the app's. */
function fromTooling(frames: string[]): boolean {
  const [caller = ''] = frames;
  if (RUNNER.test(caller) || DOM.test(caller)) return true;
  for (const frame of frames) {
    if (DOM.test(frame)) return true;
    if (!LIBRARY.test(frame) || RUNNER.test(frame)) return false;
  }
  return false;
}

const saved = MISSING.map(([owner, name]) => Object.getOwnPropertyDescriptor(owner, name)!);
/** Calls the app made to a missing API (what Safari 15.0 would throw on). */
let calls: string[] = [];

function simulateSafari15() {
  calls = [];
  MISSING.forEach(([owner, name, label], i) => {
    const real = saved[i].value as (...args: unknown[]) => unknown;
    const standIn = function (this: unknown, ...args: unknown[]) {
      const frames = callers();
      if (fromTooling(frames)) return real.apply(this, args);
      calls.push(`${label}: ${frames[0]?.trim()}`);
      throw new TypeError(`${label} is not a function (Safari 15.0–15.3)`);
    };
    Object.defineProperty(owner, name, { ...saved[i], value: standIn });
  });
}

function restore() {
  MISSING.forEach(([owner, name], i) => Object.defineProperty(owner, name, saved[i]));
}

/** Imports `load()`'s modules afresh as Safari 15.0 would run them. */
async function onSafari15<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  simulateSafari15();
  try {
    return await load();
  } finally {
    restore();
  }
}

const codeBlock = (lang: string, code: string): Root => ({
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'pre',
      properties: {},
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: [`language-${lang}`] },
          children: [{ type: 'text', value: code }],
        },
      ],
    },
  ],
});

const classesIn = (node: Root | Element): string[] =>
  node.children.flatMap((c) =>
    c.type === 'element'
      ? [...([] as unknown[]).concat(c.properties.className ?? []).map(String), ...classesIn(c)]
      : [],
  );

describe('startup on Safari 15.0–15.3 (final review C1)', () => {
  afterEach(restore);

  it('the stand-ins throw for app code, as Safari 15.0 does', () => {
    simulateSafari15();
    try {
      expect(() => Object.hasOwn({ a: 1 }, 'a')).toThrow(TypeError);
      expect(() => [1, 2].at(-1)).toThrow(TypeError);
    } finally {
      restore();
    }
    expect(Object.hasOwn({ a: 1 }, 'a')).toBe(true);
  });

  it('code highlighting loads and still highlights', async () => {
    const { highlightCode } = await onSafari15(() => import('./markdown/codeHighlight'));
    const tree = codeBlock('js', 'const x = 42;');
    simulateSafari15();
    try {
      highlightCode(tree);
    } finally {
      restore();
    }
    expect(calls).toEqual([]);
    expect(classesIn(tree)).toEqual(expect.arrayContaining(['hljs-keyword', 'hljs-number']));
  });

  it("the app's module graph loads (main.tsx's imports)", async () => {
    const loaded = await onSafari15(() =>
      Promise.all([
        import('./app/App'),
        import('./i18n'),
        import('./features/editor/attachments'),
        import('./features/global-view/seeAtomsMenu'),
        import('./stores/editorStore'),
        import('./stores/menuToggles'),
        import('./stores/navigate'),
        import('./stores/settingsStore'),
        import('./theme/theme'),
      ]),
    );
    expect(calls).toEqual([]);
    expect(typeof loaded[0].App).toBe('function');
  });
});
