// The only module allowed to talk to the Rust backend. Every backend
// capability the UI uses is a typed function here (M1b spec §3.2).
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

export interface AppInfo {
  name: string;
  version: string;
}

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>('app_info');
}

// True when running inside the Tauri webview (false in a plain browser).
export { isTauri };

// ---- errors ----

export type ErrorKind =
  | 'noVault'
  | 'notFound'
  | 'alreadyExists'
  | 'notEmpty'
  | 'invalidName'
  | 'conflict'
  | 'outsideVault'
  | 'unsafeRewrite'
  | 'watch'
  | 'io';

export interface CommandError {
  kind: ErrorKind;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: CommandError };

/** Normalizes anything a rejected IPC call can produce. */
export function toCommandError(e: unknown): CommandError {
  if (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as CommandError).kind === 'string' &&
    typeof (e as CommandError).message === 'string'
  ) {
    return { kind: (e as CommandError).kind, message: (e as CommandError).message };
  }
  if (typeof e === 'string') return { kind: 'io', message: e };
  if (e instanceof Error) return { kind: 'io', message: e.message };
  return { kind: 'io', message: String(e) };
}

/** Runs an IPC call; callers never see a thrown error. */
export async function ipcCall<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: toCommandError(e) };
  }
}

// ---- payloads (mirror src-tauri/src/dto.rs and settings.rs) ----

export interface IndexReport {
  files: number;
  pages: number;
  parsed: number;
  skippedUnchanged: number;
  removed: number;
  warnings: string[];
  durationMs: number;
}

export interface VaultInfo {
  name: string;
  root: string;
  report: IndexReport;
}

export type NodeKind = 'page' | 'folder' | 'attachment';

export interface TreeNode {
  path: string;
  kind: NodeKind;
}

export interface Page {
  path: string;
  title: string;
  subtitle: string | null;
  cover: string | null;
  tags: string[];
  links: number;
  backlinks: number;
  text: string;
  truncated: boolean;
  binary: boolean;
}

export interface RenameOutcome {
  moved: [string, string][];
  updatedFiles: string[];
  updatedLinks: number;
  failed: [string, string][];
}

export type Theme = 'system' | 'light' | 'dark';

export interface RecentVault {
  path: string;
  name: string;
  openedAt: string;
  missing: boolean;
}

export interface Settings {
  version: number;
  /** `null` = follow the OS. */
  language: string | null;
  theme: Theme;
  rewriteLinks: boolean;
  confirmDelete: boolean;
}

/** `language: 'system'` means follow the OS again. */
export interface SettingsPatch {
  language?: string;
  theme?: Theme;
  rewriteLinks?: boolean;
  confirmDelete?: boolean;
}

export interface SettingsResponse {
  settings: Settings;
  warning?: string;
}

export interface ProgressPayload {
  done: number;
  total: number;
}

export interface ChangedPayload {
  created: string[];
  modified: string[];
  removed: string[];
  renamed: [string, string][];
}

export interface WarningPayload {
  message: string;
}

// ---- commands ----

const call = <T>(cmd: string, args?: Record<string, unknown>) =>
  ipcCall(() => invoke<T>(cmd, args));

export const vaultOpen = (path: string) => call<VaultInfo>('vault_open', { path });
export const vaultCreate = (path: string) => call<VaultInfo>('vault_create', { path });
export const vaultClose = () => call<void>('vault_close');
export const vaultTree = () => call<TreeNode[]>('vault_tree');
export const pageGet = (path: string) => call<Page>('page_get', { path });
export const backlinkCount = (path: string) => call<number>('backlink_count', { path });
export const entryCreatePage = (dir: string, name: string) =>
  call<string>('entry_create_page', { dir, name });
export const entryCreateFolder = (parent: string, name: string) =>
  call<string>('entry_create_folder', { parent, name });
export const entryRename = (from: string, to: string) =>
  call<RenameOutcome>('entry_rename', { from, to });
export const entryTrash = (path: string) => call<void>('entry_trash', { path });
export const settingsGet = () => call<SettingsResponse>('settings_get');
export const settingsSet = (patch: SettingsPatch) => call<Settings>('settings_set', { patch });
export const vaultsRecent = () => call<RecentVault[]>('vaults_recent');
export const vaultsForget = (path: string) => call<void>('vaults_forget', { path });

// ---- events ----

export const onVaultProgress = (cb: (p: ProgressPayload) => void): Promise<UnlistenFn> =>
  listen<ProgressPayload>('vault:progress', (e) => cb(e.payload));
export const onVaultChanged = (cb: (p: ChangedPayload) => void): Promise<UnlistenFn> =>
  listen<ChangedPayload>('vault:changed', (e) => cb(e.payload));
export const onVaultWarning = (cb: (p: WarningPayload) => void): Promise<UnlistenFn> =>
  listen<WarningPayload>('vault:warning', (e) => cb(e.payload));

// ---- native folder picker (dialog plugin, folder selection only) ----

export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
}
