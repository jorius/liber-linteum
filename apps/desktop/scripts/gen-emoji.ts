// Writes src/features/icons/emoji.json, the icon picker's offline emoji list
// (M5b §4), from Unicode data fetched once by hand into a folder:
//   emoji-test.txt   https://unicode.org/Public/emoji/latest/emoji-test.txt
//   ann-en.json, ann-es.json, der-en.json, der-es.json   CLDR annotations and
//   annotationsDerived (cldr-json, cldr-annotations{,-derived}-full)
// Run: `node scripts/gen-emoji.ts <folder>`. Unicode License v3 (see
// THIRD-PARTY-NOTICES.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Newest Emoji version kept: older systems (Windows 10) draw boxes for
 *  later ones. */
const MAX_VERSION = 13.1;
const KEYWORDS = 4;

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/gen-emoji.ts <folder with the Unicode files>');

type Ann = Record<string, { default?: string[]; tts?: string[] }>;
const ann = (lang: string): Ann => {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return {
    ...read(`der-${lang}.json`).annotationsDerived.annotations,
    ...read(`ann-${lang}.json`).annotations.annotations,
  };
};
const langs = { en: ann('en'), es: ann('es') };
const look = (a: Ann, e: string) => a[e] ?? a[e.replace(/️/g, '')];

const groups: { id: string; items: string[][] }[] = [];
let group: { id: string; items: string[][] } | null = null;
let missing = 0;
for (const line of readFileSync(join(dir, 'emoji-test.txt'), 'utf8').split('\n')) {
  const g = /^# group: (.+)$/.exec(line);
  if (g) {
    const id = g[1].toLowerCase().replace(/ & /g, '-').replace(/\s+/g, '-');
    group = id === 'component' ? null : { id, items: [] };
    if (group) groups.push(group);
    continue;
  }
  const m = /^([0-9A-F ]+?)\s*; fully-qualified\s*# (\S+) E(\d+\.\d+) /.exec(line);
  if (!m || !group || Number(m[3]) > MAX_VERSION) continue;
  const cps = m[1].split(' ').map((h) => parseInt(h, 16));
  if (cps.some((c) => c >= 0x1f3fb && c <= 0x1f3ff)) continue; // skin tones: out of scope
  const e = String.fromCodePoint(...cps);
  const en = look(langs.en, e);
  const es = look(langs.es, e);
  if (!en?.tts) {
    missing++;
    continue;
  }
  const name = (a: typeof en | undefined) => a?.tts?.[0] ?? '';
  const words = new Set(
    [...(en.default ?? []).slice(0, KEYWORDS), ...(es?.default ?? []).slice(0, KEYWORDS)].map((w) =>
      w.toLowerCase(),
    ),
  );
  group.items.push([e, name(en), name(es) || name(en), [...words].join(' ')]);
}

const out = new URL('../src/features/icons/emoji.json', import.meta.url);
writeFileSync(out, JSON.stringify(groups));
const count = groups.reduce((n, g) => n + g.items.length, 0);
console.log(
  `wrote ${out.pathname}: ${count} emoji in ${groups.length} groups (${missing} without a name skipped)`,
);
