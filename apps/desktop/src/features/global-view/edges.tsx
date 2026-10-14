// Global View edges (M3a §6): straight lines between card borders ("floating"
// edges), one style per kind so they differ by more than colour.
import {
  EdgeLabelRenderer,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react';
import styles from './GlobalView.module.css';

export type GvEdgeKind = 'link' | 'manual' | 'tree';

export interface GvEdgeData extends Record<string, unknown> {
  kind: GvEdgeKind;
  aggregated: boolean;
  directed: boolean;
  count: number;
  label: string | null;
}

export type GvFlowEdge = Edge<GvEdgeData, 'gv'>;

/** Gap between a card's border and its edges' ends (prototype: 5 px). */
const GAP = 5;
const LABEL_CHARS = 24;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(node: InternalNode): Box {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? 240,
    h: node.measured.height ?? 300,
  };
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

export function strokeOf(kind: GvEdgeKind, aggregated: boolean) {
  return STROKES[kind !== 'tree' && aggregated ? `${kind}-aggregated` : kind];
}

/** One edge between two card borders; directed relationships get an arrow,
 *  aggregated edges a count, relationships their label. */
export function GvFlowEdgeView({ source, target, data }: EdgeProps<GvFlowEdge>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) return null;
  const a = boxOf(from);
  const b = boxOf(to);
  const s = exitPoint(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const t = exitPoint(b, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
  const style = strokeOf(data.kind, data.aggregated);
  const angle = Math.atan2(t.y - s.y, t.x - s.x);
  const head = (r: number) =>
    `${t.x - 11 * Math.cos(angle) + r * 6 * Math.sin(angle)},${t.y - 11 * Math.sin(angle) - r * 6 * Math.cos(angle)}`;
  const mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
  const label = data.kind === 'manual' ? data.label : null;
  const shown = label && label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
  const badge = data.count > 1 ? `×${data.count}` : null;
  return (
    <>
      <path
        d={`M ${s.x},${s.y} L ${t.x},${t.y}`}
        fill="none"
        style={{
          stroke: style.stroke,
          strokeWidth: style.width,
          strokeDasharray: style.dash,
          strokeLinecap: 'round',
        }}
        data-gv-edge={`${data.kind}${data.aggregated ? '-aggregated' : ''}`}
      />
      {data.directed && (
        <path
          d={`M ${t.x},${t.y} L ${head(1)} L ${head(-1)} Z`}
          style={{ fill: style.stroke }}
          data-gv-arrow=""
        />
      )}
      {(shown || badge) && (
        <EdgeLabelRenderer>
          <div
            className={styles.edgeLabel}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
            title={label ?? undefined}
            aria-hidden="true"
          >
            {[shown, badge].filter(Boolean).join(' ')}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
