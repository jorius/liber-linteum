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
