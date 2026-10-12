// @vitest-environment node
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleIds(code: string, filePath = 'src/features/example.ts') {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => m.ruleId);
}

describe('NFR-04 network ban (lint layer)', () => {
  it.each([
    "fetch('https://example.com');",
    'new WebSocket("wss://example.com");',
    'new XMLHttpRequest();',
    'new EventSource("/stream");',
  ])('rejects global %s', async (code) => {
    expect(await ruleIds(`export {}; ${code}`)).toContain('no-restricted-globals');
  });

  it.each([
    "window.fetch('https://example.com');",
    "globalThis.fetch('https://example.com');",
    'new self.WebSocket("wss://example.com");',
    "navigator.sendBeacon('https://example.com', '');",
  ])('rejects indirect %s', async (code) => {
    expect(await ruleIds(`export {}; ${code}`)).toContain('no-restricted-properties');
  });

  it('rejects @tauri-apps/api/core outside src/ipc', async () => {
    const code = "import { invoke } from '@tauri-apps/api/core'; export const x = invoke;";
    expect(await ruleIds(code)).toContain('no-restricted-imports');
  });

  it('allows @tauri-apps/api/core inside src/ipc', async () => {
    const code = "import { invoke } from '@tauri-apps/api/core'; export const x = invoke;";
    expect(await ruleIds(code, 'src/ipc/example.ts')).not.toContain('no-restricted-imports');
  });
});
