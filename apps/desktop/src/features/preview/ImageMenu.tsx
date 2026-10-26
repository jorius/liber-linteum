import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { entryReveal, externalReveal } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { placePopup, windowViewport } from '../editor/placePopup';
import { revealKey } from '../explorer/reveal';

/** An image the app shows: a vault path, or a file outside the vault. */
export interface ShownImage {
  path: string;
  external: boolean;
}

const ASSET = /^(?:liber-asset:\/\/localhost|http:\/\/liber-asset\.localhost)\/(.+)$/;

/** The image an `<img>` shows, read back from its `liber-asset:` URL
 *  (`assetUrl`, `externalAssetUrl`); `null` for anything else. */
export function imageOf(src: string): ShownImage | null {
  const m = ASSET.exec(src);
  if (!m) return null;
  const rest = m[1];
  if (rest.startsWith('.external/')) {
    return { path: decodeURIComponent(rest.slice('.external/'.length)), external: true };
  }
  return { path: rest.split('/').map(decodeURIComponent).join('/'), external: false };
}

/** Asks before opening it in the system's viewer, like any file a note links
 *  to (an encrypted vault's opens as a decrypted copy). */
export function openImage(image: ShownImage) {
  useUiStore
    .getState()
    .openDialog({ type: 'openFile', path: image.path, external: image.external });
}

export function revealImage(image: ShownImage) {
  void (image.external ? externalReveal(image.path) : entryReveal(image.path)).then((r) => {
    if (!r.ok) useToastStore.getState().push({ message: errorMessage(r.error), tone: 'error' });
  });
}

/** Showing an encrypted vault's file in the file manager would show its
 *  ciphertext name, so only outside files offer it there. */
export const useCanReveal = (image: ShownImage) =>
  useVaultStore((s) => image.external || s.info?.encrypted !== true);

/** The right-click menu on an image in a note or the image view (0.1.2). */
export function ImageMenu({
  image,
  anchor,
  onClose,
}: {
  image: ShownImage;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const canReveal = useCanReveal(image);
  const items: [string, () => void][] = [
    [t('page.openDefault'), () => openImage(image)],
    ...(canReveal ? [[t(revealKey()), () => revealImage(image)] as [string, () => void]] : []),
  ];
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: anchor.y, left: anchor.x });
  useLayoutEffect(() => {
    const el = box.current;
    const size = { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
    const { top, left } = placePopup(
      { top: anchor.y, bottom: anchor.y, left: anchor.x },
      size,
      windowViewport(),
    );
    setPlace({ top, left });
  }, [anchor.x, anchor.y]);
  useEffect(() => buttons.current[active]?.focus(), [active]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % items.length);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + items.length) % items.length);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={box}
      role="menu"
      aria-label={t('image.menu')}
      className="liber-menu"
      style={{ position: 'fixed', left: place.left, top: place.top }}
      onKeyDown={onKeyDown}
    >
      {items.map(([label, run], i) => (
        <button
          key={label}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onMouseMove={() => setActive(i)}
          onClick={() => {
            onClose();
            run();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Opens the image menu on a right-click on an image in the editor, the
 *  preview or the image view. It listens first (capture), so a misspelled
 *  word next to the image doesn't take the click. */
export function ImageMenuHost() {
  const [menu, setMenu] = useState<{ image: ShownImage; anchor: { x: number; y: number } } | null>(
    null,
  );
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const img = (e.target as Element | null)?.closest?.('img');
      if (!img?.closest('.cm-editor, [data-preview], [data-image-view]')) return;
      const image = imageOf(img.currentSrc || img.src);
      if (!image) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ image, anchor: { x: e.clientX, y: e.clientY } });
    };
    document.addEventListener('contextmenu', onMenu, true);
    return () => document.removeEventListener('contextmenu', onMenu, true);
  }, []);
  const close = useRef(() => setMenu(null)).current;
  return menu && <ImageMenu image={menu.image} anchor={menu.anchor} onClose={close} />;
}
