import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { appInfo } from './index';

afterEach(() => clearMocks());

describe('ipc.appInfo', () => {
  it('invokes app_info and returns the typed payload', async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      if (cmd === 'app_info') return { name: 'Liber Linteum', version: '0.1.0' };
    });
    await expect(appInfo()).resolves.toEqual({ name: 'Liber Linteum', version: '0.1.0' });
    expect(calls).toEqual(['app_info']);
  });
});
