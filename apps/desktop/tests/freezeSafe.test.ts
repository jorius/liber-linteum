// @vitest-environment node
// tauri.conf.json sets "freezePrototype": true. d3-color (pulled in by React
// Flow's d3-zoom) assigns `prototype.constructor` on a plain object at load,
// which throws once Object.prototype is frozen — the whole UI would fail to
// start (M3a, found by the e2e mock that freezes like Tauri does).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { freezeSafe } from '../scripts/freezeSafe';

// pnpm keeps transitive packages in node_modules/.pnpm (not resolvable from here).
const store = new URL('../../../node_modules/.pnpm/', import.meta.url).pathname;
const d3Color = readdirSync(store).find((d) => d.startsWith('d3-color@'))!;
const DEFINE = join(store, d3Color, 'node_modules/d3-color/src/define.js');

/** Runs d3-color's define() in a fresh realm whose Object.prototype is frozen. */
function runFrozen(source: string): string {
  const body = source
    .replace('export default function', 'function define')
    .replace('export function extend', 'function extend');
  const ctx = vm.createContext({});
  return vm.runInContext(
    `'use strict';
     Object.freeze(Object.prototype);
     ${body}
     function Color() {}
     function color() {}
     define(Color, color, { toString() { return 'colour'; } });
     function Rgb() {}
     define(Rgb, function () {}, extend(Color, { brighter() { return 1; } }));
     [String(new Color()), Rgb.prototype.constructor === Rgb, typeof Rgb.prototype.brighter].join(' ');`,
    ctx,
  ) as string;
}

describe('freeze-safe build transform', () => {
  const original = readFileSync(DEFINE, 'utf8');

  it("d3-color's define() throws under a frozen Object.prototype as published", () => {
    expect(() => runFrozen(original)).toThrow(/read only property 'constructor'/);
  });

  it('the transform makes it work, and changes nothing else', () => {
    const plugin = freezeSafe();
    const out = plugin.transform(original, DEFINE);
    expect(out).not.toBeNull();
    expect(runFrozen(out!)).toBe('colour true function');
    expect(plugin.transform(original, '/elsewhere/define.js')).toBeNull();
    expect(plugin.transform('export const x = 1;', DEFINE)).toBeNull();
  });
});

// M4b part 2 §4: dayjs (pulled in by Mermaid) assigns `valueOf` and
// `toString` on its prototypes — core and the duration plugin — which a
// frozen Object.prototype forbids too.
const dayjsDir = join(
  store,
  readdirSync(store).find((d) => d.startsWith('dayjs@'))!,
  'node_modules/dayjs',
);

/** Runs a dayjs UMD file in a fresh realm with a frozen Object.prototype. */
function dayjsFrozen(core: string, duration: string): string {
  const ctx = vm.createContext({ Date, Math });
  return vm.runInContext(
    `'use strict';
     Object.freeze(Object.prototype);
     var module = { exports: {} }, exports = module.exports;
     (function(){ ${core} }).call({});
     var dayjs = module.exports;
     module = { exports: {} }; exports = module.exports;
     (function(){ ${duration} }).call({});
     dayjs.extend(module.exports);
     var d = dayjs('2026-10-14T00:00:00Z');
     [d.valueOf() === Date.parse('2026-10-14T00:00:00Z'), typeof d.toString(), dayjs.duration(90000).valueOf()].join(' ');`,
    ctx,
  ) as string;
}

describe('freeze-safe transform for dayjs (Mermaid)', () => {
  const core = readFileSync(join(dayjsDir, 'dayjs.min.js'), 'utf8');
  const duration = readFileSync(join(dayjsDir, 'plugin/duration.js'), 'utf8');

  it('dayjs throws under a frozen Object.prototype as published', () => {
    expect(() => dayjsFrozen(core, duration)).toThrow(/read only property '(valueOf|toString)'/);
  });

  it('the transform makes core and plugins work', () => {
    const plugin = freezeSafe();
    const c = plugin.transform(core, join(dayjsDir, 'dayjs.min.js'));
    const d = plugin.transform(duration, join(dayjsDir, 'plugin/duration.js'));
    expect(c).not.toBeNull();
    expect(d).not.toBeNull();
    expect(dayjsFrozen(c!, d!)).toBe('true string 90000');
  });
});

// Mermaid's tree holds a long tail of these (d3-format's FormatSpecifier for
// gantt axes, the vscode-jsonrpc copy inside @mermaid-js/parser, layout-base),
// so the transform rewrites any assignment to a name Object.prototype defines,
// in any node_modules file, from the parsed source.
const d3Format = join(
  store,
  readdirSync(store).find((d) => d.startsWith('d3-format@'))!,
  'node_modules/d3-format/src/formatSpecifier.js',
);

/** Runs `source` (exports stripped) in a fresh realm with a frozen Object.prototype. */
function frozen(source: string, probe: string): unknown {
  const body = source.replace(/export default |export /g, '');
  return vm.runInContext(
    `'use strict'; Object.freeze(Object.prototype);\n${body}\n;${probe}`,
    vm.createContext({}),
  );
}

describe('freeze-safe transform for any package', () => {
  const plugin = freezeSafe();

  it("d3-format's FormatSpecifier throws as published and works once transformed", () => {
    const original = readFileSync(d3Format, 'utf8');
    const probe = "String(formatSpecifier('>10.2f'))";
    expect(() => frozen(original, probe)).toThrow(/read only property 'toString'/);
    const out = plugin.transform(original, d3Format);
    expect(out).not.toBeNull();
    expect(frozen(out!, probe)).toBe(' >-10.2f');
  });

  it('rewrites dotted and quoted keys, nested targets and namespace objects', () => {
    const file = '/x/node_modules/pkg/index.js';
    const src = [
      'var wide = "héllo ✓ 𝒳"; // offsets past non-ASCII text stay right',
      'var Trace = {}; Trace.toString = function () { return "t"; };',
      'function P() {} P.prototype["valueOf"] = function () { return 7; };',
      'var o = {}; function f() { return "o"; } (o.toString = f).valueOf = function () { return 9; };',
      'var s = "a.toString = b"; // c.valueOf = d',
    ].join('\n');
    const out = plugin.transform(src, file)!;
    const probe = '[String(Trace), +new P(), String(o) + +f, s].join(" ")';
    expect(() => frozen(src, probe)).toThrow(/read only property/);
    expect(frozen(out, probe)).toBe('t 7 o9 a.toString = b');
    // Strings and comments are left as they were.
    expect(out).toContain('"a.toString = b"; // c.valueOf = d');
  });

  it('keeps a "use strict" prologue first and plain assignment semantics', () => {
    const file = '/x/node_modules/pkg/strict.cjs';
    const src =
      '"use strict";\nvar a = {}; a.toString = function () { return "a"; };\nObject.keys(a).join();';
    const out = plugin.transform(src, file)!;
    expect(out.startsWith('"use strict";')).toBe(true);
    // Enumerable, like the assignment it replaces; nothing changes unfrozen.
    expect(vm.runInContext(out, vm.createContext({}))).toBe('toString');
    expect(frozen(out, 'Object.keys(a).join() + String(a)')).toBe('toStringa');
  });

  it('makes Object.assign copy those names too (cytoscape mixes them into its classes)', () => {
    const file = '/x/node_modules/cytoscape/dist/cytoscape.esm.mjs';
    const src = [
      'var extend = Object.assign != null ? Object.assign.bind(Object) : null;',
      'function Selector() {} var mixin = { toString: function () { return "sel"; } };',
      'extend(Selector.prototype, mixin);',
      'var copy = Object.assign({}, { valueOf: function () { return 3; } }, null);',
    ].join('\n');
    const probe = 'String(new Selector()) + +copy';
    expect(() => frozen(src, probe)).toThrow(/read only property 'toString'/);
    const out = plugin.transform(src, file)!;
    expect(frozen(out, probe)).toBe('sel3');
    // A polyfill assigning Object.assign itself is left as it is.
    expect(plugin.transform('Object.assign = function () {};', file)).toBeNull();
  });

  it('leaves other files, setters and unparsable sources alone', () => {
    expect(plugin.transform('a.toString = 1;', '/x/src/app.js')).toBeNull();
    expect(plugin.transform('a.other = 1;', '/x/node_modules/p/i.js')).toBeNull();
    expect(plugin.transform('a.toString = = 1;', '/x/node_modules/p/i.js')).toBeNull();
    const out = plugin.transform(
      'var log = []; var base = { set toString(v) { log.push(v); } }; var o = Object.create(base); o.toString = 1;',
      '/x/node_modules/p/setter.js',
    )!;
    expect(
      vm.runInContext(`${out}; log.join() + Object.keys(o).length`, vm.createContext({})),
    ).toBe('10');
  });
});

describe('freeze-safe transform in the dev server (a blank window in `pnpm dev`)', () => {
  const plugin = freezeSafe();
  const src = [
    'function Selector() {} var mixin = { toString: function () { return "sel"; } };',
    'Object.assign(Selector.prototype, mixin);',
    'var copy = Object.assign({}, { valueOf: function () { return 3; } });',
  ].join('\n');
  const probe = 'String(new Selector()) + +copy';

  it('is idempotent: transforming its own output changes nothing (no self-calling helper)', () => {
    const file = '/x/node_modules/p/i.js';
    const once = plugin.transform(src, file)!;
    expect(plugin.transform(once, file)).toBeNull();
    expect(frozen(once, probe)).toBe('sel3');
  });

  it("skips Vite's pre-bundled deps, which the optimizer already transformed", () => {
    const once = plugin.transform(src, '/x/node_modules/p/i.js')!;
    expect(plugin.transform(once, '/x/apps/desktop/node_modules/.vite/deps/react.js')).toBeNull();
    expect(plugin.transform(src, '/x/apps/desktop/node_modules/.vite/deps/chunk-AB12.js')).toBeNull();
  });
});

