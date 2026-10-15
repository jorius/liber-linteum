import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { AudioIcon, FolderIcon, GripIcon, ImageIcon, LinkIcon } from '../../app/icons';
import { assetUrl, type GvCard } from '../../ipc';
import { nameOf } from '../../stores/tree';
import { CardMenu, type CardMenuItem } from './CardMenu';
import { BriefcaseIcon, EditIcon, FolderSmallIcon, PageIcon, StackIcon } from './gvIcons';
import styles from './Card.module.css';

/** A single click waits this long for a second one (prototype; M3a §5), so
 *  a double click never also opens the next level. */
export const SINGLE_CLICK_MS = 240;

export interface CardProps {
  card: GvCard;
  /** Accent ring: the card this level was opened from, or an expanded card. */
  open: boolean;
  /** Roving tabindex (GV-18): only one card is in the Tab order. */
  focusable: boolean;
  /** Its edges in plain words, for screen readers (M3a §6). */
  connections: string;
  /** The connect button's menu (M3b §3); none: no button. */
  menu?: CardMenuItem[];
  /** Connect mode starts from this card (M3b §2): manual-colour ring. */
  connecting?: boolean;
  /** Wraps the connect button (the canvas makes it a drag-to-connect
   *  handle, M3b §2). */
  wrapConnect?: (button: ReactElement) => ReactNode;
  /** Single click / Enter: the next level (GV-11). */
  onOpen: () => void;
  /** Double click / Shift+Enter / See all: the editor (GV-12). */
  onOpenEditor: () => void;
  onFocus: () => void;
}

/** One Global View card (M3a §4, prototype `.card`). */
export function Card({
  card,
  open,
  focusable,
  connections,
  menu = [],
  connecting = false,
  wrapConnect = (button) => button,
  onOpen,
  onOpenEditor,
  onFocus,
}: CardProps) {
  const { t } = useTranslation();
  const descId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const kind = t(`gv.kind.${card.kind}`);
  const label =
    card.kind !== 'page' && card.indexPage
      ? t('gv.kindWithName', { kind, name: nameOf(card.path) })
      : kind;
  const summary = card.kind !== 'page' && !card.indexPage;
  const side = card.coverSide ?? 'top';

  const click = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onOpen();
    }, SINGLE_CLICK_MS);
  };
  const doubleClick = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onOpenEditor();
  };
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.shiftKey) onOpenEditor();
      else onOpen();
    }
  };

  let cover;
  if (card.cover) {
    cover = (
      <img
        className={styles.image}
        src={assetUrl(card.cover)}
        alt=""
        loading="lazy"
        draggable={false}
        style={{ objectPosition: `${card.coverX ?? 50}% ${card.coverY ?? 50}%` }}
      />
    );
  } else if (summary) {
    cover = (
      <span className={styles.summary}>
        <FolderIcon />
        {t('gv.counts', { pages: card.pages, folders: card.folders })}
      </span>
    );
  } else {
    cover = (
      <span className={styles.none}>{t(card.coverRemote ? 'gv.remoteCover' : 'gv.noCover')}</span>
    );
  }

  const KindIcon =
    card.kind === 'page' ? PageIcon : card.kind === 'project' ? BriefcaseIcon : FolderSmallIcon;
  const page = card.kind === 'page';

  return (
    <>
      {/* Folders and projects look like folders (M4b part 3 §4): a tab on the
          top-left edge, outside the card's clipped box. */}
      {!page && <span className={styles.tab} data-gv-tab="" aria-hidden="true" />}
      <div
        className={styles.card}
        data-kind={card.kind}
        data-open={open || undefined}
        data-connecting={connecting || undefined}
        role="group"
        aria-label={t('gv.cardName', { title: card.title, kind: kind.toLocaleLowerCase() })}
      >
        <div className={styles.head}>
          <span className={styles.kind}>
            <span className={styles.kindIcon}>
              <KindIcon />
            </span>
            {label}
          </span>
          <span className={`${styles.grip} gv-grip`} title={t('gv.move')} aria-hidden="true">
            <GripIcon />
          </span>
          {menu.length > 0 &&
            wrapConnect(
              <button
                ref={menuButton}
                type="button"
                className={`${styles.connect} nodrag`}
                tabIndex={focusable ? 0 : -1}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('gv.relations.menu', { title: card.title })}
                title={t('gv.relations.menu', { title: card.title })}
                data-gv-connect={card.path}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <LinkIcon />
              </button>,
            )}
          {menuOpen && menuButton.current && (
            <CardMenu
              label={t('gv.relations.menu', { title: card.title })}
              items={menu}
              anchor={menuButton.current}
              onClose={(refocus) => {
                setMenuOpen(false);
                if (refocus) menuButton.current?.focus();
              }}
            />
          )}
        </div>
        <div
          className={styles.hit}
          // A side cover (M4b part 3 §3): a strip on that side, the text beside it.
          data-cover-side={card.cover && side !== 'top' ? side : undefined}
        >
          <div
            className={`${styles.cover} ${card.cover ? '' : summary ? styles.coverFolder : styles.coverNone}`}
          >
            {cover}
          </div>
          <p className={styles.title}>{card.title}</p>
          {card.subtitle && <p className={styles.subtitle}>{card.subtitle}</p>}
          {card.excerpt && <p className={styles.excerpt}>{card.excerpt}</p>}
          <span id={descId} className={styles.srOnly}>
            {[card.subtitle, card.excerpt, connections].filter(Boolean).join(' ')}
          </span>
          {/* The card's button lies over the whole body and holds no text: its
            name is the title, the rest is its description. Wrapping the text
            made a button named "Alpha" show "No cover Alpha …" (axe
            label-content-name-mismatch, final review m5). */}
          <div
            className={styles.press}
            role="button"
            tabIndex={focusable ? 0 : -1}
            aria-label={card.title}
            aria-describedby={descId}
            data-gv-card={card.path}
            onClick={click}
            onDoubleClick={doubleClick}
            onKeyDown={keyDown}
            onFocus={onFocus}
          />
        </div>
        <div className={styles.foot}>
          {card.hasImage && (
            <span role="img" aria-label={t('gv.hasImage')} className={styles.media}>
              <ImageIcon />
            </span>
          )}
          {card.hasAudio && (
            <span role="img" aria-label={t('gv.hasAudio')} className={styles.media}>
              <AudioIcon />
            </span>
          )}
          {/* M4b part 3 §4: a page is edited; a folder's pages are seen. */}
          <button
            type="button"
            className={styles.seeAll}
            tabIndex={focusable ? 0 : -1}
            aria-label={
              page
                ? t('gv.editLabel', { title: card.title })
                : t('gv.seeAllLabel', { title: card.title })
            }
            onClick={onOpenEditor}
          >
            {page ? <EditIcon /> : <StackIcon />}
            {t(page ? 'gv.edit' : 'gv.seeAll')}
          </button>
        </div>
      </div>
    </>
  );
}
