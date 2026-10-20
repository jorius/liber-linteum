import type { Element, ElementContent, Properties, Root } from 'hast';
import type { TFunction } from 'i18next';
import { createElement, type MouseEvent, type ReactNode } from 'react';
import { assetUrl } from '../../ipc';
import { followLink, followOutside } from '../../stores/links';
import { Callout } from './Callout';
import { MathView } from './MathView';
import { MermaidView } from './MermaidView';
import { CodeBlock } from './CodeBlock';
import { Embed } from './Embed';
import { TableScroll } from './TableScroll';
import styles from './Preview.module.css';
import type { Resolve } from './useResolved';
import type { ExternalLookup } from './useExternal';
import { safeDecode } from '../../markdown/decode';
import { looksExternal } from '../../markdown/externalPath';
import { ExternalEmbed, WithDiskPath } from './ExternalFile';

export interface RenderCtx {
  /** Page being rendered. */
  path: string;
  /** 0 = the page itself, 1+ = inside a note embed. */
  depth: number;
  /** Pages on the embed path, outermost first (cycle detection). */
  chain: string[];
  resolve: Resolve;
  /** Outside files that links name (M4b part 3 §9). */
  external: ExternalLookup;
  t: TFunction;
  /** Transcludes a note (provided by Preview, which renders it recursively). */
  renderNote: (path: string, heading: string | null) => ReactNode;
  /** Accessible name for a task checkbox (the list item's text). */
  taskLabel?: string;
  /** Source offset of the task list item being rendered. */
  taskAt?: number;
  /** Toggles the task whose list item starts at the offset (the page's own
   *  editor); without it checkboxes are read-only. */
  toggleTask?: (at: number) => void;
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'source']);

const kebab = (s: string) =>
  s.replace(/[A-Z]/g, (c, i: number) => (i ? '-' : '') + c.toLowerCase());

/** hast properties → React props (`className` arrays, `dataFoo` → `data-foo`). */
export function reactProps(p: Properties): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue;
    if (k === 'className') out.className = Array.isArray(v) ? v.join(' ') : String(v);
    else if (/^data[A-Z]/.test(k)) out[`data-${kebab(k.slice(4))}`] = String(v);
    else out[k] = v;
  }
  return out;
}

export function textOf(n: ElementContent | Root): string {
  if (n.type === 'text') return n.value;
  if (n.type === 'element' || n.type === 'root')
    return n.children.map((c) => textOf(c as ElementContent)).join('');
  return '';
}

const click = (run: () => void) => (e: MouseEvent) => {
  e.preventDefault();
  run();
};

/** A paragraph holding nothing but one embed renders as a block embed. */
function loneEmbed(e: Element): Element | null {
  const els = e.children.filter((c) => c.type === 'element');
  const rest = e.children.filter((c) => c.type === 'text' && c.value.trim());
  return els.length === 1 && !rest.length && els[0].properties.dataLiber === 'embed'
    ? els[0]
    : null;
}

function pageLink(e: Element, key: number, ctx: RenderCtx): ReactNode {
  const p = e.properties;
  const kind = p.dataLiber === 'wikilink' ? 'wiki' : 'markdown';
  const target = typeof p.dataTarget === 'string' ? p.dataTarget : '';
  const heading = typeof p.dataHeading === 'string' ? p.dataHeading : null;
  let resolved = target ? ctx.resolve(kind, target) : null;
  // M4b part 3 §9: a file outside the vault, once the vault has no such file.
  const marked = typeof p.dataExternal === 'string' ? p.dataExternal : null;
  const outsideTarget = marked ?? (kind === 'wiki' && looksExternal(target) ? target : null);
  const outside =
    resolved === null && outsideTarget !== null ? ctx.external(kind, outsideTarget) : null;
  if (outside === undefined) resolved = undefined;
  const state =
    resolved === undefined
      ? 'pending'
      : outside
        ? outside.exists || outside.askFirst
          ? 'resolved'
          : 'unresolved'
        : resolved === null
          ? 'unresolved'
          : 'resolved';
  return (
    <a
      key={key}
      href="#"
      className={state === 'unresolved' ? styles.unresolved : styles.link}
      data-liber={p.dataLiber}
      data-state={state}
      title={outside ? outside.path : undefined}
      onClick={click(() => {
        if (resolved === undefined) return;
        if (outside) followOutside(outside);
        else if (!target && heading) followLink({ type: 'anchor', heading });
        else if (target || !marked) {
          followLink({ type: 'page', kind, target, heading, resolved, source: ctx.path });
        }
      })}
    >
      {renderChildren(e, ctx)}
    </a>
  );
}

/** A Markdown image naming a file outside the vault (M4b part 3 §9). With a
 *  leading `/` it is a vault file first (`asset`), else the file on disk. */
function OutsideImage({
  e,
  target,
  asset,
  ctx,
}: {
  e: Element;
  target: string;
  asset: string | null;
  ctx: RenderCtx;
}) {
  const p = e.properties;
  const alt = String(p.alt ?? '');
  const outside = ctx.external('markdown_image', target);
  if (outside) {
    const size = (v: unknown) => (v === undefined ? undefined : Number(v));
    return <ExternalEmbed file={outside} alt={alt} width={size(p.width)} height={size(p.height)} />;
  }
  if (outside === undefined)
    return <span className={styles.pending}>{ctx.t('preview.loading')}</span>;
  if (asset) {
    return (
      <WithDiskPath vaultPath={asset}>
        <img {...reactProps(p)} src={assetUrl(asset)} alt={alt} loading="lazy" />
      </WithDiskPath>
    );
  }
  return (
    <span className={styles.card}>{ctx.t('preview.notFound', { target: alt || target })}</span>
  );
}

function renderElement(e: Element, key: number, ctx: RenderCtx): ReactNode {
  const p = e.properties;
  const { t } = ctx;
  switch (p.dataLiber) {
    case 'math':
      return (
        <MathView key={key} tex={String(p.dataTex ?? '')} display={p.dataDisplay === 'block'} />
      );
    case 'wikilink':
    case 'link':
      return pageLink(e, key, ctx);
    case 'external': {
      const url = String(p.href ?? '');
      return (
        <a
          key={key}
          href="#"
          className={styles.link}
          data-liber="external"
          title={url}
          onClick={click(() => followLink({ type: 'external', url }))}
        >
          {renderChildren(e, ctx)}
          <span aria-hidden="true" className={styles.externalIcon}>
            ↗
          </span>
        </a>
      );
    }
    case 'anchor': {
      const heading = safeDecode(String(p.href ?? '').slice(1));
      return (
        <a
          key={key}
          href="#"
          className={styles.link}
          data-liber="anchor"
          onClick={click(() => followLink({ type: 'anchor', heading }))}
        >
          {renderChildren(e, ctx)}
        </a>
      );
    }
    case 'embed':
      return <Embed key={key} e={e} ctx={ctx} block={false} />;
    case 'remote-blocked':
      return (
        <span key={key} className={styles.remote} title={String(p.dataUrl ?? '')}>
          {t('preview.remoteBlocked')}
        </span>
      );
    case 'missing':
      return (
        <span key={key} className={styles.card}>
          {t('preview.notFound', { target: String(p.alt ?? p.src ?? '') })}
        </span>
      );
    case 'callout': {
      const head = e.children.find((c) => c.type === 'element');
      const title =
        head?.type === 'element' && head.properties.dataLiber === 'callout-title' ? head : null;
      const body = title ? { ...e, children: e.children.filter((c) => c !== title) } : e;
      return (
        <Callout
          key={key}
          e={e}
          props={reactProps(p)}
          title={title ? renderChildren(title, ctx) : null}
        >
          {renderChildren(body, ctx)}
        </Callout>
      );
    }
    case 'columns': {
      const count = e.children.filter((c) => c.type === 'element').length;
      return (
        <div key={key} className={styles.columns} {...reactProps(p)}>
          <div className={styles.columnsGrid} style={{ ['--columns' as string]: count }}>
            {renderChildren(e, ctx)}
          </div>
        </div>
      );
    }
    case 'column':
      return (
        <div key={key} className={styles.column} {...reactProps(p)}>
          {renderChildren(e, ctx)}
        </div>
      );
    case 'tag':
      return (
        <span key={key} className={styles.tag} {...reactProps(p)}>
          {renderChildren(e, ctx)}
        </span>
      );
  }
  if (e.tagName === 'table') {
    return (
      <TableScroll key={key}>
        {createElement('table', reactProps(p), renderChildren(e, ctx))}
      </TableScroll>
    );
  }
  if (e.tagName === 'pre' && p.dataLang === 'mermaid') {
    return <MermaidView key={key} source={hastText(e).replace(/\n$/, '')} />;
  }
  if (e.tagName === 'pre') {
    const lang = typeof p.dataLang === 'string' ? p.dataLang : undefined;
    return (
      <CodeBlock key={key} lang={lang} code={hastText(e)}>
        {createElement('pre', reactProps(p), renderChildren(e, ctx))}
      </CodeBlock>
    );
  }
  if (e.tagName === 'p') {
    const embed = loneEmbed(e);
    if (embed) {
      return (
        <div key={key} className={styles.block} {...reactProps(p)}>
          <Embed e={embed} ctx={ctx} block />
        </div>
      );
    }
  }
  const asset = typeof p.dataAssetPath === 'string' ? p.dataAssetPath : null;
  if (e.tagName === 'img') {
    if (typeof p.dataExternal === 'string') {
      return <OutsideImage key={key} e={e} target={p.dataExternal} asset={asset} ctx={ctx} />;
    }
    if (!asset && typeof p.src !== 'string') return null;
    const img = (
      <img
        key={key}
        {...reactProps(p)}
        src={asset ? assetUrl(asset) : String(p.src)}
        alt={String(p.alt ?? '')}
        loading="lazy"
      />
    );
    return asset ? (
      <WithDiskPath key={key} vaultPath={asset}>
        {img}
      </WithDiskPath>
    ) : (
      img
    );
  }
  if (asset && (e.tagName === 'audio' || e.tagName === 'video' || e.tagName === 'source')) {
    return createElement(e.tagName, {
      key,
      ...reactProps(p),
      src: assetUrl(asset),
      controls: e.tagName === 'source' ? undefined : true,
    });
  }
  if (e.tagName === 'input') {
    const { toggleTask, taskAt } = ctx;
    const editable = toggleTask && ctx.depth === 0 && taskAt !== undefined;
    return (
      <input
        key={key}
        type="checkbox"
        checked={Boolean(p.checked)}
        disabled={!editable}
        readOnly={!editable}
        onChange={editable ? () => toggleTask(taskAt) : undefined}
        aria-label={ctx.taskLabel}
      />
    );
  }
  if (e.tagName === 'li' && String(p.className ?? '').includes('task-list-item')) {
    const label = textOf(e).trim();
    return createElement(
      'li',
      { key, ...reactProps(p) },
      renderChildren(e, {
        ...ctx,
        taskLabel: label,
        // Sanitized data attributes are strings.
        taskAt: p.dataSourceStart === undefined ? undefined : Number(p.dataSourceStart),
      }),
    );
  }
  return createElement(
    e.tagName,
    { key, ...reactProps(p) },
    VOID.has(e.tagName) ? undefined : renderChildren(e, ctx),
  );
}

export function renderChildren(parent: Root | Element, ctx: RenderCtx): ReactNode[] {
  return parent.children.map((c, i) => {
    if (c.type === 'text') return c.value;
    if (c.type === 'element') return renderElement(c, i, ctx);
    return null;
  });
}

/** The text an element holds (a code block's code, for Copy). */
function hastText(n: Element | ElementContent): string {
  if (n.type === 'text') return n.value;
  if (n.type === 'element') return n.children.map(hastText).join('');
  return '';
}
