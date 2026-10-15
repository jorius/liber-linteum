// See atoms (M4b part 3 §6): the atoms map of one page — its card on top,
// its sections and blocks as a tree under it, the pages it links to on the
// right — with the Global View's pan, zoom, edges and keyboard. Read-only:
// a click on a block opens the page there; places aren't saved.
import '@xyflow/react/dist/base.css';
import { ReactFlow, useNodesState, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  gvChildren,
  gvEdges,
  linksResolve,
  pageRead,
  type GlobalViewEdges,
  type GvCard,
  type GvEdge,
  type IpcResult,
  type LinkTarget,
} from '../../ipc';
import { useEditorStore } from '../../stores/editorStore';
import { errorMessage } from '../../stores/messages';
import { openPage, openPageAt } from '../../stores/navigate';
import { useToastStore } from '../../stores/toastStore';
import { useVaultStore } from '../../stores/vaultStore';
import { toLf } from '../editor/eol';
import { AtomCard, MoreCard, SectionCard } from './AtomCard';
import {
  atomsLayout,
  buildAtoms,
  type Atom,
  type AtomBox,
  type AtomsModel,
  type More,
  type Section,
} from './atoms';
import { Card } from './Card';
import { EdgeLayer, type DrawnEdge } from './edges';
import { useFocusMode } from './focusMode';
import { useGvStore } from './gvStore';
import { nearestInDirection, type Direction, type XY } from './layout';
import styles from './GlobalView.module.css';

/** Re-reading after the page changes waits for a burst to settle. */
export const ATOMS_REFRESH_MS = 150;

/** What the map shows of a page. */
export interface AtomsData {
  model: AtomsModel;
  /** The page's own card (`null` until the index has it). */
  root: GvCard | null;
  /** Cards of the pages its blocks link to, and its relationships. */
  pages: GvCard[];
  /** Block (or section) → page it links to. */
  links: [string, string][];
  /** Relationships of the page (manual edges). */
  related: GvEdge[];
  /** Media atoms' files, resolved (`null`: not found). */
  files: Record<string, string | null>;
}

/** Reads `path`'s atoms: its live text (unsaved edits included), its card
 *  and neighbours (the page level), and where its links and files lead. */
export async function readAtoms(path: string): Promise<IpcResult<AtomsData>> {
  let text = useEditorStore.getState().liveText(path);
  if (text === null) {
    const res = await pageRead(path);
    if (!res.ok) return { ok: false, error: res.error };
    // The editor holds LF text: offsets for the jump must count the same
    // characters (final review I2).
    text = toLf(res.value.text);
  }
  const model = buildAtoms(text);
  const level = await gvChildren({ kind: 'page', path });
  const cards = level.ok ? level.value.cards : [];
  const byPath = new Map(cards.map((c) => [c.path, c]));
  const owners: [string, boolean][] = [];
  const targets: LinkTarget[] = [];
  const ask = (owner: string, media: boolean, kind: LinkTarget['kind'], target: string) => {
    owners.push([owner, media]);
    targets.push({ kind, target });
  };
  for (const a of model.atoms) {
    if (a.media) ask(a.id, true, a.media.kind, a.media.target);
    for (const l of a.links) if (l.target) ask(a.id, false, l.kind, l.target);
  }
  for (const s of model.sections)
    for (const l of s.links) if (l.target) ask(s.id, false, l.kind, l.target);
  const resolved = targets.length ? await linksResolve(path, targets) : null;
  const files: Record<string, string | null> = {};
  const links: [string, string][] = [];
  const linked: string[] = [];
  const seen = new Set<string>();
  owners.forEach(([owner, media], i) => {
    const to = resolved?.ok ? (resolved.value[i] ?? null) : null;
    if (media) {
      files[owner] = to;
      if (to && /\.md$/i.test(to)) links.push([owner, to]);
    } else if (to && to !== path && byPath.has(to)) {
      if (!links.some(([o, p]) => o === owner && p === to)) links.push([owner, to]);
    }
    if (to && to !== path && byPath.has(to) && !seen.has(to)) {
      seen.add(to);
      linked.push(to);
    }
  });
  const edges = await gvEdges([path, ...cards.map((c) => c.path).filter((p) => p !== path)]);
  const related = (edges.ok && Array.isArray(edges.value) ? edges.value : []).filter(
    (e) => e.kind === 'manual' && (e.from === path || e.to === path),
  );
  for (const e of related) {
    const other = e.from === path ? e.to : e.from;
    if (!seen.has(other) && byPath.has(other)) {
      seen.add(other);
      linked.push(other);
    }
  }
  return {
    ok: true,
    value: {
      model,
      root: byPath.get(path) ?? null,
      pages: linked.map((p) => byPath.get(p)!),
      links: links.filter(([, p]) => byPath.has(p)),
      related,
      files,
    },
  };
}

/** A stand-in card for the page until the index answers for it. */
const pageCard = (path: string, title: string): GvCard => ({
  path,
  kind: 'page',
  title,
  subtitle: null,
  cover: null,
  coverRemote: false,
  coverY: null,
  coverSide: 'top',
  coverX: null,
  excerpt: '',
  hasImage: false,
  hasAudio: false,
  indexPage: null,
  pages: 0,
  folders: 0,
  childTitles: [],
  relation: null,
});

interface Common extends Record<string, unknown> {
  focusable: boolean;
  onFocus: () => void;
}
type PageNode = Node<
  Common & {
    card: GvCard;
    open: boolean;
    onOpen: () => void;
    onEditor: () => void;
    onAtoms?: () => void;
  },
  'page'
>;
type AtomNode = Node<Common & { atom: Atom; file?: string | null; onOpen: () => void }, 'atom'>;
type SectionNode = Node<Common & { section: Section; onOpen: () => void }, 'section'>;
type MoreNode = Node<Common & { more: More; onOpen: () => void }, 'more'>;
type AnyNode = PageNode | AtomNode | SectionNode | MoreNode;

const nodeTypes = {
  page: ({ data }: NodeProps<PageNode>) => (
    <Card
      card={data.card}
      open={data.open}
      focusable={data.focusable}
      connections=""
      onOpen={data.onOpen}
      onOpenEditor={data.onEditor}
      onSeeAtoms={data.onAtoms}
      onFocus={data.onFocus}
    />
  ),
  atom: ({ data }: NodeProps<AtomNode>) => (
    <AtomCard
      atom={data.atom}
      file={data.file}
      focusable={data.focusable}
      onOpen={data.onOpen}
      onFocus={data.onFocus}
    />
  ),
  section: ({ data }: NodeProps<SectionNode>) => (
    <SectionCard
      section={data.section}
      focusable={data.focusable}
      onOpen={data.onOpen}
      onFocus={data.onFocus}
    />
  ),
  more: ({ data }: NodeProps<MoreNode>) => (
    <MoreCard
      more={data.more}
      focusable={data.focusable}
      onOpen={data.onOpen}
      onFocus={data.onFocus}
    />
  ),
};

const FLOW_ID = 'gv-atoms';
/** Past this many cards, only those in view are rendered. */
const VISIBLE_ONLY = 150;
const KEYS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

export interface AtomsCanvasProps {
  path: string;
  title: string;
  toggles: GlobalViewEdges;
}

export function AtomsCanvas({ path, title, toggles }: AtomsCanvasProps) {
  const { t } = useTranslation();
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<AtomsData | null>(null);
  const [moved, setMoved] = useState<Record<string, XY>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const reset = useGvStore((s) => s.atomsReset);

  // Read on show, and again when the vault or a saved page changes.
  useEffect(() => {
    let live = true;
    let seq = 0;
    const read = async () => {
      const mine = ++seq;
      const res = await readAtoms(path);
      if (!live || mine !== seq) return;
      if (res.ok) {
        setData(res.value);
      } else {
        useGvStore.getState().closeAtoms();
        if (res.error.kind !== 'notFound' && res.error.kind !== 'noVault') {
          useToastStore.getState().push({ message: errorMessage(res.error), tone: 'error' });
        }
      }
    };
    setData(null);
    setMoved({});
    setFocus(null);
    void read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void read(), ATOMS_REFRESH_MS);
    };
    const stopVault = useVaultStore.subscribe((s, p) => {
      if (s.nodes !== p.nodes) later();
    });
    const stopEditor = useEditorStore.subscribe((s, p) => {
      if (s.hash !== p.hash) later();
    });
    return () => {
      live = false;
      clearTimeout(timer);
      stopVault();
      stopEditor();
    };
  }, [path]);

  // Reset layout: the dragged cards go back.
  useEffect(() => setMoved({}), [reset]);

  const layout = useMemo(
    () =>
      data
        ? atomsLayout(
            path,
            data.model,
            data.pages.map((p) => p.path),
          )
        : null,
    [data, path],
  );
  const boxes = useMemo(() => {
    const out = new Map<string, AtomBox>(layout?.boxes ?? []);
    for (const [id, at] of Object.entries(moved)) {
      const b = out.get(id);
      if (b) out.set(id, { ...b, ...at });
    }
    return out;
  }, [layout, moved]);

  const jump = useCallback((from: number, to: number) => void openPageAt(path, from, to), [path]);
  const tabStop = focus ?? path;

  const computed = useMemo<AnyNode[]>(() => {
    if (!data || !layout) return [];
    const common = (id: string) => {
      const b = boxes.get(id)!;
      return {
        id,
        position: { x: b.x, y: b.y },
        width: b.w,
        height: b.h,
        style: { width: b.w, height: b.h },
        dragHandle: '.gv-grip',
        selectable: false,
        focusable: false,
        domAttributes: { 'aria-roledescription': undefined },
      };
    };
    const own = (id: string) => ({ focusable: id === tabStop, onFocus: () => setFocus(id) });
    const root = data.root ?? pageCard(path, title);
    const out: AnyNode[] = [
      {
        ...common(path),
        type: 'page',
        data: {
          ...own(path),
          card: root,
          open: true,
          // The page itself: what its card would open is already here.
          onOpen: () => undefined,
          onEditor: () => void openPage(path),
        },
      },
    ];
    for (const s of data.model.sections) {
      out.push({
        ...common(s.id),
        type: 'section',
        data: { ...own(s.id), section: s, onOpen: () => jump(s.at, s.at) },
      });
    }
    for (const a of data.model.atoms) {
      out.push({
        ...common(a.id),
        type: 'atom',
        data: { ...own(a.id), atom: a, file: data.files[a.id], onOpen: () => jump(a.from, a.to) },
      });
    }
    for (const m of data.model.more) {
      out.push({
        ...common(m.id),
        type: 'more',
        data: { ...own(m.id), more: m, onOpen: () => jump(m.from, m.from) },
      });
    }
    for (const card of data.pages) {
      out.push({
        ...common(card.path),
        type: 'page',
        data: {
          ...own(card.path),
          card,
          open: false,
          // Linked pages behave as elsewhere: a click shows their atoms.
          onOpen: () => useGvStore.getState().seeAtoms(card.path, card.title),
          onEditor: () => void openPage(card.path),
          onAtoms: () => useGvStore.getState().seeAtoms(card.path, card.title),
        },
      });
    }
    return out;
  }, [data, layout, boxes, tabStop, path, title, jump]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AnyNode>(computed);
  useEffect(() => setNodes(computed), [computed, setNodes]);

  const drawn = useMemo<DrawnEdge[]>(() => {
    if (!data || !layout) return [];
    const out: DrawnEdge[] = [];
    const sections = new Set(data.model.sections.map((s) => s.id));
    if (toggles.tree) {
      for (const [from, to] of layout.tree) {
        out.push({
          id: `tree:${from}→${to}`,
          source: from,
          target: to,
          kind: 'tree',
          aggregated: false,
          directed: false,
          count: 1,
          label: null,
          // The page reaches its section columns down–across–down; the rest
          // hang off a trunk down their left side.
          route: from === path && sections.has(to) ? 'v' : 'l',
        });
      }
    }
    if (toggles.links) {
      for (const [from, to] of data.links) {
        out.push({
          id: `link:${from}→${to}`,
          source: from,
          target: to,
          kind: 'link',
          aggregated: false,
          directed: false,
          count: 1,
          label: null,
        });
      }
    }
    if (toggles.manual) {
      for (const e of data.related) {
        out.push({
          id: `manual:${e.from}→${e.to}`,
          source: e.from,
          target: e.to,
          kind: 'manual',
          aggregated: false,
          directed: e.directed,
          count: 1,
          label: e.label,
        });
      }
    }
    return out;
  }, [data, layout, toggles, path]);

  // Shown: fit it in view, the keyboard on the page's card when it was here.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!data || fitted.current === path || nodes.length !== computed.length) return;
    fitted.current = path;
    void flow.fitView({ padding: 0.08, maxZoom: 1, duration: 0 });
    const active = document.activeElement;
    const lost = !active || active === document.body || active.closest('[hidden]') !== null;
    if (lost || wrapper.current?.closest('section')?.contains(active)) focusCard(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, nodes, path]);

  const focusMode = useFocusMode(wrapper, [drawn]);

  function focusCard(id: string) {
    setFocus(id);
    const find = () =>
      wrapper.current?.querySelector<HTMLElement>(`[data-gv-card="${CSS.escape(id)}"]`);
    const el = find();
    if (el) {
      el.focus({ preventScroll: true });
      return;
    }
    // After the next render — unless the keyboard went elsewhere meanwhile
    // (⌘F's Search dialog opened while the level loaded).
    const before = document.activeElement;
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now === before || now === document.body) find()?.focus({ preventScroll: true });
    });
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-gv-card]')?.dataset.gvCard;
    if (!from) return;
    const dir = KEYS[e.key];
    if (dir) {
      e.preventDefault();
      // Cards differ in size here: compare centres.
      const at = new Map(
        [...boxes].map(([id, b]) => [id, { x: b.x + b.w / 2, y: b.y + b.h / 2 }] as const),
      );
      const next = nearestInDirection(from, at, dir);
      if (next) {
        focusCard(next);
        const p = at.get(next)!;
        void flow.setCenter(p.x, p.y, { zoom: flow.getZoom(), duration: 150 });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      useGvStore.getState().closeAtoms();
    }
  };

  const empty = data !== null && data.model.atoms.length === 0 && data.model.sections.length === 0;
  return (
    <div
      ref={wrapper}
      className={styles.canvas}
      data-gv-canvas=""
      data-gv-atoms={path}
      {...focusMode}
      onKeyDown={onKeyDown}
    >
      <ReactFlow<AnyNode>
        id={FLOW_ID}
        aria-label={t('gv.atoms.canvas', { title })}
        aria-describedby={`react-flow__node-desc-${FLOW_ID}`}
        ariaLabelConfig={{
          'node.a11yDescription.default': t('gv.atoms.keys'),
          'node.a11yDescription.keyboardDisabled': t('gv.atoms.keys'),
          'edge.a11yDescription.default': t('gv.a11y.edges'),
        }}
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => setMoved((m) => ({ ...m, [node.id]: node.position }))}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        disableKeyboardA11y
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2}
        // A long page's map draws only the cards in view (§6).
        onlyRenderVisibleElements={nodes.length > VISIBLE_ONLY}
        proOptions={{ hideAttribution: true }}
      >
        <EdgeLayer edges={drawn} tree="v" />
      </ReactFlow>
      {empty && <p className={styles.atomsEmpty}>{t('gv.atoms.empty')}</p>}
      <div className={styles.zoom} role="group" aria-label={t('gv.zoom')}>
        <button type="button" onClick={() => void flow.zoomIn()} aria-label={t('gv.zoomIn')}>
          +
        </button>
        <button type="button" onClick={() => void flow.zoomOut()} aria-label={t('gv.zoomOut')}>
          −
        </button>
        <button
          type="button"
          onClick={() => void flow.fitView({ padding: 0.08, maxZoom: 1 })}
          aria-label={t('gv.fit')}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
