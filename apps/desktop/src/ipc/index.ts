// The only module allowed to talk to the Rust backend. Every backend
// capability the UI uses is a typed function here (M1b spec §3.2).
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
  | 'binary'
  | 'invalidUrl'
  | 'notPermitted'
  | 'notAFile'
  | 'tooLarge'
  | 'io';

export interface CommandError {
  kind: ErrorKind;
  message: string;
  /** `page_write` conflicts carry the file as it is now (M2a §3.1). */
  currentText?: string;
  currentHash?: string;
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
    const { kind, message, currentText, currentHash } = e as CommandError;
    return typeof currentText === 'string' && typeof currentHash === 'string'
      ? { kind, message, currentText, currentHash }
      : { kind, message };
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
  /** Frontmatter `cover-y` (0–100), `null` when absent (M2c §4). */
  coverY: number | null;
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

export type EditorMode = 'livePreview' | 'source' | 'split';

/** Built-in palettes (M2b §4); `custom` derives one from `accentColor`. */
export const PALETTE_IDS = [
  'lavender',
  'graphite',
  'rosewood',
  'saffron',
  'persimmon',
  'midnight',
  'sepia',
  'ink',
] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];
export type PaletteChoice = PaletteId | 'custom';

/** A bundled font id (theme/fonts.ts) or `system:<Family Name>`. */
export type FontChoice = string;

export interface Settings {
  version: number;
  /** `null` = follow the OS. */
  language: string | null;
  theme: Theme;
  rewriteLinks: boolean;
  confirmDelete: boolean;
  editorMode: EditorMode;
  palette: PaletteChoice;
  /** `#rrggbb`, used when `palette` is `custom`. */
  accentColor: string;
  fontLivePreview: FontChoice;
  fontSource: FontChoice;
  /** Editor text size in px (13–20). */
  fontSize: number;
  /** Formatting toolbar shown. */
  toolbar: boolean;
  /** Line numbers in the editor gutter. */
  lineNumbers: boolean;
  /** Global View: how a click opens the next level (M3a §5). */
  globalViewMode: GlobalViewMode;
  /** Global View: edge kinds shown (M3a §6). */
  globalViewEdges: GlobalViewEdges;
}

export type GlobalViewMode = 'drill' | 'expand';

export interface GlobalViewEdges {
  links: boolean;
  tree: boolean;
  manual: boolean;
  /** "Links from inside folders". */
  aggregated: boolean;
}

/** `language: 'system'` means follow the OS again. */
export interface SettingsPatch {
  language?: string;
  theme?: Theme;
  rewriteLinks?: boolean;
  confirmDelete?: boolean;
  editorMode?: EditorMode;
  palette?: PaletteChoice;
  accentColor?: string;
  fontLivePreview?: FontChoice;
  fontSource?: FontChoice;
  fontSize?: number;
  toolbar?: boolean;
  lineNumbers?: boolean;
  globalViewMode?: GlobalViewMode;
  globalViewEdges?: GlobalViewEdges;
}

export interface SettingsResponse {
  settings: Settings;
  warning?: string;
}

export interface PageText {
  text: string;
  hash: string;
}

export interface WriteResult {
  hash: string;
}

/** Mirrors `nimw_markdown::LinkKind::as_str`. */
export type LinkKind = 'wiki' | 'embed' | 'markdown' | 'markdown_image' | 'related' | 'cover';

export interface LinkTarget {
  kind: LinkKind;
  target: string;
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

/** A file saved into (or found in) the vault for a page (M2c §7.3). */
export interface Attached {
  path: string;
  /** Wiki-style target that resolves from the page back to `path`. */
  link: string;
  /** `false` when the dropped file already lived in the vault. */
  copied: boolean;
}

/** One dropped path's outcome. */
export interface ImportResult {
  source: string;
  ok?: Attached;
  err?: CommandError;
}

/** The cover image Rust imported and its frontmatter `cover:` value. */
export interface CoverPick {
  path: string;
  reference: string;
}

/** One `[[` suggestion (M2c §7.2). */
export interface LinkSuggestion {
  path: string;
  kind: 'page' | 'attachment';
  title: string | null;
  /** What to write between `[[` and `]]`. */
  target: string;
}

export type AttachmentMode = 'vault' | 'same' | 'subfolder' | 'folder';

export interface VaultSettings {
  attachments: { mode: AttachmentMode; path: string };
  /** Obsidian's `attachmentFolderPath` when set (it wins). */
  obsidian: string | null;
}

export interface VaultSettingsPatch {
  attachments?: { mode: AttachmentMode; path: string };
}

/** What one Global View click opens (M3a §3). */
export type GvLevelRef =
  { kind: 'vault' } | { kind: 'folder'; path: string } | { kind: 'page'; path: string };

export type GvCardKind = 'project' | 'folder' | 'page';
export type GvRelation = 'centre' | 'in' | 'out' | 'both';

/** One Global View card (M3a §4). */
export interface GvCard {
  path: string;
  kind: GvCardKind;
  title: string;
  subtitle: string | null;
  /** The cover's vault path (`null`: none, remote or missing). */
  cover: string | null;
  coverRemote: boolean;
  coverY: number | null;
  excerpt: string;
  hasImage: boolean;
  hasAudio: boolean;
  /** Folders: the page previewed on the card. */
  indexPage: string | null;
  /** Folders: which GV-02 rule chose `indexPage` (M3b §4); a pick is offered
   *  unless it is `named` or `index`. The backend always sends it; optional
   *  only so card fixtures written before it needn't list it. */
  indexFrom?: 'named' | 'index' | 'picked' | 'only' | null;
  pages: number;
  folders: number;
  childTitles: string[];
  /** Page levels: where the card sits around the centre. */
  relation: GvRelation | null;
}

export interface GvLevel {
  cards: GvCard[];
  /** Page levels: the page itself. */
  centre: string | null;
  /**
   * Page levels: neighbours left out because a page shows at most 200 around
   * it (links out and relationships first, then the newest backlinks); 0
   * elsewhere. The UI can say "+N more not shown". The backend always sends
   * it; optional only so level fixtures written before it needn't list it.
   */
  omitted?: number;
}

/** One edge between visible cards (M3a §6). */
export interface GvEdge {
  from: string;
  to: string;
  kind: 'link' | 'manual';
  count: number;
  aggregated: boolean;
  directed: boolean;
  label: string | null;
}

export interface CardPosition {
  x: number;
  y: number;
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
export const pageRead = (path: string) => call<PageText>('page_read', { path });
export const pageWrite = (path: string, text: string, expectedHash: string) =>
  call<WriteResult>('page_write', { path, text, expectedHash });
export const pageCreateConflictCopy = (path: string, text: string) =>
  call<string>('page_create_conflict_copy', { path, text });
export const linksResolve = (source: string, targets: LinkTarget[]) =>
  call<(string | null)[]>('links_resolve', { source, targets });
export const urlOpen = (url: string) => call<void>('url_open', { url });
export const fileOpenExternal = (path: string) => call<void>('file_open_external', { path });

/** Font families installed on this computer (M2b §5). */
export const fontsList = () => call<string[]>('fonts_list');
/** Saves pasted image bytes (raw body; page and name travel in headers). */
export const attachmentPaste = (page: string, name: string, bytes: Uint8Array) =>
  ipcCall(() =>
    invoke<Attached>('attachment_paste', bytes, {
      headers: {
        'x-nimw-page': encodeURIComponent(page),
        'x-nimw-name': encodeURIComponent(name),
      },
    }),
  );
/** Imports files from the latest native drop (other paths are refused). */
export const attachmentImport = (page: string, paths: string[]) =>
  call<ImportResult[]>('attachment_import', { page, paths });
/** Opens the native image dialog (Rust side); `null` when cancelled. */
export const coverPick = (page: string) => call<CoverPick | null>('cover_pick', { page });
export const linkSuggest = (source: string, query: string, embed: boolean) =>
  call<LinkSuggestion[]>('link_suggest', { source, query, embed });
export const gvChildren = (level: GvLevelRef) => call<GvLevel>('gv_children', { level });
export const gvEdges = (visible: string[]) => call<GvEdge[]>('gv_edges', { visible });
export const layoutGet = (level: string) =>
  call<Record<string, CardPosition>>('layout_get', { level });
export const layoutSet = (level: string, positions: Record<string, CardPosition>) =>
  call<void>('layout_set', { level, positions });
/** M3b §6: the shortest wiki target from `source` to the vault path `target`. */
export const linkTarget = (source: string, target: string) =>
  call<string>('link_target', { source, target });
/** M3b §4: picks (or clears, `null`) a folder's index note; answers its card. */
export const indexPickSet = (folder: string, page: string | null) =>
  call<GvCard>('index_pick_set', { folder, page });
export const vaultSettingsGet = () => call<VaultSettings>('vault_settings_get');
export const vaultSettingsSet = (patch: VaultSettingsPatch) =>
  call<VaultSettings>('vault_settings_set', { patch });

/** URL of a vault file for <img>/<audio> through the `nimw-asset:` protocol
 *  (M2a §2.5); WebView2 on Windows reaches custom protocols over http. */
export function assetUrl(path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return /Windows/i.test(navigator.userAgent)
    ? `http://nimw-asset.localhost/${encoded}`
    : `nimw-asset://localhost/${encoded}`;
}

// ---- events ----

export const onVaultProgress = (cb: (p: ProgressPayload) => void): Promise<UnlistenFn> =>
  listen<ProgressPayload>('vault:progress', (e) => cb(e.payload));
export const onVaultChanged = (cb: (p: ChangedPayload) => void): Promise<UnlistenFn> =>
  listen<ChangedPayload>('vault:changed', (e) => cb(e.payload));
/** View → Back / Forward in the app menu (M2b §3). */
export const onMenuNavigate = (cb: (direction: 'back' | 'forward') => void): Promise<UnlistenFn> =>
  listen<'back' | 'forward'>('menu:navigate', (e) => cb(e.payload));
/** View → Toggle Formatting Toolbar / Toggle Line Numbers in the app menu:
 *  the settings key to flip. */
export const onMenuToggle = (cb: (key: string) => void): Promise<UnlistenFn> =>
  listen<string>('menu:toggle', (e) => cb(e.payload));
/** View → Editor / Global View in the app menu (M3a §2). */
export const onMenuScreen = (cb: (screen: string) => void): Promise<UnlistenFn> =>
  listen<string>('menu:screen', (e) => cb(e.payload));
export const onVaultWarning = (cb: (p: WarningPayload) => void): Promise<UnlistenFn> =>
  listen<WarningPayload>('vault:warning', (e) => cb(e.payload));

/** A native file drag over the window (M2c §5.2). `x`/`y` are from the
 *  webview's top-left corner: CSS pixels on macOS and Linux despite Tauri's
 *  `PhysicalPosition` type, physical pixels on Windows (`dragPixelRatio`). */
export interface DragDropPayload {
  type: 'enter' | 'over' | 'drop' | 'leave';
  paths?: string[];
  x?: number;
  y?: number;
}

/** Files dragged from the OS onto the window. */
export const onDragDrop = (cb: (e: DragDropPayload) => void): Promise<UnlistenFn> =>
  getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === 'leave') cb({ type: 'leave' });
    else
      cb({
        type: p.type,
        paths: 'paths' in p ? p.paths : undefined,
        x: p.position.x,
        y: p.position.y,
      });
  });

/** Runs `handler` (e.g. flushing unsaved pages) before the main window closes;
 *  the window is destroyed once it resolves `true` and stays open on `false`. */
export const onCloseRequested = (handler: () => Promise<boolean>): Promise<UnlistenFn> =>
  getCurrentWindow().onCloseRequested(async (event) => {
    if (!(await handler())) event.preventDefault();
  });

// ---- native folder picker (dialog plugin, folder selection only) ----

export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
}
