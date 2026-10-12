import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingKeys } from '../src/i18n/parity.ts';

const dir = fileURLToPath(new URL('../src/i18n/locales', import.meta.url));
const locales = Object.fromEntries(
  readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [basename(file, '.json'), JSON.parse(readFileSync(join(dir, file), 'utf8'))]),
);
const missing = findMissingKeys(locales);
if (missing.length > 0) {
  console.error(`Missing i18n keys:\n${missing.map((m) => `  ${m}`).join('\n')}`);
  process.exit(1);
}
console.log(`i18n OK: ${Object.keys(locales).length} locales in parity.`);
