import type { Element } from 'hast';
import { assetUrl } from '../../ipc';
import { followLink } from '../../stores/links';
import { nameOf } from '../../stores/tree';
import styles from './Preview.module.css';
import type { RenderCtx } from './renderHast';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']);
const AUDIO = new Set(['wav', 'mp3', 'm4a']);

const extOf = (path: string) => {
  const name = nameOf(path);
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
};

/** `![[…]]` (M2a §4): image, audio, transcluded note, link card, file card or
 *  "Not found". */
export function Embed({ e, ctx, block }: { e: Element; ctx: RenderCtx; block: boolean }) {
  const { t } = ctx;
  const p = e.properties;
  const target = String(p.dataTarget ?? '');
  const heading = typeof p.dataHeading === 'string' ? p.dataHeading : null;
  const resolved = ctx.resolve('embed', target);
  if (resolved === undefined) {
    return <span className={styles.pending}>{t('preview.loading')}</span>;
  }
  if (resolved === null) {
    const ext = extOf(target);
    return (
      <span className={styles.card}>
        <span>{t('preview.notFound', { target })}</span>
        {(ext === '' || ext === 'md') && (
          <button
            type="button"
            className={styles.cardButton}
            onClick={() =>
              followLink({
                type: 'page',
                kind: 'embed',
                target,
                heading,
                resolved: null,
                source: ctx.path,
              })
            }
          >
            {t('preview.createPage')}
          </button>
        )}
      </span>
    );
  }
  const ext = extOf(resolved);
  if (IMAGE.has(ext)) {
    return (
      <img
        className={styles.embedImage}
        src={assetUrl(resolved)}
        alt={target}
        width={p.dataWidth === undefined ? undefined : Number(p.dataWidth)}
        height={p.dataHeight === undefined ? undefined : Number(p.dataHeight)}
        loading="lazy"
      />
    );
  }
  if (AUDIO.has(ext)) {
    return (
      <audio
        className={styles.embedAudio}
        controls
        src={assetUrl(resolved)}
        aria-label={nameOf(resolved)}
      />
    );
  }
  if (ext === 'md') {
    if (ctx.chain.includes(resolved)) {
      return <span className={styles.card}>{t('preview.cycle')}</span>;
    }
    if (!block || ctx.depth > 0) {
      const label = heading ? `${target} › ${heading}` : target;
      return (
        <a
          href="#"
          className={styles.linkCard}
          data-state="resolved"
          onClick={(ev) => {
            ev.preventDefault();
            followLink({
              type: 'page',
              kind: 'embed',
              target,
              heading,
              resolved,
              source: ctx.path,
            });
          }}
        >
          {label}
        </a>
      );
    }
    return ctx.renderNote(resolved, heading);
  }
  return (
    <span className={styles.card}>
      <span className={styles.fileName}>{nameOf(resolved)}</span>
      <button
        type="button"
        className={styles.cardButton}
        onClick={() => followLink({ type: 'file', path: resolved })}
      >
        {t('preview.openInApp')}
      </button>
    </span>
  );
}
