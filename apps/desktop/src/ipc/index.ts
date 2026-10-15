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
  | 'notAText'
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
  /** The global Scratchpad (M4c §2). */
  scratchpad?: boolean;
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
  /** Frontmatter `cover-x` (0–100), a side cover's horizontal focus, `null`
   *  when absent (M4b part 3 §3). */
  coverX: number | null;
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
  /** The global Scratchpad (M4c §2): shown as "Quick notes". */
  scratchpad?: boolean;
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
  /** Readable measure, wide elements or full width, app-wide (M4b part 2
   *  §1; `wide`: M4b part 3). */
  pageWidth: PageWidth;
  /** The kinds that span the editor when a page is `wide` (M4b part 3). */
  wideElements: WideElements;
  /** Outline panel shown beside the editor (M4b part 2 §5). */
  outline: boolean;
  /** Cover band height in px for pages without their own (132–600). */
  coverHeight: number;
  /** A caption with each attachment's place on disk (M4b part 3 §8). */
  showAttachmentPaths: boolean;
  /** The global Scratchpad's folder (M4c §2); `null` until the first quick
   *  note. Changed only through `scratchpadSet`, never a settings patch. */
  scratchpadPath?: string | null;
}

/** `wide`: text at the readable measure, the chosen elements span the editor. */
export type PageWidth = 'readable' | 'wide' | 'full';
/** Where a page's cover sits (M4b part 3 §3). */
export type CoverSide = 'top' | 'left' | 'right';

/** What goes wide on a `wide` page (M4b part 3, wide elements §2). */
export interface WideElements {
  tables: boolean;
  code: boolean;
  /** Mermaid diagrams. */
  diagrams: boolean;
  images: boolean;
  /** `$$` maths blocks. */
  maths: boolean;
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
  pageWidth?: PageWidth;
  wideElements?: WideElements;
  outline?: boolean;
  coverHeight?: number;
  showAttachmentPaths?: boolean;
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
  /** The `file:` URL to write instead of `link` (the vault's link format is
   *  "Absolute path on disk", M4b part 3 §8). */
  url?: string;
  /** `false` when the dropped file already lived in the vault. */
  copied: boolean;
}

/** How links to new attachments are written (M4b part 3 §8). */
export type LinkFormat = 'shortest' | 'vault' | 'relative' | 'absolute';

/** A file outside the vault that a link names (M4b part 3 §9). */
export interface ExternalFile {
  /** Absolute, in its OS's form (`D:\Docs\x.pdf`, `/Users/jose/x.png`). */
  path: string;
  /** A regular, visible file on this computer. */
  exists: boolean;
  /** Linked from a saved page of the vault: the app may show or open it. */
  listed: boolean;
  /** On another computer (`\\server\…`, `/net/host/…`). */
  network: boolean;
  /** A network file the user hasn't loaded yet: nothing has touched it, and
   *  nothing will until they choose to (final review C1). */
  askFirst: boolean;
  /** A document or media file, which opens in its default app; anything
   *  else is only shown in its folder (final review I2). */
  openable: boolean;
}

/** A file chosen with the Attach button's dialog (M4b part 3 §7). */
export interface PickedFile {
  path: string;
  name: string;
  /** Its `file:` URL, for "Link to where it is". */
  url: string;
  /** The vault path when the file already lives in the vault. */
  inVault: string | null;
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
  /** Obsidian's `attachmentFolderPath` when set (it wins unless overridden). */
  obsidian: string | null;
  /** NIMW's place wins over Obsidian's (M4b §5). */
  overrideObsidian: boolean;
  /** The vault's default page width (`null`: the app's; M4b part 2 §1). */
  pageWidth: PageWidth | null;
  /** Pages with their own width. */
  pageWidths: Record<string, PageWidth>;
  /** Pages with their own cover height in px (cover resize). */
  coverHeights: Record<string, number>;
  /** Pages whose cover sits beside the text (M4b part 3 §3). */
  coverSides: Record<string, 'left' | 'right'>;
  /** Side covers' own strip widths in px (§3). */
  coverWidths: Record<string, number>;
  /** NIMW's own link format for new attachments (M4b part 3 §8). */
  attachmentLinkFormat?: LinkFormat | null;
  /** Obsidian's `newLinkFormat` (applies while NIMW has none of its own). */
  obsidianLinkFormat?: LinkFormat | null;
}

export interface VaultSettingsPatch {
  attachments?: { mode: AttachmentMode; path: string };
  overrideObsidian?: boolean;
  /** `'default'` clears the vault's own width. */
  pageWidth?: PageWidth | 'default';
  /** `'default'` follows Obsidian's format, else the shortest name. */
  attachmentLinkFormat?: LinkFormat | 'default';
}

/** What `quickNoteAutoname` did (M4c §2): where the note is now, whether it
 *  still follows its first line, and the rename when there was one. */
export interface AutoName {
  path: string;
  autoNamed: boolean;
  outcome: RenameOutcome | null;
}

/** The open vault's quick notes (M4c §7): its scratch folder (`null` in the
 *  global Scratchpad, whose root is the scratch place) and the notes still
 *  named after their first line. */
export interface QuickNotesState {
  folder: string | null;
  autoNamed: string[];
}

/** What renaming the scratch folder did: its name now, and the rename on
 *  disk when the folder existed (`from` → `folder`). */
export interface ScratchFolderResult {
  folder: string;
  from: string | null;
  outcome: RenameOutcome | null;
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
  /** `cover-x` (0–100), `null` when absent (M4b part 3 §3). */
  coverX: number | null;
  /** Where the cover sits: the header band or a strip beside the text (§3). */
  coverSide: CoverSide;
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
/** An empty text or code file `name` in `dir` (final review I6). */
export const entryCreateText = (dir: string, name: string) =>
  call<string>('entry_create_text', { dir, name });
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
/** Plain-text and code files (M4b part 2 §6): `notAText` for anything else. */
export const textRead = (path: string) => call<PageText>('text_read', { path });
export const textWrite = (path: string, text: string, expectedHash: string) =>
  call<WriteResult>('text_write', { path, text, expectedHash });
export const pageCreateConflictCopy = (path: string, text: string) =>
  call<string>('page_create_conflict_copy', { path, text });
export const linksResolve = (source: string, targets: LinkTarget[]) =>
  call<(string | null)[]>('links_resolve', { source, targets });
export const urlOpen = (url: string) => call<void>('url_open', { url });
export const fileOpenExternal = (path: string) => call<void>('file_open_external', { path });
/** Outside files the targets name (M4b part 3 §9): `null` for vault targets.
 *  Markdown targets are as written (relative to `source`), not vault-joined. */
export const linksExternal = (source: string, targets: LinkTarget[]) =>
  call<(ExternalFile | null)[]>('links_external', { source, targets });
/** Opens a linked outside file in its default app (programs are refused). */
export const externalOpen = (path: string) => call<void>('external_open', { path });
/** The user loads a linked network file (final review C1): from now on,
 *  this session, it is looked up, shown and opened like any outside file. */
export const externalNetworkAllow = (path: string) =>
  call<ExternalFile>('external_network_allow', { path });
/** Shows a linked outside file in Finder / Explorer. */
export const externalReveal = (path: string) => call<void>('external_reveal', { path });
/** The Attach button's file dialog (Rust side); `[]` when cancelled. */
export const filePick = (page: string) => call<PickedFile[]>('file_pick', { page });

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
/** A page's own width (`null` clears it; M4b part 2 §1). */
export const pageWidthSet = (path: string, width: PageWidth | null) =>
  call<VaultSettings>('page_width_set', { path, width });
/** A page's cover height in px (Rust clamps it to 132–2000); `null` clears it. */
export const coverHeightSet = (path: string, height: number | null) =>
  call<VaultSettings>('cover_height_set', { path, height });
/** Where a page's cover sits (`top` clears it; M4b part 3 §3). */
export const coverSideSet = (path: string, side: CoverSide) =>
  call<VaultSettings>('cover_side_set', { path, side });
/** A side cover's strip width in px (Rust clamps it to 160–2000); `null`
 *  clears it. */
export const coverWidthSet = (path: string, width: number | null) =>
  call<VaultSettings>('cover_width_set', { path, width });

// ---- quick notes (M4c §2, §7) ----

/** Where the global Scratchpad goes unless the user picks another folder. */
export const scratchpadDefault = () => call<string>('scratchpad_default');
/** A folder dialog Rust opens; `null` when cancelled. */
export const scratchpadChoose = () => call<string | null>('scratchpad_choose');
/** Makes `path` (the default, or the folder just chosen) the Scratchpad. */
export const scratchpadSet = (path: string) => call<Settings>('scratchpad_set', { path });
/** Opens the global Scratchpad as the vault (no path: Rust knows it). */
export const scratchpadOpen = () => call<VaultInfo>('scratchpad_open');
/** A new quick note named `name` in the open vault's scratch place. */
export const quickNoteCreate = (name: string) => call<string>('quick_note_create', { name });
/** Renames a quick note after its saved first line, while it follows it. */
export const quickNoteAutoname = (path: string) => call<AutoName>('quick_note_autoname', { path });
export const quickNotesState = () => call<QuickNotesState>('quick_notes_state');
/** Names the open vault's scratch folder (Settings → This vault). */
export const scratchFolderSet = (name: string) =>
  call<ScratchFolderResult>('scratch_folder_set', { name });

/** URL of a vault file for <img>/<audio> through the `nimw-asset:` protocol
 *  (M2a §2.5); WebView2 on Windows reaches custom protocols over http. */
export function assetUrl(path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return /Windows/i.test(navigator.userAgent)
    ? `http://nimw-asset.localhost/${encoded}`
    : `nimw-asset://localhost/${encoded}`;
}

/** URL of a linked file outside the vault (M4b part 3 §9): its absolute
 *  path as one encoded segment after `/.external/`; Rust serves it only when
 *  a saved page links to it. */
export function externalAssetUrl(path: string): string {
  const encoded = `.external/${encodeURIComponent(path)}`;
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
/** File → New Quick Note in the app menu (M4c §2). */
export const onMenuQuickNote = (cb: () => void): Promise<UnlistenFn> =>
  listen('menu:quickNote', () => cb());
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
