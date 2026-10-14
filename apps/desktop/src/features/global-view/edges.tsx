// Global View edges (M3a §6): straight lines between card borders ("floating"
// edges), one style per kind so they differ by more than colour.
//
// All edges are one SVG layer under the cards, drawn by this module rather
// than as React Flow edges (final review I2): level 0 of the 10k reference
// vault has ~2,600 aggregated edges, and React Flow's per-edge wrapper (an
// <svg>, several store subscriptions, an HTML count label each) took
// 1.5–2.5 s to render in WebKit, against NFR-03's 300 ms. Edges are
// decorative for screen readers (each card's description lists its
// connections), so the layer is aria-hidden.
import { useStore, ViewportPortal, type Node, type ReactFlowState } from '@xyflow/react';
import { memo, useMemo } from 'react';
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
}

/** Gap between a card's border and its edges' ends (prototype: 5 px). */
const GAP = 5;
const LABEL_CHARS = 24;

interface Box {
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

const STROKES: Record<string, { stroke: string; width: number; dash?: string }> = {
  link: { stroke: 'var(--color-edge-link)', width: 2 },
  'link-aggregated': { stroke: 'var(--color-edge-link)', width: 2.5, dash: '1 6' },
  tree: { stroke: 'var(--color-edge-tree)', width: 1.5, dash: '6 5' },
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

const card = (at: XY): Box => ({ x: at.x, y: at.y, w: CARD_W, h: CARD_H });
const centre = (at: XY) => ({ x: at.x + CARD_W / 2, y: at.y + CARD_H / 2 });

/** The line between two cards' borders. */
function line(from: XY, to: XY) {
  return { s: exitPoint(card(from), centre(to)), t: exitPoint(card(to), centre(from)) };
}

interface EndsProps {
  /** Card positions (top left). The same objects while a card stays put,
   *  so an edge redraws only when one of its cards moved. */
  from: XY;
  to: XY;
}

const EdgeLine = memo(function EdgeLine({
  from,
  to,
  styleKey: key,
  directed,
}: EndsProps & { styleKey: string; directed: boolean }) {
  const { s, t } = line(from, to);
  const angle = Math.atan2(t.y - s.y, t.x - s.x);
  const head = (r: number) =>
    `${t.x - 11 * Math.cos(angle) + r * 6 * Math.sin(angle)},${t.y - 11 * Math.sin(angle) - r * 6 * Math.cos(angle)}`;
  return (
    <>
      <path d={`M${s.x},${s.y}L${t.x},${t.y}`} data-gv-edge={key} />
      {directed && (
        <path
          className={styles.edgeArrow}
          d={`M${t.x},${t.y}L${head(1)}L${head(-1)}Z`}
          data-gv-arrow=""
        />
      )}
    </>
  );
});

const EdgeLabel = memo(function EdgeLabel({
  from,
  to,
  text,
  title,
}: EndsProps & { text: string; title: string | null }) {
  const { s, t } = line(from, to);
  // The layer ignores the pointer; a label with a title takes it, so the
  // tooltip shows, and is `nopan`, so pressing on it doesn't pan.
  return (
    <text
      x={(s.x + t.x) / 2}
      y={(s.y + t.y) / 2}
      className={title ? `${styles.titled} nopan` : undefined}
      data-gv-count=""
    >
      {title && <title>{title}</title>}
      {text}
    </text>
  );
});

/** A manual relationship's label (≤ 24 chars shown) and an aggregated
 *  edge's count, as drawn at the edge's midpoint. */
export function labelOf(edge: DrawnEdge): string | null {
  const label = edge.kind === 'manual' ? edge.label : null;
  const shown = label && label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
  const badge = edge.count > 1 ? `×${edge.count}` : null;
  return [shown, badge].filter(Boolean).join(' ') || null;
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
}

/** The page a card node stands for in a relationship (M3b §2). */
const pageOfNode = (n: Node): string | null => {
  const card = (n.data as { card?: GvCard } | undefined)?.card;
  return card ? pageOf(card) : null;
};

/** A wide, invisible stroke over a direct relationship that takes the
 *  pointer (the layer itself ignores it); `nopan`, so pressing on it doesn't
 *  pan the canvas. */
const EdgeHit = memo(function EdgeHit({ from, to, onClick }: EndsProps & { onClick: () => void }) {
  const { s, t } = line(from, to);
  return (
    <path
      className={`${styles.edgeHit} nopan`}
      d={`M${s.x},${s.y}L${t.x},${t.y}`}
      data-gv-hit=""
      onClick={onClick}
    />
  );
});

/** Every edge of the canvas, in the viewport under the cards: one group per
 *  style (strokes inherit), counts and labels on top. Card positions come
 *  from React Flow's store, so edges appear with their cards and follow a
 *  drag; a card that stays put keeps its position object, so only a moved
 *  card's edges redraw. */
export const EdgeLayer = memo(function EdgeLayer({ edges, onRelations }: EdgeLayerProps) {
  const nodes = useStore(nodesOf);
  const positions = useMemo(
    () => new Map<string, XY>(nodes.map((n) => [n.id, n.position])),
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
  const labelled = useMemo(
    () =>
      edges.flatMap((e) => {
        const text = labelOf(e);
        return text ? [{ e, text }] : [];
      }),
    [edges],
  );
  return (
    <ViewportPortal>
      <svg className={styles.edges} aria-hidden="true">
        {STYLE_KEYS.map((key) => {
          const s = STROKES[key];
          return (
            <g
              key={key}
              style={{ color: s.stroke, strokeWidth: s.width, strokeDasharray: scaled(s.dash, k) }}
            >
              {groups.get(key)!.map((e) => {
                const from = positions.get(e.source);
                const to = positions.get(e.target);
                if (!from || !to) return null;
                return (
                  <EdgeLine key={e.id} from={from} to={to} styleKey={key} directed={e.directed} />
                );
              })}
            </g>
          );
        })}
        {onRelations && (
          <g>
            {edges.map((e) => {
              if (e.kind !== 'manual' || e.aggregated) return null;
              const from = positions.get(e.source);
              const to = positions.get(e.target);
              const a = pages.get(e.source);
              const b = pages.get(e.target);
              if (!from || !to || !a || !b) return null;
              return <EdgeHit key={e.id} from={from} to={to} onClick={() => onRelations(a, b)} />;
            })}
          </g>
        )}
        <g className={styles.edgeLabels}>
          {labelled.map(({ e, text }) => {
            const from = positions.get(e.source);
            const to = positions.get(e.target);
            if (!from || !to) return null;
            return (
              <EdgeLabel
                key={e.id}
                from={from}
                to={to}
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
