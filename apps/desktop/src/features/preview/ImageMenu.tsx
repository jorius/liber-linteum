import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { entryReveal, externalReveal } from '../../ipc';
import { errorMessage } from '../../stores/messages';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { revealKey } from '../explorer/reveal';
import { PopupMenu } from './PopupMenu';

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
  const items = [
    { label: t('page.openDefault'), run: () => openImage(image) },
    ...(canReveal ? [{ label: t(revealKey()), run: () => revealImage(image) }] : []),
  ];
  return <PopupMenu label={t('image.menu')} items={items} anchor={anchor} onClose={onClose} />;
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
