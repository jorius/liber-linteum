// The menu bar the app draws in its own title bar outside macOS (custom title
// bar §3): the macOS app menu (src-tauri/src/menu.rs), item for item. Items
// with an `id` run that menu item in Rust (`menu_activate`), so both menus
// behave the same; the Edit and Window items act here.
import type { TFunction } from 'i18next';

/** What an item does when it isn't a macOS menu item. */
export type LocalAction =
  | 'about'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'fullscreen'
  | 'minimize'
  | 'maximize'
  | 'closeWindow';

/** An item's options: what it shows, and what it runs (a macOS menu item's
 *  `id`, or a local `action`). */
type ItemOptions = {
  /** As the shortcuts table writes them (`Mod+Shift+N`, see `keyLabel`). */
  keys?: string;
  disabled?: boolean;
  /** A toggle that is on (View → Sidebar…). */
  checked?: boolean;
} & ({ id: string } | { action: LocalAction });

export type MenuItemEntry = {
  kind: 'item';
  /** A unique key in its menu. */
  key: string;
  label: string;
} & ItemOptions;

export type MenuEntry = MenuItemEntry | { kind: 'separator'; key: string };

export interface MenuDef {
  key: 'app' | 'file' | 'vault' | 'edit' | 'view' | 'window';
  label: string;
  items: MenuEntry[];
}

/** What the menus show: which window, which vault, which toggles are on. */
export interface MenuContext {
  /** The vault window (single-file windows have no Vault menu). */
  main: boolean;
  /** The open vault, if any (not while locked or on Welcome). */
  vault: { name: string; encrypted: boolean; scratchpad: boolean } | null;
  toggles: { sidebar: boolean; toolbar: boolean; lineNumbers: boolean; outline: boolean };
  maximized: boolean;
  /** Windows writes redo as Ctrl+Y; Linux as Ctrl+Shift+Z. */
  windows: boolean;
}

/** Vault names in a menu: at most 40 characters, then "…" (menu.rs `menu_name`). */
const VAULT_NAME_MAX = 40;
export function menuName(name: string): string {
  const chars = [...new Intl.Segmenter().segment(name.normalize('NFC'))].map((s) => s.segment);
  return chars.length > VAULT_NAME_MAX
    ? `${chars.slice(0, VAULT_NAME_MAX - 1).join('')}…`
    : name.normalize('NFC');
}

const sep = (key: string): MenuEntry => ({ kind: 'separator', key });

export function buildMenus(t: TFunction, ctx: MenuContext): MenuDef[] {
  const { vault, toggles } = ctx;
  const open = !!vault;
  const plain = !!vault && !vault.encrypted && !vault.scratchpad;
  const item = (key: string, options: ItemOptions): MenuEntry => ({
    kind: 'item',
    key,
    label: t(`titlebar.items.${key}`),
    ...options,
  });

  const app: MenuDef = {
    key: 'app',
    label: t('app.name'),
    items: [
      item('about', { action: 'about' }),
      sep('s1'),
      item('settings', { id: 'liber-settings', keys: 'Mod+,', disabled: ctx.main && !open }),
      sep('s2'),
      item('quit', { id: 'liber-quit', keys: 'Mod+Q' }),
    ],
  };
  const quickNote: MenuEntry = {
    kind: 'item',
    key: 'quickNote',
    label:
      vault && !vault.scratchpad
        ? t('titlebar.items.quickNoteIn', { name: menuName(vault.name) })
        : t('titlebar.items.quickNote'),
    id: 'liber-quick-note',
    keys: 'Mod+Shift+N',
  };
  const file: MenuDef = {
    key: 'file',
    label: t('titlebar.menus.file'),
    items: [
      quickNote,
      item('openFile', { id: 'liber-open-file', keys: 'Mod+Shift+O' }),
      sep('s1'),
      item('importNotion', { id: 'liber-notion-import' }),
      sep('s2'),
      item('save', { id: 'liber-save', keys: 'Mod+S' }),
    ],
  };
  const vaultMenu: MenuDef = {
    key: 'vault',
    label: t('titlebar.menus.vault'),
    items: [
      item('newVault', { id: 'liber-vault-new' }),
      item('openVault', { id: 'liber-vault-open', keys: 'Mod+O' }),
      sep('s1'),
      {
        kind: 'item',
        key: 'encrypt',
        label: plain
          ? t('titlebar.items.encryptNamed', { name: menuName(vault.name) })
          : t('titlebar.items.encrypt'),
        id: 'liber-vault-encrypt',
        disabled: !plain,
      },
      item('lock', { id: 'liber-vault-lock', keys: 'Alt+Mod+L', disabled: !vault?.encrypted }),
      item('closeVault', { id: 'liber-vault-close', keys: 'Alt+Mod+W', disabled: !open }),
    ],
  };
  const edit: MenuDef = {
    key: 'edit',
    label: t('titlebar.menus.edit'),
    items: [
      item('undo', { action: 'undo', keys: 'Mod+Z' }),
      item('redo', { action: 'redo', keys: ctx.windows ? 'Mod+Y' : 'Mod+Shift+Z' }),
      sep('s1'),
      item('cut', { action: 'cut', keys: 'Mod+X' }),
      item('copy', { action: 'copy', keys: 'Mod+C' }),
      item('paste', { action: 'paste', keys: 'Mod+V' }),
      item('selectAll', { action: 'selectAll', keys: 'Mod+A' }),
      sep('s2'),
      item('find', { id: 'liber-find', keys: 'Mod+F' }),
      item('gotoLine', { id: 'liber-goto-line', keys: 'Ctrl+G' }),
    ],
  };
  const toggleItems: MenuEntry[] = [
    item('toolbar', { id: 'liber-toggle-toolbar', checked: toggles.toolbar }),
    item('lineNumbers', { id: 'liber-toggle-line-numbers', checked: toggles.lineNumbers }),
    item('outline', { id: 'liber-toggle-outline', checked: toggles.outline }),
  ];
  const view: MenuDef = {
    key: 'view',
    label: t('titlebar.menus.view'),
    items: ctx.main
      ? [
          item('search', { id: 'liber-search', keys: 'Mod+Shift+F', disabled: !open }),
          sep('s1'),
          item('editor', { id: 'liber-screen-edit', keys: 'Mod+1', disabled: !open }),
          item('globalView', { id: 'liber-screen-global', keys: 'Mod+2', disabled: !open }),
          item('atoms', { id: 'liber-see-atoms', disabled: !open }),
          sep('s2'),
          item('back', { id: 'liber-back', keys: 'Mod+[', disabled: !open }),
          item('forward', { id: 'liber-forward', keys: 'Mod+]', disabled: !open }),
          sep('s3'),
          item('sidebar', {
            id: 'liber-toggle-sidebar',
            keys: 'Mod+\\',
            checked: toggles.sidebar,
            disabled: !open,
          }),
          ...toggleItems,
          sep('s4'),
          item('fullscreen', { action: 'fullscreen', keys: 'F11' }),
        ]
      : [...toggleItems, sep('s1'), item('fullscreen', { action: 'fullscreen', keys: 'F11' })],
  };
  const windowMenu: MenuDef = {
    key: 'window',
    label: t('titlebar.menus.window'),
    items: [
      item('minimize', { action: 'minimize' }),
      {
        kind: 'item',
        key: 'maximize',
        label: t(ctx.maximized ? 'titlebar.items.restore' : 'titlebar.items.maximize'),
        action: 'maximize',
      },
      sep('s1'),
      item('closeWindow', { action: 'closeWindow' }),
    ],
  };
  return ctx.main
    ? [app, file, vaultMenu, edit, view, windowMenu]
    : [app, file, edit, view, windowMenu];
}
