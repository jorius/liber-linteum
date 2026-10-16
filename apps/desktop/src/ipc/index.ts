// The only module allowed to talk to the Rust backend. Every backend
// capability the UI uses is a typed function here (M1b spec §3.2).
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
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
  /** The vault's emoji (M5b §4). */
  icon?: string;
}

export type NodeKind = 'page' | 'folder' | 'attachment';

export interface TreeNode {
  path: string;
  kind: NodeKind;
  /** A page's frontmatter emoji or a folder's (M5b §4). */
  icon?: string;
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
  /** The vault's emoji (M5b §4). */
  icon?: string;
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
  /** Pages save as you type (M5b §6); off: only on ⌘S. */
  autoSave: boolean;
  /** The sidebar is collapsed (M5b §2.5). */
  sidebarCollapsed: boolean;
  /** Where the floating Edit / Global View / Search button sits (M5b §2.2). */
  actionButton: ActionButtonPlace;
}

export type ActionButtonPlace = 'bottomRight' | 'bottomLeft' | 'topRight';

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
  autoSave?: boolean;
  sidebarCollapsed?: boolean;
  actionButton?: ActionButtonPlace;
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

/** An answer that needs no backend. */
const none = <T>(value: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, value });

// ---- single-file windows (M4c §3, §4) ----

/** This window's label (`main`, `file-1`…); `main` outside Tauri. */
export function windowLabel(): string {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  };
  return w.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? 'main';
}

/** Whether this window shows one file opened on its own. */
export const isFileWindowLabel = (label = windowLabel()) => label.startsWith('file-');

/** The file a single-file window shows (its name in its folder), else `null`. */
let fileName: string | null = null;

/** Set once `file_info` answers, and after each rename. While it is set, the
 *  page commands act on the window's own file (`file_*`): `PageDoc`, the
 *  editor and the preview work unchanged, and nothing they send names a
 *  file to write. */
export function setFileWindow(name: string | null): void {
  fileName = name;
}

export function fileWindowName(): string | null {
  return fileName;
}

/** The window's file, or (read only) another note in its folder (an embed). */
const fileText = (path: string) =>
  path === fileName ? call<PageText>('file_read') : call<PageText>('file_note_read', { path });

const fileWrite = (
  path: string,
  text: string,
  expectedHash: string,
): Promise<IpcResult<WriteResult>> =>
  path === fileName
    ? call<WriteResult>('file_write', { text, expectedHash })
    : Promise.resolve({
        ok: false,
        error: { kind: 'notPermitted', message: `${path} is not this window's file` },
      });

export type FileKind = 'page' | 'text';

/** A recent vault holding the window's file ("Open in its vault"). */
export interface HomeVault {
  root: string;
  name: string;
  /** The file's path in that vault. */
  page: string;
}

export interface FileInfo {
  name: string;
  kind: FileKind;
  /** The file's folder, absolute (shown only). */
  folder: string;
  vault: HomeVault | null;
}

export const fileInfo = () => call<FileInfo>('file_info');
/** Same folder, same extension; answers the new name. */
export const fileRename = (newName: string) => call<string>('file_rename', { newName });
/** A link to a file in the folder: a note opens in its own window, a
 *  document or media file in its default app. */
export const fileFollow = (path: string) => call<'window' | 'opened'>('file_follow', { path });
/** The main window opens the vault holding the file, at its page. */
export const fileOpenInVault = () => call<void>('file_open_in_vault');
/** File → Open File…: answers the names it couldn't open. */
export const fileOpenDialog = () => call<string[]>('file_open_dialog');
/** Closes this window without asking (its pages are saved first). Not the
 *  window plugin's `destroy`, which takes any window's label (M4c review I2). */
export const destroyWindow = () => call<void>('window_close_self');
/** Names this window (M5b §2.3: "Page — Vault"). */
export const windowTitleSet = (title: string) => call<void>('window_title_set', { title });

export const vaultOpen = (path: string) => call<VaultInfo>('vault_open', { path });
export const vaultCreate = (path: string) => call<VaultInfo>('vault_create', { path });
export const vaultClose = () => call<void>('vault_close');
export const vaultTree = () => call<TreeNode[]>('vault_tree');
export const pageGet = (path: string) => call<Page>('page_get', { path });
export const backlinkCount = (path: string) => call<number>('backlink_count', { path });
/** In a single-file window: its file again, where it was ("Save again"
 *  after it was deleted outside; the page's "Save as new" path). */
export const entryCreatePage = (dir: string, name: string) =>
  fileName !== null
    ? call<string>('file_recreate')
    : call<string>('entry_create_page', { dir, name });
/** An empty text or code file `name` in `dir` (final review I6). */
export const entryCreateText = (dir: string, name: string) =>
  fileName !== null
    ? call<string>('file_recreate')
    : call<string>('entry_create_text', { dir, name });
export const entryCreateFolder = (parent: string, name: string) =>
  call<string>('entry_create_folder', { parent, name });
export const entryRename = (from: string, to: string) =>
  call<RenameOutcome>('entry_rename', { from, to });
/** Moves an item into the vault's Trash (M5b §5.1); its path there. */
export const entryTrash = (path: string) => call<string>('entry_trash', { path });
export const settingsGet = () => call<SettingsResponse>('settings_get');
export const settingsSet = (patch: SettingsPatch) => call<Settings>('settings_set', { patch });
export const vaultsRecent = () => call<RecentVault[]>('vaults_recent');
export const vaultsForget = (path: string) => call<void>('vaults_forget', { path });
export const pageRead = (path: string) =>
  fileName !== null ? fileText(path) : call<PageText>('page_read', { path });
export const pageWrite = (path: string, text: string, expectedHash: string) =>
  fileName !== null
    ? fileWrite(path, text, expectedHash)
    : call<WriteResult>('page_write', { path, text, expectedHash });
/** Plain-text and code files (M4b part 2 §6): `notAText` for anything else. */
export const textRead = (path: string) =>
  fileName !== null ? fileText(path) : call<PageText>('text_read', { path });
export const textWrite = (path: string, text: string, expectedHash: string) =>
  fileName !== null
    ? fileWrite(path, text, expectedHash)
    : call<WriteResult>('text_write', { path, text, expectedHash });
export const pageCreateConflictCopy = (path: string, text: string) =>
  fileName !== null
    ? call<string>('file_conflict_copy', { text })
    : call<string>('page_create_conflict_copy', { path, text });
export const linksResolve = (source: string, targets: LinkTarget[]) =>
  fileName !== null
    ? call<(string | null)[]>('file_links_resolve', { targets })
    : call<(string | null)[]>('links_resolve', { source, targets });
export const urlOpen = (url: string) => call<void>('url_open', { url });
export const fileOpenExternal = (path: string) => call<void>('file_open_external', { path });
/** Outside files the targets name (M4b part 3 §9): `null` for vault targets.
 *  Markdown targets are as written (relative to `source`), not vault-joined. */
export const linksExternal = (source: string, targets: LinkTarget[]) =>
  fileName !== null
    ? none(targets.map(() => null))
    : call<(ExternalFile | null)[]>('links_external', { source, targets });
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
  fileName !== null
    ? none<LinkSuggestion[]>([])
    : call<LinkSuggestion[]>('link_suggest', { source, query, embed });
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
/** A folder's emoji (M5b §4); `null` removes it. Page icons are frontmatter. */
export const folderIconSet = (path: string, icon: string | null) =>
  call<null>('folder_icon_set', { path, icon });
/** How a folder lists its entries (M5b round 2); folders always come first. */
export type FolderSort =
  'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc' | 'created-desc';
/** A folder's order (`""`: the vault root). */
export const folderSortGet = (path: string) => call<FolderSort>('folder_sort_get', { path });
export const folderSortSet = (path: string, sort: FolderSort) =>
  call<null>('folder_sort_set', { path, sort });
/** The vault's own emoji (M5b §4); `null` removes it. */
export const vaultIconSet = (icon: string | null) => call<null>('vault_icon_set', { icon });

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

// ---- search (M5 §3; mirrors src-tauri/src/search_commands.rs) ----

export interface SearchQuery {
  text?: string;
  /** A top-level folder. */
  project?: string | null;
  /** A folder path, or a folder name anywhere in the vault. */
  folder?: string | null;
  /** All must be present; a tag also matches its nested tags. */
  tags?: string[];
  /** A page path, or a name resolved like `[[name]]`, else a title. */
  linksTo?: string | null;
  linksFrom?: string | null;
  hasImage?: boolean;
  hasAudio?: boolean;
  /** Include archived pages (M5b §5.3). */
  archived?: boolean;
  offset?: number;
  /** At most 50; 0 means 50. */
  limit?: number;
}

/** A run of snippet text; `hit` words matched the query. Never HTML. */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface SearchHit {
  path: string;
  title: string;
  /** The cover's vault path (`null`: none, remote or missing). */
  cover: string | null;
  /** As written, matching ones first. */
  tags: string[];
  hasImage: boolean;
  hasAudio: boolean;
  /** About 12 words around the first body match. */
  snippet: SnippetPart[] | null;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface FacetPage {
  path: string;
  title: string;
  count: number;
  active: boolean;
}

export interface Facets {
  projects: FacetCount[];
  tags: FacetCount[];
  linksTo: FacetPage[];
  /** The active `linksFrom` filter, resolved. */
  linksFrom: FacetPage | null;
  hasImage: number;
  hasAudio: number;
  /** Archived matches, included or not. */
  archived: number;
}

export interface SearchPage {
  results: SearchHit[];
  total: number;
  facets: Facets;
  /** No text and no filters: the 20 most recently modified pages. */
  recent: boolean;
  /** A full re-index is running; results may be partial. */
  indexing: boolean;
}

export const search = (query: SearchQuery) => call<SearchPage>('search', { query });

// ---- the vault's Trash and Archive (M5b §5; mirrors src-tauri/src/bin_commands.rs) ----

export interface BinItem {
  /** Its path now (`.trash/…` or `.archive/…`). */
  path: string;
  /** Where it was; `null` when unrecorded (Obsidian's own trash). */
  from: string | null;
  /** When it went in (ms since epoch). */
  at: number | null;
  folder: boolean;
}

export interface BinLists {
  trash: BinItem[];
  archive: BinItem[];
}

export const binList = () => call<BinLists>('bin_list');
/** Back to where it was; `alreadyExists` unless `keepBoth`. Its path now. */
export const trashRestore = (path: string, keepBoth: boolean) =>
  call<string>('trash_restore', { path, keepBoth });
/** Out of the vault, to the system Trash. */
export const trashDelete = (paths: string[]) => call<void>('trash_delete', { paths });
export const trashEmpty = () => call<void>('trash_empty');
export const entryArchive = (path: string) => call<RenameOutcome>('entry_archive', { path });
export const archiveRestore = (path: string, keepBoth: boolean) =>
  call<RenameOutcome>('archive_restore', { path, keepBoth });

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

/** Events sent to this window (and to every window), not those sent to
 *  another one: a listener with no target hears every window's events
 *  (M4c §3: menu items act on the focused window only). */
const mine = () => ({ target: { kind: 'WebviewWindow' as const, label: windowLabel() } });

export const onVaultProgress = (cb: (p: ProgressPayload) => void): Promise<UnlistenFn> =>
  listen<ProgressPayload>('vault:progress', (e) => cb(e.payload));
export const onVaultChanged = (cb: (p: ChangedPayload) => void): Promise<UnlistenFn> =>
  listen<ChangedPayload>('vault:changed', (e) => cb(e.payload));
/** View → Back / Forward in the app menu (M2b §3). */
export const onMenuNavigate = (cb: (direction: 'back' | 'forward') => void): Promise<UnlistenFn> =>
  listen<'back' | 'forward'>('menu:navigate', (e) => cb(e.payload), mine());
/** View → Toggle Formatting Toolbar / Toggle Line Numbers in the app menu:
 *  the settings key to flip. */
export const onMenuToggle = (cb: (key: string) => void): Promise<UnlistenFn> =>
  listen<string>('menu:toggle', (e) => cb(e.payload), mine());
/** View → Editor / Global View in the app menu (M3a §2). */
export const onMenuScreen = (cb: (screen: string) => void): Promise<UnlistenFn> =>
  listen<string>('menu:screen', (e) => cb(e.payload), mine());
/** File → Open File… (M4c §3). */
export const onMenuOpenFile = (cb: () => void): Promise<UnlistenFn> =>
  listen<null>('menu:open-file', () => cb(), mine());
/** A single-file window's file changed on disk, or is gone. */
export const onFileChanged = (cb: (p: { removed: boolean }) => void): Promise<UnlistenFn> =>
  listen<{ removed: boolean }>('file:changed', (e) => cb(e.payload), mine());
/** A single-file window hands its page to the main window (M4c §3). */
export const onOpenInVault = (
  cb: (p: { root: string; page: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ root: string; page: string }>('file:open-in-vault', (e) => cb(e.payload), mine());
/** Settings changed in any window (M4c §3): every window shows them. */
export const onSettingsChanged = (cb: (s: Settings) => void): Promise<UnlistenFn> =>
  listen<Settings>('settings:changed', (e) => cb(e.payload), mine());
/** File → New Quick Note in the app menu (M4c §2). */
export const onMenuQuickNote = (cb: () => void): Promise<UnlistenFn> =>
  listen('menu:quickNote', () => cb(), mine());
/** View → Search… in the app menu (M5 §4). */
export const onMenuSearch = (cb: () => void): Promise<UnlistenFn> =>
  listen<null>('menu:search', () => cb(), mine());
/** Notes In My Way → Settings… (M5b §2.1). */
export const onMenuSettings = (cb: () => void): Promise<UnlistenFn> =>
  listen<null>('menu:settings', () => cb(), mine());
/** Vault → Open Vault… / Close Vault (M5b §2.1). */
export const onMenuVault = (cb: (what: string) => void): Promise<UnlistenFn> =>
  listen<string>('menu:vault', (e) => cb(e.payload), mine());
/** File → Save (M5b §6). */
export const onMenuSave = (cb: () => void): Promise<UnlistenFn> =>
  listen<null>('menu:save', () => cb(), mine());
/** View → Toggle Sidebar (M5b §2.5). */
export const onMenuSidebar = (cb: () => void): Promise<UnlistenFn> =>
  listen<null>('menu:sidebar', () => cb(), mine());
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
  // As `Window.onCloseRequested`, closing through `window_close_self` (M4c
  // review I2); listening at all is what keeps the window open meanwhile.
  getCurrentWindow().listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
    if (await handler()) await destroyWindow();
  });

// ---- native folder picker (dialog plugin, folder selection only) ----

export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
}
