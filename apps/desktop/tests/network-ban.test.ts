// @vitest-environment node
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd });

async function lint(code: string, filePath = 'src/features/example.ts') {
  const [result] = await eslint.lintText(code, { filePath });
  return result;
}

async function ruleIds(code: string, filePath?: string) {
  return (await lint(code, filePath)).messages.map((m) => m.ruleId);
}

const TAURI_CORE = "import { invoke } from '@tauri-apps/api/core'; export const x = invoke;";

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
    "globalThis['fetch']('x');",
    "window['WebSocket'];",
    "navigator['sendBeacon']('x', '');",
    "window.navigator.sendBeacon('x', '');",
    "globalThis.navigator.sendBeacon('x', '');",
    "window['navigator']['sendBeacon']('x', '');",
    'const { fetch: f } = window;',
    'const { WebSocket: W } = globalThis;',
    'const { sendBeacon } = navigator;',
  ])('rejects indirect %s', async (code) => {
    expect(await ruleIds(`export {}; ${code}`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^no-restricted-(properties|syntax)$/)]),
    );
  });

  it('rejects @tauri-apps/api/core outside src/ipc', async () => {
    expect(await ruleIds(TAURI_CORE)).toContain('no-restricted-imports');
  });

  it.each([
    "import { getCurrentWindow } from '@tauri-apps/api';",
    "import { listen } from '@tauri-apps/api/event';",
    "import { fetch } from '@tauri-apps/plugin-http';",
  ])('rejects backend import outside src/ipc: %s', async (code) => {
    expect(await ruleIds(`${code} export const x = 1;`)).toContain('no-restricted-imports');
  });

  it('rejects @tauri-apps/api/mocks in non-test source', async () => {
    const code = "import { mockIPC } from '@tauri-apps/api/mocks'; export const x = mockIPC;";
    expect(await ruleIds(code, 'src/app/x.ts')).toContain('no-restricted-imports');
  });

  it('allows @tauri-apps/api/mocks in test files', async () => {
    const code = "import { mockIPC } from '@tauri-apps/api/mocks'; export const x = mockIPC;";
    expect(await ruleIds(code, 'src/app/x.test.ts')).not.toContain('no-restricted-imports');
  });

  it('allows @tauri-apps/api/core inside src/ipc', async () => {
    const result = await lint(TAURI_CORE, 'src/ipc/example.ts');
    expect(result.messages.map((m) => m.ruleId)).not.toContain('no-restricted-imports');
    expect(result.messages).toEqual([]);
    expect(result.errorCount).toBe(0);
  });
});
