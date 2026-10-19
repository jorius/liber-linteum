// @vitest-environment node
// The stores layer is below the features: a feature that must react to the
// vault (the Global View starting over, saving its card positions first)
// subscribes to the stores, never the other way round (M3a final review m15).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const dir = fileURLToPath(new URL('./', import.meta.url));

it('no store imports the Global View feature', () => {
  const offenders = readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => readFileSync(dir + f, 'utf8').includes("from '../features/global-view/"));
  expect(offenders).toEqual([]);
});
