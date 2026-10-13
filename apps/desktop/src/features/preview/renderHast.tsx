import type { Element, ElementContent, Properties, Root } from 'hast';
import type { TFunction } from 'i18next';
import { createElement, type MouseEvent, type ReactNode } from 'react';
import { assetUrl } from '../../ipc';
import { followLink } from '../../stores/links';
import { Callout } from './Callout';
import { Embed } from './Embed';
import styles from './Preview.module.css';
import type { Resolve } from './useResolved';
import { safeDecode } from '../../markdown/decode';

export interface RenderCtx {
  /** Page being rendered. */
  path: string;
  /** 0 = the page itself, 1+ = inside a note embed. */
  depth: number;
  /** Pages on the embed path, outermost first (cycle detection). */
  chain: string[];
  resolve: Resolve;
  t: TFunction;
  /** Transcludes a note (provided by Preview, which renders it recursively). */
  renderNote: (path: string, heading: string | null) => ReactNode;
  /** Accessible name for a task checkbox (the list item's text). */
  taskLabel?: string;
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
  return els.length === 1 && !rest.length && els[0].properties.dataNimw === 'embed' ? els[0] : null;
}

function pageLink(e: Element, key: number, ctx: RenderCtx): ReactNode {
  const p = e.properties;
  const kind = p.dataNimw === 'wikilink' ? 'wiki' : 'markdown';
  const target = typeof p.dataTarget === 'string' ? p.dataTarget : '';
  const heading = typeof p.dataHeading === 'string' ? p.dataHeading : null;
  const resolved = target ? ctx.resolve(kind, target) : null;
  const state = resolved === undefined ? 'pending' : resolved === null ? 'unresolved' : 'resolved';
  return (
    <a
      key={key}
      href="#"
      className={state === 'unresolved' ? styles.unresolved : styles.link}
      data-nimw={p.dataNimw}
      data-state={state}
      onClick={click(() => {
        if (resolved === undefined) return;
        if (!target && heading) followLink({ type: 'anchor', heading });
        else followLink({ type: 'page', kind, target, heading, resolved, source: ctx.path });
      })}
    >
      {renderChildren(e, ctx)}
    </a>
  );
}

function renderElement(e: Element, key: number, ctx: RenderCtx): ReactNode {
  const p = e.properties;
  const { t } = ctx;
  switch (p.dataNimw) {
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
          data-nimw="external"
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
          data-nimw="anchor"
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
        head?.type === 'element' && head.properties.dataNimw === 'callout-title' ? head : null;
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
    if (!asset && typeof p.src !== 'string') return null;
    return (
      <img
        key={key}
        {...reactProps(p)}
        src={asset ? assetUrl(asset) : String(p.src)}
        alt={String(p.alt ?? '')}
        loading="lazy"
      />
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
    return (
      <input
        key={key}
        type="checkbox"
        checked={Boolean(p.checked)}
        disabled
        readOnly
        aria-label={ctx.taskLabel}
      />
    );
  }
  if (e.tagName === 'li' && String(p.className ?? '').includes('task-list-item')) {
    const label = textOf(e).trim();
    return createElement(
      'li',
      { key, ...reactProps(p) },
      renderChildren(e, { ...ctx, taskLabel: label }),
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
