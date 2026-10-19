// A Vite transform that keeps third-party code working under Tauri's
// "freezePrototype": true (M3a). With Object.prototype frozen, assigning a
// property whose nearest definition is Object.prototype's (here
// `constructor`) throws in strict mode. d3-color (React Flow → d3-zoom →
// d3-interpolate) does exactly that while loading, so the UI would not start.
// The assignment becomes a property definition, which a frozen prototype
// allows. Matched by file path and exact source text: anything unexpected
// is left alone (and the e2e mock, which freezes like Tauri, would catch it).

const D3_COLOR_DEFINE = /[\\/]d3-color[\\/]src[\\/]define\.js$/;
const ASSIGN = 'prototype.constructor = constructor;';
const DEFINE =
  'Object.defineProperty(prototype, "constructor", { value: constructor, writable: true, configurable: true });';

export function freezeSafe() {
  return {
    name: 'nimw-freeze-safe',
    enforce: 'pre' as const,
    transform(code: string, id: string): string | null {
      if (!D3_COLOR_DEFINE.test(id.split('?')[0]) || !code.includes(ASSIGN)) return null;
      return code.replace(ASSIGN, DEFINE);
    },
  };
}
