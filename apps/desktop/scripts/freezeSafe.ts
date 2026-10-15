// A Vite transform that keeps third-party code working under Tauri's
// "freezePrototype": true (M3a). With Object.prototype frozen, its own
// properties are read-only, so assigning one of those names (`constructor`,
// `toString`, `valueOf`, …) to an object that only inherits it throws in
// strict mode. d3-color (React Flow → d3-zoom) does that while loading, and
// Mermaid's tree has a long tail of the same (dayjs, d3-format, the
// vscode-jsonrpc copy in @mermaid-js/parser, layout-base, cytoscape's
// Object.assign mixins — M4b part 2 §4).
//
// In node_modules files:
// - `obj.name = value` (or `obj["name"] = value`) becomes
//   `__nimwOwn(obj, "name").name = value`. The helper gives `obj` its own
//   writable, enumerable property first — what the assignment would have
//   created — but only when the name it inherits is a read-only data
//   property; otherwise (setters, own properties, an unfrozen realm) nothing
//   changes.
// - `Object.assign` becomes `__nimwAssign`, which does the same for those
//   names in the sources before calling Object.assign.
// Assignments with computed keys (`obj[key] = value`) are not covered: the
// e2e draws every kind of Mermaid diagram under a frozen prototype to show
// none is needed. The source is parsed, so strings and comments are never
// touched; a file that doesn't parse is left alone.
import { parseSync, Visitor } from 'vite';

const NODE_MODULES = /[\\/]node_modules[\\/].+\.[cm]?js$/;
const NAMES = [
  'constructor',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
];
// A cheap first look, so only files that might need it are parsed.
const HINT = new RegExp(
  `(?:\\.\\s*|\\[\\s*["'])(?:${NAMES.join('|')})["']?\\s*\\]?\\s*=(?![=>])|\\bObject\\.assign\\b`,
);
const HELPERS =
  'var __nimwOwn=function(o,k){if(o!=null&&(typeof o==="object"||typeof o==="function")&&!Object.prototype.hasOwnProperty.call(o,k)){for(var p=Object.getPrototypeOf(o);p;p=Object.getPrototypeOf(p)){var d=Object.getOwnPropertyDescriptor(p,k);if(d){if("value" in d&&!d.writable&&Object.isExtensible(o))Object.defineProperty(o,k,{value:void 0,writable:true,enumerable:true,configurable:true});break}}}return o};\n' +
  `var __nimwAssign=function(t){for(var i=1;i<arguments.length;i++){var s=arguments[i];if(s!=null)for(var n=${JSON.stringify(NAMES)},j=0;j<n.length;j++)if(Object.prototype.propertyIsEnumerable.call(s,n[j]))__nimwOwn(t,n[j])}return Object.assign.apply(Object,arguments)};\n`;

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function keyOf(member: Node): string | null {
  const property = member.property as Node & { name?: string; value?: unknown };
  if (!member.computed) return property.type === 'Identifier' ? property.name! : null;
  return property.type === 'Literal' && typeof property.value === 'string' ? property.value : null;
}

/** Vite's pre-bundled deps (`node_modules/.vite/deps/…`) were already made
 *  freeze-safe by the optimizer; the dev server serves them through this
 *  plugin again. */
const PREBUNDLED = /[\\/]node_modules[\\/]\.vite[\\/]/;

/** The freeze-safe source of a node_modules file, or null when nothing changes.
 *  Idempotent: code that already carries the helpers is left alone, so the
 *  helper's own `Object.assign` is never turned into a call to itself (which
 *  overflowed the stack and left `pnpm dev` with a blank window). */
export function freezeSafeSource(code: string, file: string): string | null {
  if (!NODE_MODULES.test(file) || PREBUNDLED.test(file) || !HINT.test(code)) return null;
  if (code.includes('var __nimwAssign=function(') || code.includes('var __nimwAssign = function('))
    return null;
  const { program, errors } = parseSync(file, code, { sourceType: 'unambiguous' });
  if (errors.length > 0) return null;
  // Each edit replaces [start, end) (empty for an insertion). Targets can
  // nest (`(a.toString = f).valueOf = g`), so at one position an outer
  // target opens before an inner one and an inner one closes first (`order`).
  const edits: { start: number; end: number; text: string; order: number }[] = [];
  const assigned = new Set<number>();
  const assignReads: Node[] = [];
  new Visitor({
    MemberExpression(node) {
      const member = node as unknown as Node;
      const object = member.object as Node & { name?: string };
      if (object.type === 'Identifier' && object.name === 'Object' && keyOf(member) === 'assign')
        assignReads.push(member);
    },
    AssignmentExpression(node) {
      const left = node.left as unknown as Node;
      assigned.add(left.start);
      if (left.type !== 'MemberExpression') return;
      const target = left.object as Node;
      const key = keyOf(left);
      if (target.type === 'Super' || key === null || !NAMES.includes(key)) return;
      const size = target.end - target.start;
      const at = (pos: number, text: string, order: number) =>
        edits.push({ start: pos, end: pos, text, order });
      at(target.start, '__nimwOwn(', -size);
      at(target.end, `,${JSON.stringify(key)})`, -1e9 + size);
    },
  }).visit(program);
  // `Object.assign` wherever it's read (a call, `.bind(Object)`, a `!= null`
  // check), never where it is itself assigned (a polyfill).
  for (const m of assignReads) {
    if (!assigned.has(m.start))
      edits.push({ start: m.start, end: m.end, text: '__nimwAssign', order: 0 });
  }
  if (edits.length === 0) return null;
  // The helpers go after a hashbang and any directive prologue ("use strict"
  // must stay first to keep its meaning).
  let head = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;
  for (const statement of program.body as unknown as Node[]) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') break;
    head = statement.end;
  }
  edits.push({ start: head, end: head, text: (head > 0 ? '\n' : '') + HELPERS, order: -Infinity });
  edits.sort((a, b) => a.start - b.start || a.order - b.order);
  let out = '';
  let from = 0;
  for (const { start, end, text } of edits) {
    out += code.slice(from, start) + text;
    from = end;
  }
  return out + code.slice(from);
}

export function freezeSafe() {
  return {
    name: 'nimw-freeze-safe',
    enforce: 'pre' as const,
    transform(code: string, id: string): string | null {
      return freezeSafeSource(code, id.split('?')[0]);
    },
  };
}
