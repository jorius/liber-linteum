// Global View edges (M3a §6): lines between card borders ("floating" edges),
// one style per kind so they differ by more than colour. M4b part 3 §5 made
// them differ in shape too: parent/child lines are thin, solid and orthogonal
// (an org chart's elbows); links are straight; links from inside folders are
// long dashes with a count chip.
//
// All edges are one SVG layer under the cards, drawn by this module rather
// than as React Flow edges (final review I2): level 0 of the 10k reference
// vault has ~2,600 aggregated edges, and React Flow's per-edge wrapper (an
// <svg>, several store subscriptions, an HTML count label each) took
// 1.5–2.5 s to render in WebKit, against NFR-03's 300 ms. Edges are
// decorative for screen readers (each card's description lists its
// connections), so the layer is aria-hidden.
import { useStore, ViewportPortal, type Node, type ReactFlowState } from '@xyflow/react';
import { memo, useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { GvCard } from '../../ipc';
import { pageOf } from './gvStore';
import { CARD_H, CARD_W, type XY } from './layout';
import styles from './GlobalView.module.css';

export type GvEdgeKind = 'link' | 'manual' | 'tree';

/** An edge to draw between two cards on the canvas. */
export interface DrawnEdge {
  id: string;
  source: string;
  target: string;
  kind: GvEdgeKind;
  aggregated: boolean;
  directed: boolean;
  count: number;
  label: string | null;
  /** A parent/child line's routing, when not the layer's (the atoms map). */
  route?: TreeRoute;
}

/** Gap between a card's border and its edges' ends (prototype: 5 px). */
const GAP = 5;
const LABEL_CHARS = 24;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the line from `box`'s centre towards `to` leaves the box, `GAP`
 *  further out. */
export function exitPoint(box: Box, to: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );
  const len = Math.hypot(dx, dy);
  return { x: cx + dx * scale + (dx / len) * GAP, y: cy + dy * scale + (dy / len) * GAP };
}

const STROKES: Record<string, { stroke: string; width: number; dash?: string; opacity?: number }> =
  {
    link: { stroke: 'var(--color-edge-link)', width: 2 },
    'link-aggregated': { stroke: 'var(--color-edge-link)', width: 3, dash: '10 6' },
    tree: { stroke: 'var(--color-edge-tree)', width: 1.25, opacity: 0.7 },
    manual: { stroke: 'var(--color-edge-manual)', width: 3 },
    'manual-aggregated': { stroke: 'var(--color-edge-manual)', width: 3, dash: '12 6' },
  };

/** Drawing order: parent/child lowest, manual relationships on top. */
const STYLE_KEYS = ['tree', 'link-aggregated', 'link', 'manual-aggregated', 'manual'];

const styleKey = (kind: GvEdgeKind, aggregated: boolean) =>
  kind !== 'tree' && aggregated ? `${kind}-aggregated` : kind;

export function strokeOf(kind: GvEdgeKind, aggregated: boolean) {
  return STROKES[styleKey(kind, aggregated)];
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const r = (n: number) => Math.round(n * 100) / 100;

/** The straight line between two cards' borders. */
function line(a: Box, b: Box) {
  return { s: exitPoint(a, centre(b)), t: exitPoint(b, centre(a)) };
}

/** Which way a tree grows: Expand in place puts children in the column to
 *  the right (`h`), the atoms map its section columns below the page (`v`). */
export type TreeOrientation = 'h' | 'v';
/** `l`: children stacked below and indented hang off a trunk down the
 *  parent's left side (the atoms map's blocks under their section). */
export type TreeRoute = TreeOrientation | 'l';

/** Where a trunk runs, from the parent's left edge. */
export const TRUNK = 16;

/** A parent/child line (M4b part 3 §5): orthogonal, out of the parent's side
 *  facing the child and into the child's facing side — right–down–right for
 *  a tree growing sideways, down–across–down for one growing down (or
 *  whichever the cards' places allow once dragged). Siblings share the
 *  trunk, so a family reads at a glance among straight links. Overlapping
 *  cards fall back to a straight line. */
export function elbowPath(a: Box, b: Box, prefer: TreeRoute = 'h'): string {
  const ca = centre(a);
  const cb = centre(b);
  if (prefer === 'l' && b.x >= a.x + TRUNK + GAP && b.y >= a.y + a.h) {
    return `M${r(a.x + TRUNK)},${r(a.y + a.h + GAP)}V${r(cb.y)}H${r(b.x - GAP)}`;
  }
  const apartX = b.x >= a.x + a.w || b.x + b.w <= a.x;
  const apartY = b.y >= a.y + a.h || b.y + b.h <= a.y;
  if (apartY && (prefer !== 'h' || !apartX)) {
    const down = b.y >= a.y + a.h;
    const sy = down ? a.y + a.h + GAP : a.y - GAP;
    const ty = down ? b.y - GAP : b.y + b.h + GAP;
    const mid = (sy + ty) / 2;
    return `M${r(ca.x)},${r(sy)}V${r(mid)}H${r(cb.x)}V${r(ty)}`;
  }
  if (apartX) {
    const right = b.x >= a.x + a.w;
    const sx = right ? a.x + a.w + GAP : a.x - GAP;
    const tx = right ? b.x - GAP : b.x + b.w + GAP;
    const mid = (sx + tx) / 2;
    return `M${r(sx)},${r(ca.y)}H${r(mid)}V${r(cb.y)}H${r(tx)}`;
  }
  return `M${r(ca.x)},${r(ca.y)}L${r(cb.x)},${r(cb.y)}`;
}

interface EndsProps {
  /** Card positions (top left). The same objects while a card stays put,
   *  so an edge redraws only when one of its cards moved. */
  from: XY;
  to: XY;
  /** Card sizes: cards are 240 × 300; atoms (§6) are smaller. */
  fw: number;
  fh: number;
  tw: number;
  th: number;
}

const boxes = ({ from, to, fw, fh, tw, th }: EndsProps): [Box, Box] => [
  { x: from.x, y: from.y, w: fw, h: fh },
  { x: to.x, y: to.y, w: tw, h: th },
];

/** Each drawn piece names its two cards, for focus mode (`focusEdges`). */
interface Ends {
  a: string;
  b: string;
}

const EdgeLine = memo(function EdgeLine({
  styleKey: key,
  directed,
  orient,
  a: na,
  b: nb,
  ...ends
}: EndsProps & Ends & { styleKey: string; directed: boolean; orient: TreeRoute }) {
  const [a, b] = boxes(ends);
  if (key === 'tree') {
    return <path d={elbowPath(a, b, orient)} data-gv-edge={key} data-a={na} data-b={nb} />;
  }
  const { s, t } = line(a, b);
  const angle = Math.atan2(t.y - s.y, t.x - s.x);
  const head = (k: number) =>
    `${t.x - 11 * Math.cos(angle) + k * 6 * Math.sin(angle)},${t.y - 11 * Math.sin(angle) - k * 6 * Math.cos(angle)}`;
  return (
    <>
      <path d={`M${s.x},${s.y}L${t.x},${t.y}`} data-gv-edge={key} data-a={na} data-b={nb} />
      {directed && (
        <path
          className={styles.edgeArrow}
          d={`M${t.x},${t.y}L${head(1)}L${head(-1)}Z`}
          data-gv-arrow=""
          data-a={na}
          data-b={nb}
        />
      )}
    </>
  );
});

/** A chip's width for `text` (11 px semibold body font), padding included. */
export function chipWidth(text: string): number {
  return Math.round(text.length * 6.6 + 14);
}

const EdgeLabel = memo(function EdgeLabel({
  text,
  title,
  a: na,
  b: nb,
  ...ends
}: EndsProps & Ends & { text: string; title: string | null }) {
  const [a, b] = boxes(ends);
  const { s, t } = line(a, b);
  const x = (s.x + t.x) / 2;
  const y = (s.y + t.y) / 2;
  const w = chipWidth(text);
  // The layer ignores the pointer; a label with a title takes it, so the
  // tooltip shows, and is `nopan`, so pressing on it doesn't pan.
  return (
    <>
      <rect
        x={x - w / 2}
        y={y - 9}
        width={w}
        height={18}
        rx={9}
        className={styles.chip}
        data-gv-chip=""
        data-a={na}
        data-b={nb}
      />
      <text
        x={x}
        y={y}
        className={title ? `${styles.titled} nopan` : undefined}
        data-gv-count=""
        data-a={na}
        data-b={nb}
      >
        {title && <title>{title}</title>}
        {text}
      </text>
    </>
  );
});

/** A manual relationship's label (≤ 24 chars shown) and the number of links
 *  an edge stands for (M4b part 3 §5: "12 links"), as drawn at the edge's
 *  midpoint. `words` says a count in words for the edge's kind. */
export function labelOf(
  edge: DrawnEdge,
  words: (count: number, kind: GvEdgeKind) => string,
): string | null {
  const label = edge.kind === 'manual' ? edge.label : null;
  const shown = label && label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
  const badge = edge.count > 1 ? words(edge.count, edge.kind) : null;
  return [shown, badge].filter(Boolean).join(' · ') || null;
}

/** Focus mode (M4b part 3 §5): with `path` hovered or focused, its edges and
 *  the cards at their other ends are marked `data-gv-hot` and `root` gets
 *  `data-gv-focusing`, so CSS dims everything else; `null` lights everything
 *  again. Attributes only — no React render, no layout — so it stays cheap
 *  with thousands of edges. */
export function focusEdges(root: HTMLElement, path: string | null): void {
  for (const el of root.querySelectorAll('[data-gv-hot]')) el.removeAttribute('data-gv-hot');
  if (path === null) {
    root.removeAttribute('data-gv-focusing');
    return;
  }
  const near = new Set([path]);
  for (const el of root.querySelectorAll('[data-a], [data-b]')) {
    const a = el.getAttribute('data-a');
    const b = el.getAttribute('data-b');
    if (a !== path && b !== path) continue;
    el.setAttribute('data-gv-hot', '');
    if (a) near.add(a);
    if (b) near.add(b);
  }
  for (const node of root.querySelectorAll<HTMLElement>('.react-flow__node')) {
    if (near.has(node.dataset.id ?? '')) node.setAttribute('data-gv-hot', '');
  }
  root.setAttribute('data-gv-focusing', '');
}

/** How much longer dash patterns are drawn when zoomed out, so a dotted
 *  line keeps its on-screen rhythm instead of becoming thousands of
 *  sub-pixel dashes per line (stroking dashes is what WebKit spends its time
 *  on: ~2,600 dotted lines took ~0.5 s per paint at fit zoom). Steps of √2,
 *  so a pinch doesn't restyle every frame. */
export function dashScale(zoom: number): number {
  if (!(zoom > 0) || zoom >= 1) return 1;
  return Math.SQRT2 ** Math.round(Math.log2(1 / zoom) * 2);
}

const scaled = (dash: string | undefined, k: number) =>
  dash && k !== 1
    ? dash
        .split(' ')
        .map((d) => Number(d) * k)
        .join(' ')
    : dash;

const zoomOf = (s: ReactFlowState) => s.transform[2];
const nodesOf = (s: ReactFlowState) => s.nodes;

/** At most this many aggregated edges are drawn on one canvas, the
 *  strongest (highest count) first (final review I2). Level 0 of the 10k
 *  reference vault has ~2,200 aggregated pairs: past a few hundred dotted
 *  lines the view is a tangle, and WebKit's dash stroking alone blew
 *  NFR-03's 300 ms. Direct links and parent/child edges are never capped. */
export const MAX_AGGREGATED = 500;

/** The edges to draw: every direct edge plus the `max` strongest aggregated
 *  ones (ties keep their order), and how many aggregated edges were left out. */
export function strongest(edges: DrawnEdge[], max = MAX_AGGREGATED) {
  const aggregated = edges.filter((e) => e.aggregated);
  if (aggregated.length <= max) return { edges, aggregated: aggregated.length, hidden: 0 };
  const kept = new Set(
    aggregated
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.count - a.e.count || a.i - b.i)
      .slice(0, max)
      .map(({ e }) => e),
  );
  return {
    edges: edges.filter((e) => !e.aggregated || kept.has(e)),
    aggregated: aggregated.length,
    hidden: aggregated.length - max,
  };
}

export interface EdgeLayerProps {
  edges: DrawnEdge[];
  /** A direct relationship edge was clicked (M3b §3): the pages its two
   *  cards stand for (a page card itself, a folder card its index note;
   *  final review I3). */
  onRelations?: (a: string, b: string) => void;
  /** How parent/child lines leave their parent (default: sideways). */
  tree?: TreeOrientation;
}

/** The page a card node stands for in a relationship (M3b §2). */
const pageOfNode = (n: Node): string | null => {
  const card = (n.data as { card?: GvCard } | undefined)?.card;
  return card ? pageOf(card) : null;
};

/** A wide, invisible stroke over a direct relationship that takes the
 *  pointer (the layer itself ignores it); `nopan`, so pressing on it doesn't
 *  pan the canvas. Its props are plain values and the layer's one callback,
 *  so it redraws only when one of its cards moved (final review m16). */
const EdgeHit = memo(function EdgeHit({
  pa,
  pb,
  onRelations,
  ...ends
}: EndsProps & { pa: string; pb: string; onRelations: (a: string, b: string) => void }) {
  const [a, b] = boxes(ends);
  const { s, t } = line(a, b);
  return (
    <path
      className={`${styles.edgeHit} nopan`}
      d={`M${s.x},${s.y}L${t.x},${t.y}`}
      data-gv-hit=""
      onClick={() => onRelations(pa, pb)}
    />
  );
});

interface Size {
  w: number;
  h: number;
}

/** Every edge of the canvas, in the viewport under the cards: one group per
 *  style (strokes inherit), count chips and labels on top. Card positions
 *  come from React Flow's store, so edges appear with their cards and follow
 *  a drag; a card that stays put keeps its position object, so only a moved
 *  card's edges redraw. */
export const EdgeLayer = memo(function EdgeLayer({
  edges,
  onRelations,
  tree = 'h',
}: EdgeLayerProps) {
  const { t } = useTranslation();
  const nodes = useStore(nodesOf);
  const positions = useMemo(
    () => new Map<string, XY>(nodes.map((n) => [n.id, n.position])),
    [nodes],
  );
  const sizes = useMemo(
    () =>
      new Map<string, Size>(
        nodes.map((n) => [n.id, { w: n.width ?? CARD_W, h: n.height ?? CARD_H }]),
      ),
    [nodes],
  );
  const pages = useMemo(
    () => new Map<string, string | null>(nodes.map((n) => [n.id, pageOfNode(n)])),
    [nodes],
  );
  const groups = useMemo(() => {
    const out = new Map<string, DrawnEdge[]>(STYLE_KEYS.map((k) => [k, []]));
    for (const e of edges) out.get(styleKey(e.kind, e.aggregated))!.push(e);
    return out;
  }, [edges]);
  const k = dashScale(useStore(zoomOf));
  const labelled = useMemo(() => {
    const words = (count: number, kind: GvEdgeKind) =>
      t(kind === 'manual' ? 'gv.chip.relationships' : 'gv.chip.links', { count });
    return edges.flatMap((e) => {
      const text = labelOf(e, words);
      return text ? [{ e, text }] : [];
    });
  }, [edges, t]);
  /** Both ends' positions and sizes, or null when a card isn't drawn. */
  const endsOf = (e: DrawnEdge): EndsProps | null => {
    const from = positions.get(e.source);
    const to = positions.get(e.target);
    const fs = sizes.get(e.source);
    const ts = sizes.get(e.target);
    if (!from || !to || !fs || !ts) return null;
    return { from, to, fw: fs.w, fh: fs.h, tw: ts.w, th: ts.h };
  };
  return (
    <ViewportPortal>
      <svg className={styles.edges} aria-hidden="true">
        {STYLE_KEYS.map((key) => {
          const s = STROKES[key];
          // `--w` lets focus mode widen a lit line by a pixel (CSS).
          const style = {
            color: s.stroke,
            strokeWidth: s.width,
            strokeDasharray: scaled(s.dash, k),
            opacity: s.opacity,
            '--w': `${s.width}px`,
          } as CSSProperties;
          return (
            <g key={key} style={style}>
              {groups.get(key)!.map((e) => {
                const ends = endsOf(e);
                if (!ends) return null;
                return (
                  <EdgeLine
                    key={e.id}
                    {...ends}
                    a={e.source}
                    b={e.target}
                    styleKey={key}
                    directed={e.directed}
                    orient={e.route ?? tree}
                  />
                );
              })}
            </g>
          );
        })}
        {onRelations && (
          <g>
            {edges.map((e) => {
              if (e.kind !== 'manual' || e.aggregated) return null;
              const ends = endsOf(e);
              const a = pages.get(e.source);
              const b = pages.get(e.target);
              if (!ends || !a || !b) return null;
              return <EdgeHit key={e.id} {...ends} pa={a} pb={b} onRelations={onRelations} />;
            })}
          </g>
        )}
        <g className={styles.edgeLabels}>
          {labelled.map(({ e, text }) => {
            const ends = endsOf(e);
            if (!ends) return null;
            return (
              <EdgeLabel
                key={e.id}
                {...ends}
                a={e.source}
                b={e.target}
                text={text}
                title={e.kind === 'manual' ? e.label : null}
              />
            );
          })}
        </g>
      </svg>
    </ViewportPortal>
  );
});
