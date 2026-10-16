/** Settings → Keyboard shortcuts (M5b §18): what the app answers, as one
 *  read-only table. `Mod` is ⌘ on macOS and Ctrl elsewhere. The menu's
 *  accelerators are checked against it by `shortcuts.test.ts`. */
export const SHORTCUT_GROUPS = [
  {
    id: 'navigation',
    items: [
      { keys: 'Mod+[', label: 'back' },
      { keys: 'Mod+]', label: 'forward' },
      { keys: 'Mod+1', label: 'edit' },
      { keys: 'Mod+2', label: 'globalView' },
      { keys: 'Mod+F', label: 'search' },
      { keys: 'Mod+Shift+F', label: 'search' },
      { keys: 'Mod+Shift+E', label: 'files' },
    ],
  },
  {
    id: 'editing',
    items: [
      { keys: 'Mod+N', label: 'newPage' },
      { keys: 'Mod+Shift+N', label: 'quickNote' },
      { keys: 'Mod+S', label: 'save' },
      { keys: 'Mod+K', label: 'link' },
      { keys: 'Mod+B', label: 'bold' },
      { keys: 'Mod+I', label: 'italic' },
      { keys: 'Mod+E', label: 'code' },
      { keys: 'Mod+Shift+X', label: 'strike' },
      { keys: 'Mod+Shift+H', label: 'highlight' },
      { keys: 'Mod+Shift+7', label: 'numbered' },
      { keys: 'Mod+Shift+8', label: 'bullet' },
      { keys: 'Mod+Shift+9', label: 'task' },
      { keys: 'Mod+Shift+.', label: 'quote' },
      { keys: 'Mod+Shift+D', label: 'favorite' },
    ],
  },
  {
    id: 'vault',
    items: [
      { keys: 'Mod+O', label: 'openVault' },
      { keys: 'Alt+Mod+W', label: 'closeVault' },
      { keys: 'Mod+Shift+O', label: 'openFile' },
    ],
  },
  {
    id: 'view',
    items: [
      { keys: 'Mod+\\', label: 'sidebar' },
      { keys: 'Mod+J', label: 'actions' },
      { keys: 'Mod+,', label: 'settings' },
      { keys: 'Mod+Q', label: 'quit' },
    ],
  },
] as const;

const MAC_NAMES: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥' };
const OTHER_NAMES: Record<string, string> = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt' };

/** `Alt+Mod+W` as the platform writes it: `⌥⌘W` on macOS, `Alt+Ctrl+W` elsewhere. */
export function keyLabel(keys: string, mac: boolean): string {
  const parts = keys.split(/\+(?=.)/).map((p) => (mac ? MAC_NAMES : OTHER_NAMES)[p] ?? p);
  return mac ? parts.join('') : parts.join('+');
}
