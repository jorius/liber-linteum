// Installed before the app's scripts (page.addInitScript): a fake Tauri IPC
// with one vault holding `remote.md`, then Tauri's freezePrototype.
// Runs in the page, so it must be self-contained.
export function installIpcMock({
  pages,
  editorMode,
  settings: overrides = {},
  remoteCover = true,
  files: vaultFiles = [],
}: {
  pages: Record<string, string>;
  editorMode: string;
  /** Extra settings (palette, fonts, toolbar…) for M2b tests. */
  settings?: Record<string, unknown>;
  /** Pages without a `cover:` get a remote one (the zero-network check). */
  remoteCover?: boolean;
  /** Vault files other than pages from the start (e.g. a cover image). */
  files?: string[];
}) {
  type Args = Record<string, unknown>;
  const w = window as unknown as Record<string, unknown>;
  let nextId = 1;
  /** Vault files other than pages (pasted, dropped, covers). */
  const files = new Set<string>(vaultFiles);
  /** `listen` registrations, so tests can emit events (e.g. tauri://drag-drop). */
  const listeners: { event: string; handler: number; id: number }[] = [];
  w.__nimwEmit = (event: string, payload: unknown) => {
    for (const l of listeners.filter((x) => x.event === event)) {
      (w[`_${l.handler}`] as (e: unknown) => void)?.({ event, id: l.id, payload });
    }
  };
  /** `key: value` lines of the page's leading frontmatter block. */
  const front = (text: string): Record<string, string> => {
    const m = /^---\n([\s\S]*?)\n?---(?:\n|$)/.exec(text);
    const out: Record<string, string> = {};
    for (const line of (m?.[1] ?? '').split('\n')) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
    }
    return out;
  };
  // A first-line `# Heading` (after the frontmatter), else the file name, as
  // the index reads it (PG-01, M4b part 3 §1).
  const titleOf = (path: string, text: string) =>
    /^(?:---\n[\s\S]*?\n---\n)?\s*# ([^\n]+)/.exec(text)?.[1] ??
    path.replace(/\.md$/, '').split('/').pop()!;
  const page = (path: string) => ({
    path,
    title: titleOf(path, pages[path] ?? ''),
    subtitle: front(pages[path] ?? '').subtitle ?? null,
    // M2a's zero-network page keeps a remote cover; M2c pages set their own.
    cover:
      front(pages[path] ?? '').cover ?? (remoteCover ? 'https://remote.example/cover.png' : null),
    coverY: front(pages[path] ?? '')['cover-y'] ? Number(front(pages[path])['cover-y']) : null,
    coverX: front(pages[path] ?? '')['cover-x'] ? Number(front(pages[path])['cover-x']) : null,
    tags: [],
    links: 0,
    backlinks: 0,
    text: pages[path],
    truncated: false,
    binary: false,
  });
  /** The page `[[name]]` resolves to (by file name, or by path). */
  const resolveName = (name: string) =>
    Object.keys(pages).find(
      (p) => p.replace(/\.md$/, '') === name || p.replace(/\.md$/, '').split('/').pop() === name,
    );
  const FRONT = /^---\n[\s\S]*?\n---(?:\n|$)/;
  /** Pages a page's text links to (`[[name]]`; the frontmatter is not text). */
  const linksOf = (path: string): string[] =>
    [...(pages[path] ?? '').replace(FRONT, '').matchAll(/\[\[([^\]|#]+)/g)]
      .map((m) => resolveName(m[1].trim()))
      .filter((p): p is string => !!p);
  /** M3b: a page's relationships — the frontmatter lines naming `[[name]]`
   *  (string or { link, label, directed } items, one per line). */
  const relatedOf = (path: string) =>
    ((pages[path] ?? '').match(FRONT)?.[0] ?? '').split('\n').flatMap((line) => {
      const m = /\[\[([^\]|#]+)/.exec(line);
      const target = m ? resolveName(m[1].trim()) : undefined;
      if (!target) return [];
      const label = /label: ([^,}]+)/.exec(line)?.[1].trim() ?? null;
      return [{ target, label, directed: /directed: true/.test(line) }];
    });
  /** M3b: index-note picks (folder → page). */
  const picks: Record<string, string> = {};
  /** A Global View card for a page or folder (M3a §8). */
  const gvCard = (path: string, kind: string, relation: string | null) => {
    const text = pages[path] ?? '';
    const cover =
      front(text).cover ??
      (kind === 'page' && remoteCover ? 'https://remote.example/cover.png' : null);
    const remote = !!cover && /^[a-z][a-z0-9+.-]*:/i.test(cover);
    const name = path.split('/').pop()!;
    return {
      path,
      kind,
      title: kind === 'page' ? titleOf(path, text) : name,
      subtitle: kind === 'page' ? (front(text).subtitle ?? null) : name,
      cover: remote || !cover ? null : files.has(cover) ? cover : null,
      coverRemote: remote,
      coverY: null,
      coverX: front(text)['cover-x'] ? Number(front(text)['cover-x']) : null,
      coverSide: kind === 'page' ? (sides()[path] ?? 'top') : 'top',
      excerpt:
        kind === 'page'
          ? text
              .replace(/^---[\s\S]*?---\n/, '')
              .replace(/^#.*$/m, '')
              .trim()
              .slice(0, 200)
          : '',
      hasImage: false,
      hasAudio: false,
      indexPage: kind === 'page' ? null : (picks[path] ?? null),
      indexFrom: kind === 'page' ? null : picks[path] ? 'picked' : null,
      pages:
        kind === 'page'
          ? 0
          : Object.keys(pages).filter(
              (p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'),
            ).length,
      folders: 0,
      childTitles: [],
      relation,
    };
  };
  let settings: Record<string, unknown> = {
    version: 1,
    language: 'en',
    theme: 'light',
    rewriteLinks: true,
    confirmDelete: true,
    editorMode,
    ...overrides,
  };
  const widths = (): Record<string, string> => {
    try {
      return JSON.parse(sessionStorage.getItem('nimwMockWidths') ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };
  /** Cover resize: page cover heights, kept like the widths. */
  const heights = (): Record<string, number> => {
    try {
      return JSON.parse(sessionStorage.getItem('nimwMockHeights') ?? '{}') as Record<
        string,
        number
      >;
    } catch {
      return {};
    }
  };
  /** M4b part 3 §3: side covers and strip widths, kept like the heights. */
  const stored = <T>(key: string): Record<string, T> => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, T>;
    } catch {
      return {};
    }
  };
  const sides = () => stored<string>('nimwMockSides');
  const coverWidths = () => stored<number>('nimwMockCoverWidths');
  const vaultSettings = () => ({
    attachments: { mode: 'subfolder', path: 'attachments' },
    obsidian: null,
    pageWidth: null,
    pageWidths: widths(),
    coverHeights: heights(),
    coverSides: sides(),
    coverWidths: coverWidths(),
  });
  const handlers: Record<string, (a: Args, options?: unknown) => unknown> = {
    app_info: () => ({ name: 'Notes In My Way', version: '0.0.0-e2e' }),
    settings_get: () => ({ settings }),
    settings_set: (a) => {
      settings = { ...settings, ...(a.patch as object) };
      return settings;
    },
    fonts_list: () => ['Courier New', 'Menlo'],
    entry_rename: (a) => {
      const from = a.from as string;
      const to = a.to as string;
      pages[to] = pages[from];
      delete pages[from];
      ((w.__nimwRenames ??= []) as unknown[]).push({ from, to });
      return { moved: [[from, to]], updatedFiles: [], updatedLinks: 0, failed: [] };
    },
    vaults_recent: () => [{ path: '/vault', name: 'vault', openedAt: '', missing: false }],
    vault_open: () => ({
      name: 'vault',
      root: '/vault',
      report: {
        files: 2,
        pages: 2,
        parsed: 2,
        skippedUnchanged: 0,
        removed: 0,
        warnings: [],
        durationMs: 1,
      },
    }),
    vault_tree: () =>
      Object.keys(pages).map((path) => ({
        path,
        kind: /\.md$/i.test(path) ? 'page' : 'attachment',
      })),
    page_get: (a) => page(a.path as string),
    page_read: (a) => ({ text: pages[a.path as string], hash: 'h' }),
    page_write: (a) => {
      // Recorded so tests can assert what an edit saved; kept for page_get.
      ((w.__nimwWrites ??= []) as unknown[]).push(a);
      pages[a.path as string] = a.text as string;
      // A new hash per write: the header refreshes when the hash changes.
      return { hash: `h${nextId++}` };
    },
    // ---- M4b part 2: text files (§6) ----
    text_read: (a) => ({ text: pages[a.path as string], hash: 'h' }),
    text_write: (a) => {
      ((w.__nimwWrites ??= []) as unknown[]).push(a);
      pages[a.path as string] = a.text as string;
      return { hash: `h${nextId++}` };
    },
    backlink_count: () => 0,
    links_resolve: (a) =>
      (a.targets as { kind: string; target: string }[]).map(({ kind, target }) => {
        const t = target.replace(/^\//, '').replace(/#.*$/, '');
        // Covers and attachments resolve when a test "saved" them.
        if (kind === 'cover') return files.has(t) ? t : null;
        if (files.has(t)) return t;
        const name = `${t}.md`;
        return name in pages ? name : null;
      }),
    'plugin:event|listen': (a) => {
      const id = nextId++;
      listeners.push({ event: a.event as string, handler: a.handler as number, id });
      return id;
    },
    'plugin:event|unlisten': (a) => {
      const i = listeners.findIndex((l) => l.id === a.eventId);
      if (i >= 0) listeners.splice(i, 1);
      return null;
    },
    // ---- M2c (spec §7) ----
    vault_settings_get: () => vaultSettings(),
    // M4b part 2 §1: kept in sessionStorage, so a reload still has them.
    page_width_set: (a) => {
      const next = { ...widths() };
      if (a.width) next[a.path as string] = a.width as string;
      else delete next[a.path as string];
      sessionStorage.setItem('nimwMockWidths', JSON.stringify(next));
      return vaultSettings();
    },
    // Cover resize: clamped like Rust (132–2000), kept across a reload.
    cover_height_set: (a) => {
      const next = { ...heights() };
      const height = a.height as number | null;
      if (height === null) delete next[a.path as string];
      else next[a.path as string] = Math.min(2000, Math.max(132, Math.round(height)));
      sessionStorage.setItem('nimwMockHeights', JSON.stringify(next));
      ((w.__nimwCoverHeights ??= []) as unknown[]).push({ path: a.path, height });
      return vaultSettings();
    },
    // M4b part 3 §3: placements (`top` clears) and strip widths (clamped
    // like Rust, 160–2000), kept across a reload.
    cover_side_set: (a) => {
      const next = { ...sides() };
      if (a.side === 'top') delete next[a.path as string];
      else next[a.path as string] = a.side as string;
      sessionStorage.setItem('nimwMockSides', JSON.stringify(next));
      ((w.__nimwCoverSides ??= []) as unknown[]).push({ path: a.path, side: a.side });
      return vaultSettings();
    },
    cover_width_set: (a) => {
      const next = { ...coverWidths() };
      const width = a.width as number | null;
      if (width === null) delete next[a.path as string];
      else next[a.path as string] = Math.min(2000, Math.max(160, Math.round(width)));
      sessionStorage.setItem('nimwMockCoverWidths', JSON.stringify(next));
      return vaultSettings();
    },
    vault_settings_set: (a) => (a.patch as { attachments: unknown }) ?? null,
    attachment_paste: (_a, options) => {
      const headers = (options as { headers?: Record<string, string> })?.headers ?? {};
      const name = decodeURIComponent(headers['x-nimw-name'] ?? 'pasted.png');
      files.add(`attachments/${name}`);
      ((w.__nimwPastes ??= []) as unknown[]).push(name);
      return { path: `attachments/${name}`, link: name, copied: true };
    },
    attachment_import: (a) =>
      (a.paths as string[]).map((source) => {
        const name = source.split('/').pop()!;
        files.add(`attachments/${name}`);
        return { source, ok: { path: `attachments/${name}`, link: name, copied: true } };
      }),
    cover_pick: () => {
      files.add('attachments/sky.png');
      return { path: 'attachments/sky.png', reference: 'attachments/sky.png' };
    },
    link_suggest: (a) => {
      const q = String(a.query).toLowerCase();
      return Object.keys(pages)
        .map((path) => ({
          path,
          kind: 'page',
          title: titleOf(path, pages[path]),
          target: path.replace(/\.md$/, ''),
        }))
        .filter((s) => s.title.toLowerCase().includes(q) || s.path.toLowerCase().includes(q));
    },
    // ---- M3a (spec §8): levels, edges and layouts from `pages` ----
    gv_children: (a) => {
      const level = a.level as { kind: string; path?: string };
      const folders = new Set<string>();
      for (const p of Object.keys(pages)) {
        for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) folders.add(p.slice(0, i));
      }
      const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
      if (level.kind === 'page') {
        const centre = level.path!;
        const out = new Set(linksOf(centre));
        const into = new Set(Object.keys(pages).filter((p) => linksOf(p).includes(centre)));
        const others = [...new Set([...out, ...into])].filter((p) => p !== centre).sort();
        const rel = (p: string) => (out.has(p) && into.has(p) ? 'both' : out.has(p) ? 'out' : 'in');
        return {
          cards: [
            gvCard(centre, 'page', 'centre'),
            ...others.map((p) => gvCard(p, 'page', rel(p))),
          ],
          centre,
        };
      }
      const dir = level.kind === 'folder' ? level.path! : '';
      if (dir && !folders.has(dir)) throw { kind: 'notFound', message: dir };
      const kind = dir ? 'folder' : 'project';
      const subs = [...folders].filter((f) => parentOf(f) === dir).sort();
      const here = Object.keys(pages)
        .filter((p) => parentOf(p) === dir)
        .sort();
      return {
        cards: [
          ...subs.map((f) => gvCard(f, kind, null)),
          ...here.map((p) => gvCard(p, 'page', null)),
        ],
        centre: null,
      };
    },
    gv_edges: (a) => {
      const shown = new Set(a.visible as string[]);
      const lift = (p: string): string | null => {
        for (let q = p; q; q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '') {
          if (shown.has(q)) return q;
        }
        return null;
      };
      type E = {
        from: string;
        to: string;
        kind: string;
        count: number;
        aggregated: boolean;
        directed: boolean;
        label: string | null;
      };
      const edges = new Map<string, E>();
      const add = (
        src: string,
        target: string,
        kind: string,
        directed = false,
        label = null as string | null,
      ) => {
        const x = lift(src);
        const y = lift(target);
        if (!x || !y || x === y) return;
        // A folder card stands for its index note in a relationship: one
        // between the cards' own pages is direct (final review I3).
        const stands = (card: string, page: string) => card === page || picks[card] === page;
        const lifted =
          kind === 'manual' ? !(stands(x, src) && stands(y, target)) : x !== src || y !== target;
        const [from, to] = directed ? [x, y] : x < y ? [x, y] : [y, x];
        const key = `${kind}|${[x, y].sort().join('|')}`;
        const e = edges.get(key) ?? {
          from,
          to,
          kind,
          count: 0,
          aggregated: false,
          directed: false,
          label: null,
        };
        e.count++;
        e.aggregated =
          kind === 'manual' && e.count > 1 ? e.aggregated && lifted : e.aggregated || lifted;
        if (directed) Object.assign(e, { directed, from, to });
        e.label ??= label;
        edges.set(key, e);
      };
      for (const src of Object.keys(pages)) {
        for (const target of linksOf(src)) add(src, target, 'link');
        for (const r of relatedOf(src)) add(src, r.target, 'manual', r.directed, r.label);
      }
      return [...edges.values()];
    },
    // ---- M3b: relationship targets and index-note picks ----
    link_target: (a) => (a.target as string).replace(/\.md$/, '').split('/').pop(),
    index_pick_set: (a) => {
      const folder = a.folder as string;
      if (a.page) picks[folder] = a.page as string;
      else delete picks[folder];
      return gvCard(folder, folder.includes('/') ? 'folder' : 'project', null);
    },
    layout_get: (a) => {
      const all = JSON.parse(localStorage.getItem('nimw-e2e-layout') ?? '{}');
      return all[a.level as string] ?? {};
    },
    layout_set: (a) => {
      const all = JSON.parse(localStorage.getItem('nimw-e2e-layout') ?? '{}');
      all[a.level as string] = a.positions;
      localStorage.setItem('nimw-e2e-layout', JSON.stringify(all));
      return null;
    },
    entry_create_folder: (a) => (a.parent ? `${a.parent}/${a.name}` : (a.name as string)),
    entry_create_page: (a) => {
      const name = `${a.name}.md`;
      const path = a.dir ? `${a.dir}/${name}` : name;
      pages[path] = '';
      return path;
    },
  };
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    transformCallback: (cb: unknown) => {
      const id = nextId++;
      w[`_${id}`] = cb;
      return id;
    },
    unregisterCallback: (id: number) => delete w[`_${id}`],
    convertFileSrc: (p: string) => p,
    invoke: async (cmd: string, args: Args, options?: unknown) => {
      const handler = handlers[cmd];
      if (!handler) throw { kind: 'io', message: `not mocked: ${cmd}` };
      return handler(args ?? {}, options);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  w.isTauri = true;
  // CSP-blocked loads never become requests; record them as violations.
  const violations: string[] = [];
  w.__nimwCspViolations = violations;
  document.addEventListener('securitypolicyviolation', (e) =>
    violations.push(`${e.violatedDirective} ${e.blockedURI}`),
  );
  // tauri.conf.json: "freezePrototype": true
  Object.freeze(Object.prototype);
}
