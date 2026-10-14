// @vitest-environment node
// `pnpm dev` / `tauri dev` serve React Flow from Vite's dependency
// pre-bundle (node_modules/.vite/deps), which Rolldown builds without the
// app's own plugin `transform` hooks. Tauri freezes Object.prototype in dev
// too, so an unpatched d3-color in that bundle left a blank window (M3a final
// review C1). This runs the real optimizer with the app's config and checks
// the bundle it writes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeDeps, resolveConfig } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const cacheDir = mkdtempSync(join(tmpdir(), 'nimw-prebundle-'));

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe('dev dependency pre-bundle (freezePrototype)', () => {
  it("patches d3-color inside @xyflow/react's pre-bundle and its chunks", async () => {
    const config = await resolveConfig(
      {
        root,
        configFile: join(root, 'vite.config.ts'),
        cacheDir,
        logLevel: 'silent',
        optimizeDeps: { include: ['@xyflow/react'], noDiscovery: true },
      },
      'serve',
      'development',
    );
    const meta = await optimizeDeps(config, true);
    expect(meta.optimized['@xyflow/react']?.file).toBeDefined();
    // Since mermaid joined the deps, d3 sits in a chunk the two bundles share.
    const code = [meta.optimized['@xyflow/react']!, ...Object.values(meta.chunks)]
      .map((d) => readFileSync(d.file, 'utf8'))
      .join('\n');
    // Booleans, not the bundle: a failure shouldn't print 10k lines.
    expect(code.includes('d3-color'), 'd3-color is in the bundle').toBe(true);
    expect(code.includes('prototype.constructor = constructor;'), 'unpatched assignment').toBe(
      false,
    );
    expect(/__nimwOwn(\$\d+)?\(prototype,\s*"constructor"\)/.test(code), 'patched').toBe(true);
  }, 60_000);

  it("patches dayjs inside mermaid's pre-bundle (M4b part 2 §4)", async () => {
    const config = await resolveConfig(
      {
        root,
        configFile: join(root, 'vite.config.ts'),
        cacheDir: join(cacheDir, 'mermaid'),
        logLevel: 'silent',
        optimizeDeps: { include: ['mermaid'], noDiscovery: true },
      },
      'serve',
      'development',
    );
    const meta = await optimizeDeps(config, true);
    const files = [...Object.values(meta.optimized), ...Object.values(meta.chunks)].map((d) =>
      readFileSync(d.file, 'utf8'),
    );
    const all = files.join('\n');
    expect(all.includes('$d.getTime()'), 'dayjs is in the bundle').toBe(true);
    expect(all.includes('__nimwOwn'), 'patched').toBe(true);
    // Every dayjs `valueOf`/`toString` assignment goes through the helper.
    expect(
      /[\w$]\.valueOf=function\(\)\{return this\.\$d\.getTime\(\)\}/.test(all),
      'unpatched',
    ).toBe(false);
  }, 120_000);
});
