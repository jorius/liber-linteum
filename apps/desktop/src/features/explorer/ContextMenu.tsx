import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { folderPageOf, joinPath, nameOf, parentOf } from '../../stores/tree';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { EmojiPicker } from '../icons/EmojiPicker';
import { setIcon } from '../icons/setIcon';
import { archiveItem, restoreItem } from '../bin/binActions';
import { isArchived } from '../../stores/tree';
import { openPage } from '../../stores/navigate';
import { SortMenu } from './SortMenu';
import { placePopup, windowViewport } from '../editor/placePopup';
import { requestTrash } from './trashAction';
import { nudgeFavorite, shownFavorites, useFavoritesStore } from '../favorites/favoritesStore';
import { displayName, useShowExtensions } from './TreeRow';
import { entryReveal } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { revealKey } from './reveal';
import { newQuickNote } from '../scratchpad/quickNote';
import { homeOffered, homePageOf, toggleHomePage, useHomeStore } from '../home/homeStore';
import { isTextPath } from '../../stores/textFiles';

export interface MenuState {
  path: string;
  anchor: { x: number; y: number };
}

/** Explorer actions for one item (right-click, "…" or Shift+F10). */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { t } = useTranslation();
  const extensions = useShowExtensions();
  // From its folder's rows, which also hold the Archive's (M5b round 2).
  const node = useVaultStore((s) =>
    s.children.get(parentOf(menu.path))?.find((n) => n.path === menu.path),
  );
  const favorites = useFavoritesStore((s) => s.paths);
  const homePage = useHomeStore((s) => homePageOf(s.home));
  const offersHome = useVaultStore((s) => homeOffered(s.info));
  const [active, setActive] = useState(0);
  // Icon… swaps the menu for the emoji picker at the same place (M5b §4).
  const [picking, setPicking] = useState(false);
  // Sort by ▸ swaps the menu for the folder's orders (M5b round 2).
  const [sorting, setSorting] = useState(false);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);

  // Inside the window, below the title bar: a row near the bottom opens the
  // menu upwards instead of hiding its last items off screen.
  const [place, setPlace] = useState({ top: menu.anchor.y, left: menu.anchor.x });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const at = { top: menu.anchor.y, bottom: menu.anchor.y, left: menu.anchor.x };
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const { top, left } = placePopup(at, size, windowViewport());
    setPlace((p) => (p.top === top && p.left === left ? p : { top, left }));
  }, [menu.anchor.x, menu.anchor.y, picking, sorting]);

  useEffect(() => {
    items.current[active]?.focus();
  }, [active, sorting]);

  useEffect(() => {
    if (picking || sorting) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose, picking, sorting]);

  // Its item vanished (deleted or renamed outside the app): close instead of
  // lingering invisibly with global shortcuts disabled (final review, upgraded M3).
  useEffect(() => {
    if (!node) onClose();
  }, [node, onClose]);

  if (!node) return null;
  const dir = node.kind === 'folder' ? node.path : parentOf(node.path);
  // A folder's own page (round 3b §6): Favorites and Icon act on it.
  const children = useVaultStore.getState().children;
  const page = node.kind === 'folder' ? folderPageOf(node.path, children) : null;
  const target = page ?? node.path;
  const namesake = joinPath(parentOf(node.path), `${nameOf(node.path)}.md`);
  const hasNamesake =
    node.kind === 'folder' && !!children.get(parentOf(node.path))?.some((n) => n.path === namesake);
  const own = `${node.path}/${nameOf(node.path)}.md`;
  const folderPage: [string, () => void][] =
    node.kind !== 'folder'
      ? []
      : page
        ? // Its page only differs in case (round 3 §9): offer to match the names.
          page === own
          ? []
          : [[t('menu.matchFolderPageName'), () => void vault().rename(page, own)]]
        : hasNamesake
          ? [
              [
                t('menu.useAsFolderPage', { name: nameOf(node.path) }),
                () => void vault().rename(namesake, `${node.path}/${nameOf(node.path)}.md`),
              ],
            ]
          : [[t('menu.addFolderPage'), () => void vault().createFolderPage(node.path)]];
  const vault = useVaultStore.getState;
  // TODO(E4): hide in encrypted vaults, it would show ciphertext names
  // (docs/superpowers/plans/2026-10-20-enc-e4-encrypted-vault-ui.md).
  const reveal: [string, () => void] = [
    t(revealKey()),
    () =>
      void entryReveal(node.path).then((r) => {
        if (!r.ok) useToastStore.getState().push({ message: errorMessage(r.error), tone: 'error' });
      }),
  ];
  // The Archive is read-only (M5b round 2): open, unarchive, sort or trash.
  const archived = isArchived(node.path);
  const actions: [string, () => void][] = archived
    ? [
        ...(node.kind === 'folder'
          ? []
          : [[t('menu.open'), () => void openPage(node.path)] as [string, () => void]]),
        [t('menu.unarchive'), () => void restoreItem('archive', node.path)],
        reveal,
        [t('menu.sortBy'), () => setSorting(true)],
        [t('menu.delete'), () => requestTrash(node.path)],
      ]
    : [
        [t('menu.newPage'), () => void vault().createPage(dir)],
        [t('menu.newFolder'), () => void vault().createFolder(dir)],
        [t('shell.newScratchpad', { name: vault().info?.name ?? '' }), () => void newQuickNote()],
        ...(node.kind === 'page'
          ? [
              [t('menu.addSubPage'), () => void vault().addSubPage(node.path)] as [
                string,
                () => void,
              ],
            ]
          : []),
        ...folderPage,
        [t('menu.rename'), () => vault().startRename(node.path)],
        [t('menu.move'), () => useUiStore.getState().openDialog({ type: 'move', path: node.path })],
        reveal,
        ...(node.kind === 'attachment'
          ? []
          : [[t('menu.icon'), () => setPicking(true)] as [string, () => void]]),
        [t('menu.sortBy'), () => setSorting(true)],
        [t('menu.archive'), () => void archiveItem(node.path)],
        [t('menu.delete'), () => requestTrash(node.path)],
        // The vault's home: a page (a folder's own page) or a text file.
        ...(offersHome &&
        (page || node.kind === 'page' || (node.kind === 'attachment' && isTextPath(node.path)))
          ? [
              [
                t(homePage === target ? 'home.removePage' : 'home.setPage'),
                () => void toggleHomePage(target),
              ] as [string, () => void],
            ]
          : []),
        // Favorites (M5b §19): pages and folders; a favorite also moves in the list.
        ...favoriteActions(target, page ? 'page' : node.kind, favorites, t),
      ];

  const sortIndex = actions.findIndex(([label]) => label === t('menu.sortBy'));
  if (sorting) {
    const vault = useVaultStore.getState();
    const folder = vault.children.get(parentOf(dir))?.find((n) => n.path === dir);
    const name =
      dir === '.archive'
        ? t('bin.archived')
        : folder && dir
          ? displayName(folder, extensions)
          : (vault.info?.name ?? '');
    return (
      <SortMenu
        path={dir}
        name={name}
        anchor={menu.anchor}
        onClose={onClose}
        onBack={() => {
          setActive(sortIndex);
          setSorting(false);
        }}
      />
    );
  }

  if (picking) {
    const kind = node.kind === 'folder' && !page ? 'folder' : 'page';
    const iconOf = page ? children.get(node.path)?.find((n) => n.path === page)?.icon : node.icon;
    return (
      <EmojiPicker
        anchor={() => ({ top: menu.anchor.y, bottom: menu.anchor.y, left: menu.anchor.x })}
        label={t('icons.pickFor', { name: displayName(node, extensions) })}
        hasIcon={!!iconOf}
        onClose={onClose}
        onPick={(emoji) => {
          onClose();
          void setIcon({ kind, path: target }, emoji);
        }}
      />
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % actions.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + actions.length) % actions.length);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(actions.length - 1);
    else if (e.key === 'ArrowRight' && document.activeElement === items.current[sortIndex]) {
      setActive(sortIndex);
      setSorting(true);
    } else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={box}
      role="menu"
      aria-label={t('menu.label', { name: displayName(node, extensions) })}
      className="liber-menu"
      style={{ position: 'fixed', left: place.left, top: place.top }}
      onKeyDown={onKeyDown}
    >
      {actions.map(([label, run], i) => (
        <button
          key={label}
          ref={(el) => {
            items.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onMouseMove={() => setActive(i)}
          aria-haspopup={i === sortIndex ? 'menu' : undefined}
          onClick={() => {
            if (label !== t('menu.icon') && i !== sortIndex) onClose();
            run();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function favoriteActions(
  path: string,
  kind: string,
  favorites: string[],
  t: (key: string) => string,
): [string, () => void][] {
  if (kind === 'attachment') return [];
  const toggle = () => void useFavoritesStore.getState().toggle(path);
  if (!favorites.includes(path)) return [[t('favorites.add'), toggle]];
  const shown = shownFavorites(favorites, useVaultStore.getState().nodes).map((n) => n.path);
  const i = shown.indexOf(path);
  return [
    [t('favorites.remove'), toggle],
    ...(i > 0
      ? [[t('favorites.moveUp'), () => nudgeFavorite(path, -1)] as [string, () => void]]
      : []),
    ...(i >= 0 && i < shown.length - 1
      ? [[t('favorites.moveDown'), () => nudgeFavorite(path, 1)] as [string, () => void]]
      : []),
  ];
}
