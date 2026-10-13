import GithubSlugger from 'github-slugger';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pageRead } from '../../ipc';
import { parsePage } from '../../markdown/parse';
import { toSafeHast } from '../../markdown/sanitize';
import { sectionOf } from '../../markdown/section';
import { openPage } from '../../stores/navigate';
import { usePageStore } from '../../stores/pageStore';
import { nameOf } from '../../stores/tree';
import styles from './Preview.module.css';
import { renderChildren, type RenderCtx } from './renderHast';
import { useDebounced } from './useDebounced';
import { useResolved } from './useResolved';

/** Re-render delay after typing (M2a §4). */
export const RENDER_DEBOUNCE_MS = 150;

export interface PreviewProps {
  text: string;
  /** Vault path of the page (links and assets resolve from it). */
  path: string;
  /** Render only this heading's section (note embeds). */
  heading?: string | null;
  depth?: number;
  chain?: string[];
}

/** The rendered pane (M2a §4): sanitized Markdown with resolved links and embeds. */
export function Preview({ text, path, heading = null, depth = 0, chain = [] }: PreviewProps) {
  const { t } = useTranslation();
  const shown = useDebounced(text, RENDER_DEBOUNCE_MS);
  const tree = useMemo(() => {
    const page = parsePage(shown);
    if (heading) page.tree = sectionOf(page.tree, heading) ?? { type: 'root', children: [] };
    return toSafeHast(page, { sourcePath: path });
  }, [shown, path, heading]);
  const resolve = useResolved(path, tree);
  const anchor = usePageStore((s) => (depth === 0 ? s.anchor : null));
  const box = useRef<HTMLDivElement>(null);

  // Scroll to the heading a link asked for (by slug or by exact id).
  useEffect(() => {
    if (!anchor || !box.current) return;
    const slug = new GithubSlugger().slug(anchor.heading);
    const target = [...box.current.querySelectorAll<HTMLElement>('[id]')].find(
      (el) => el.id === slug || el.id === anchor.heading,
    );
    target?.scrollIntoView?.({ block: 'start' });
  }, [anchor, tree]);

  const ctx: RenderCtx = {
    path,
    depth,
    chain: [...chain, path],
    resolve,
    t,
    renderNote: (note, h) => <NoteEmbed key={`${note}#${h}`} path={note} heading={h} ctx={ctx} />,
  };
  return (
    <div ref={box} className={depth ? styles.nested : styles.content}>
      {renderChildren(tree, ctx)}
    </div>
  );
}

/** True once the element has been scrolled into view (always true without
 *  IntersectionObserver). */
function useInView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, ref]);
  return seen;
}

/** `![[Note]]` / `![[Note#Heading]]`: the note (or section) in a bordered
 *  block with its title and "Open"; loads when scrolled into view. */
function NoteEmbed({
  path,
  heading,
  ctx,
}: {
  path: string;
  heading: string | null;
  ctx: RenderCtx;
}) {
  const { t } = ctx;
  const ref = useRef<HTMLElement>(null);
  const visible = useInView(ref);
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    void pageRead(path).then((res) => {
      if (live) setText(res.ok ? res.value.text : null);
    });
    return () => {
      live = false;
    };
  }, [visible, path]);
  const name = nameOf(path).replace(/\.md$/i, '');
  const title = heading ? `${name} › ${heading}` : name;
  const missing = text === null || (text && heading && !sectionOf(parsePage(text).tree, heading));
  return (
    <section ref={ref} className={styles.noteEmbed} aria-label={title}>
      <header className={styles.noteHeader}>
        <span className={styles.noteTitle}>{title}</span>
        <button
          type="button"
          className={styles.cardButton}
          onClick={() => void openPage(path, heading)}
        >
          {t('preview.open')}
        </button>
      </header>
      {text === undefined ? (
        <p className={styles.pending}>{t('preview.loading')}</p>
      ) : missing ? (
        <p className={styles.card}>{t('preview.notFound', { target: title })}</p>
      ) : (
        <Preview
          text={text ?? ''}
          path={path}
          heading={heading}
          depth={ctx.depth + 1}
          chain={ctx.chain}
        />
      )}
    </section>
  );
}
