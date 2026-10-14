import '@xyflow/react/dist/base.css';
import {
  Handle,
  Position,
  ReactFlow,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { GlobalViewEdges, GvCard } from '../../ipc';
import { Card } from './Card';
import { GvFlowEdgeView, type GvFlowEdge } from './edges';
import { useGvStore } from './gvStore';
import {
  CARD_H,
  CARD_W,
  columnsLayout,
  gridLayout,
  nearestInDirection,
  neighbourhoodLayout,
  withPinned,
  type Direction,
  type XY,
} from './layout';
import styles from './GlobalView.module.css';

interface CardData extends Record<string, unknown> {
  card: GvCard;
  open: boolean;
  focusable: boolean;
  connections: string;
  onOpen: (card: GvCard) => void;
  onOpenEditor: (card: GvCard) => void;
}

type CardNode = Node<CardData, 'card'>;

/** A card as a React Flow node; hidden handles let edges attach (they are
 *  drawn border to border, see edges.tsx). */
function CardNodeView({ data }: NodeProps<CardNode>) {
  const setFocus = useGvStore((s) => s.setFocus);
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={styles.handle}
      />
      <Card
        card={data.card}
        open={data.open}
        focusable={data.focusable}
        connections={data.connections}
        onOpen={() => data.onOpen(data.card)}
        onOpenEditor={() => data.onOpenEditor(data.card)}
        onFocus={() => setFocus(data.card.path)}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={styles.handle}
      />
    </>
  );
}

const nodeTypes = { card: CardNodeView };
const edgeTypes = { gv: GvFlowEdgeView };
const KEYS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

export interface CanvasProps {
  /** Layout key of what is shown; a new key fits the view again. */
  canvasKey: string;
  mode: 'drill' | 'expand';
  toggles: GlobalViewEdges;
  width: number;
  onOpen: (card: GvCard) => void;
  onOpenEditor: (card: GvCard) => void;
}

/** The Global View canvas (M3a §6, §7): cards placed by the level's layout
 *  (pinned positions win), edges per the toggles, pan and zoom. */
export function Canvas({ canvasKey, mode, toggles, width, onOpen, onOpenEditor }: CanvasProps) {
  const { t } = useTranslation();
  const canvas = useGvStore((s) => s.canvas);
  const edges = useGvStore((s) => s.edges);
  const pinned = useGvStore((s) => s.pinned);
  const expanded = useGvStore((s) => s.expanded);
  const focus = useGvStore((s) => s.focus);
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const positions = useMemo(() => {
    let auto: Map<string, XY>;
    if (mode === 'expand') auto = columnsLayout(canvas.roots, canvas.children);
    else if (canvas.centre) auto = neighbourhoodLayout(canvas.cards);
    else auto = gridLayout(canvas.roots, width);
    return withPinned(auto, pinned);
  }, [canvas, mode, pinned, width]);

  const expandedPaths = useMemo(
    () => new Set(expanded.map((r) => (r.kind === 'vault' ? '' : r.path))),
    [expanded],
  );

  const flowEdges = useMemo<GvFlowEdge[]>(() => {
    const out: GvFlowEdge[] = [];
    for (const e of edges) {
      const shown = e.kind === 'link' ? toggles.links : toggles.manual;
      if (!shown || (e.aggregated && !toggles.aggregated)) continue;
      out.push({
        id: `${e.kind}:${e.from}→${e.to}`,
        source: e.from,
        target: e.to,
        type: 'gv',
        data: {
          kind: e.kind,
          aggregated: e.aggregated,
          directed: e.directed,
          count: e.count,
          label: e.label,
        },
      });
    }
    if (toggles.tree) {
      for (const [parent, kids] of canvas.children) {
        for (const kid of kids) {
          out.push({
            id: `tree:${parent}→${kid}`,
            source: parent,
            target: kid,
            type: 'gv',
            data: { kind: 'tree', aggregated: false, directed: false, count: 1, label: null },
          });
        }
      }
    }
    return out;
  }, [edges, toggles, canvas.children]);

  const connections = useMemo(() => {
    const links = new Map<string, number>();
    const manual = new Map<string, number>();
    for (const e of edges) {
      const m = e.kind === 'link' ? links : manual;
      for (const p of [e.from, e.to]) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return (path: string) =>
      t('gv.connections', { links: links.get(path) ?? 0, manual: manual.get(path) ?? 0 });
  }, [edges, t]);

  const tabStop = focus ?? canvas.centre ?? canvas.cards[0]?.path ?? null;
  const computed = useMemo<CardNode[]>(
    () =>
      canvas.cards.map((card) => ({
        id: card.path,
        type: 'card',
        position: positions.get(card.path) ?? { x: 0, y: 0 },
        dragHandle: '.gv-grip',
        selectable: false,
        focusable: false,
        style: { width: CARD_W, height: CARD_H },
        data: {
          card,
          open: canvas.centre === card.path || expandedPaths.has(card.path),
          focusable: card.path === tabStop,
          connections: connections(card.path),
          onOpen,
          onOpenEditor,
        },
      })),
    [canvas, positions, expandedPaths, tabStop, connections, onOpen, onOpenEditor],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(computed);
  useEffect(() => setNodes(computed), [computed, setNodes]);

  // A new level: fit it in view, and keep the keyboard on a card when the
  // card that opened it is gone (it unmounted, focus fell to the page).
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized) return;
    void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 0 });
    const active = document.activeElement;
    if (active === document.body || (active && wrapper.current?.contains(active))) {
      const first = useGvStore.getState().focus ?? canvas.centre ?? canvas.cards[0]?.path;
      if (first) focusCard(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasKey, initialized]);

  /** Moves the keyboard to a card: at once when it is on screen, else after
   *  the next render (a level that just loaded). */
  function focusCard(path: string) {
    useGvStore.getState().setFocus(path);
    const find = () =>
      wrapper.current?.querySelector<HTMLElement>(`[data-gv-card="${CSS.escape(path)}"]`);
    const el = find();
    if (el) el.focus({ preventScroll: true });
    else requestAnimationFrame(() => find()?.focus({ preventScroll: true }));
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-gv-card]')?.dataset.gvCard;
    if (!from) return;
    const dir = KEYS[e.key];
    if (dir) {
      e.preventDefault();
      const at = new Map(nodes.map((n) => [n.id, n.position]));
      const next = nearestInDirection(from, at, dir);
      if (next) {
        focusCard(next);
        const p = at.get(next)!;
        void flow.setCenter(p.x + CARD_W / 2, p.y + CARD_H / 2, {
          zoom: flow.getZoom(),
          duration: 150,
        });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void useGvStore.getState().up(from);
    }
  };

  return (
    <div ref={wrapper} className={styles.canvas} onKeyDown={onKeyDown}>
      <ReactFlow<CardNode, GvFlowEdge>
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => useGvStore.getState().pin(node.id, node.position)}
        nodesConnectable={false}
        connectOnClick={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        disableKeyboardA11y
        zoomOnDoubleClick={false}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      />
      <div className={styles.zoom} role="group" aria-label={t('gv.zoom')}>
        <button type="button" onClick={() => void flow.zoomIn()} aria-label={t('gv.zoomIn')}>
          +
        </button>
        <button type="button" onClick={() => void flow.zoomOut()} aria-label={t('gv.zoomOut')}>
          −
        </button>
        <button
          type="button"
          onClick={() => void flow.fitView({ padding: 0.12, maxZoom: 1 })}
          aria-label={t('gv.fit')}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
