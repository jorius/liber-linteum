import { renderHook, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppVersion } from './useAppVersion';

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useAppVersion', () => {
  it('returns the version from the backend', async () => {
    mockIPC(() => ({ name: 'Liber Linteum', version: '0.1.0' }));
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(result.current).toBe('0.1.0'));
  });

  it('logs IPC failures when running inside Tauri', async () => {
    vi.stubGlobal('isTauri', true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIPC(() => {
      throw new Error('command app_info not allowed');
    });
    const { result } = renderHook(() => useAppVersion());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('stays silent outside Tauri (plain browser)', async () => {
    vi.stubGlobal('isTauri', undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // No IPC mock: invoke rejects because there is no Tauri runtime.
    const { result } = renderHook(() => useAppVersion());
    await new Promise((r) => setTimeout(r, 20));
    expect(error).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
