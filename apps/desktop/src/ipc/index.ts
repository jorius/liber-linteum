// The only module allowed to talk to the Rust backend. Every backend
// capability the UI uses is a typed function here.
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface AppInfo {
  name: string;
  version: string;
}

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>('app_info');
}

// True when running inside the Tauri webview (false in a plain browser).
export { isTauri };
