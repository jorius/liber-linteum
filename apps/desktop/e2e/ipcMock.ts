// Installed before the app's scripts (page.addInitScript): a fake Tauri IPC
// with one vault holding `remote.md`, then Tauri's freezePrototype.
// Runs in the page, so it must be self-contained.
export function installIpcMock({
  pages,
  editorMode,
  settings: overrides = {},
  remoteCover = true,
  files: vaultFiles = [],
  coverSides = {},
  outside = {},
  filePicks = [],
  folders = [],
}: {
  pages: Record<string, string>;
  editorMode: string;
  /** Extra settings (palette, fonts, toolbar…) for M2b tests. */
  settings?: Record<string, unknown>;
  /** Pages without a `cover:` get a remote one (the zero-network check). */
  remoteCover?: boolean;
  /** Vault files other than pages from the start (e.g. a cover image). */
  files?: string[];
  /** M4b part 3 §3: pages whose cover is a side strip (`.nimw/vault.json`). */
  coverSides?: Record<string, 'left' | 'right'>;
  /** M4b part 3 §9: what `links_external` says about each target. */
  outside?: Record<
    string,
    {
      path: string;
      exists: boolean;
      listed: boolean;
      network?: boolean;
      askFirst?: boolean;
      openable?: boolean;
    }
  >;
  /** M4b part 3 §7: what the Attach button's file dialog picks. */
  filePicks?: { path: string; name: string; url: string; inVault: string | null }[];
  /** M5b: folders the tree lists (besides those quick notes create). */
  folders?: string[];
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
      coverY: front(text)['cover-y'] ? Number(front(text)['cover-y']) : null,
      // M4b part 3 §3: a side strip, focused in both axes (seeded, or set over IPC).
      coverX: front(text)['cover-x'] ? Number(front(text)['cover-x']) : null,
      coverSide: kind === 'page' ? (sides()[path] ?? coverSides[path] ?? 'top') : 'top',
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
  /** M4b part 3 §8: the vault's own link format for new attachments. */
  let linkFormat: string | null = null;
  const vaultSettings = () => ({
    attachments: { mode: 'subfolder', path: 'attachments' },
    obsidian: null,
    pageWidth: null,
    pageWidths: widths(),
    coverHeights: heights(),
    coverSides: sides(),
    coverWidths: coverWidths(),
    attachmentLinkFormat: linkFormat,
    obsidianLinkFormat: null,
  });
  // ---- M4c: quick notes (the global Scratchpad and the scratch folder) ----
  const SCRATCH_DEFAULT = '/Users/e2e/Documents/Notes In My Way/Scratchpad';
  /** The open vault is the global Scratchpad (its root is the scratch place). */
  let inScratchpad = false;
  const autoNamed = new Set<string>();
  /** Folders quick notes created (the mock's tree lists no other folders). */
  const madeFolders = new Set<string>();
  const folderIcons: Record<string, string> = {};
  const scratchDir = () => (inScratchpad ? '' : 'Scratchpad');
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const freeName = (dir: string, stem: string, self?: string) => {
    for (let i = 0; ; i++) {
      const path = join(dir, i ? `${stem} ${i}.md` : `${stem}.md`);
      if (path === self || !(path in pages)) return path;
    }
  };
  /** The first line's text, as Rust derives it (enough for the tests). */
  const stemOf = (text: string) =>
    (text.split('\n').find((l) => l.trim()) ?? '')
      .replace(/^#+\s*/, '')
      .replace(/[/\\#|^[\]:*"<>?]/g, '-')
      .trim()
      .slice(0, 60)
      .trim();
  /** M5b §5: pages moved into the vault's Trash, by their path there. */
  const trashed: Record<string, { text: string; from: string; at: number }> = {};
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
    // ---- M5b §5: the vault's Trash and Archive (pages only) ----
    entry_trash: (a) => {
      const from = a.path as string;
      const inner = `.trash/${from.split('/').pop()}`;
      trashed[inner] = { text: pages[from], from, at: Date.now() };
      delete pages[from];
      return inner;
    },
    trash_restore: (a) => {
      const { text, from } = trashed[a.path as string];
      pages[from] = text;
      delete trashed[a.path as string];
      return from;
    },
    trash_delete: (a) => {
      for (const p of a.paths as string[]) delete trashed[p];
      return null;
    },
    trash_empty: () => {
      for (const p of Object.keys(trashed)) delete trashed[p];
      return null;
    },
    entry_archive: (a) => {
      const from = a.path as string;
      const to = `.archive/${from}`;
      pages[to] = pages[from];
      delete pages[from];
      return { moved: [[from, to]], updatedFiles: [], updatedLinks: 0, failed: [] };
    },
    archive_restore: (a) => {
      const from = a.path as string;
      const to = from.slice('.archive/'.length);
      pages[to] = pages[from];
      delete pages[from];
      return { moved: [[from, to]], updatedFiles: [], updatedLinks: 0, failed: [] };
    },
    bin_list: () => ({
      trash: Object.entries(trashed).map(([path, t]) => ({
        path,
        from: t.from,
        at: t.at,
        folder: false,
        size: (t.text ?? '').length,
      })),
      archive: Object.keys(pages)
        .filter((p) => p.startsWith('.archive/'))
        .map((path) => ({
          path,
          from: path.slice('.archive/'.length),
          at: 1_760_000_000_000,
          folder: false,
        })),
    }),
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
    vault_tree: () => [
      ...[...new Set([...folders, ...madeFolders])].map((path) => ({
        path,
        kind: 'folder',
        ...(folderIcons[path] ? { icon: folderIcons[path] } : {}),
      })),
      // M5b round 2: the Archive comes with the tree, as its own folder.
      ...(Object.keys(pages).some((p) => p.startsWith('.archive/'))
        ? [{ path: '.archive', kind: 'folder' }]
        : []),
      ...Object.keys(pages).map((path) => {
        // M5b §4: a page's frontmatter emoji, as the index reads it.
        const icon = /^---\n(?:[^\n]*\n)*?icon: (\S+)\n/.exec(pages[path] ?? '')?.[1];
        return {
          path,
          kind: /\.md$/i.test(path) ? 'page' : 'attachment',
          ...(icon ? { icon } : {}),
        };
      }),
    ],
    // ---- M5b §4: folder and vault icons ----
    folder_icon_set: (a) => {
      if (a.icon) folderIcons[a.path as string] = a.icon as string;
      else delete folderIcons[a.path as string];
      return null;
    },
    vault_icon_set: () => null,
    // M5b §19: kept in sessionStorage, so a reload still has them.
    favorites_get: () =>
      JSON.parse(sessionStorage.getItem('nimwMockFavorites') ?? '[]') as string[],
    favorites_set: (a) => {
      const next = (a.paths as string[]).filter((p, i, all) => all.indexOf(p) === i);
      sessionStorage.setItem('nimwMockFavorites', JSON.stringify(next));
      return next;
    },
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
    vault_settings_set: (a) => {
      const patch = a.patch as { attachments?: unknown; attachmentLinkFormat?: string };
      ((w.__nimwVaultPatches ??= []) as unknown[]).push(patch);
      if (patch.attachmentLinkFormat) {
        linkFormat = patch.attachmentLinkFormat === 'default' ? null : patch.attachmentLinkFormat;
      }
      return {
        ...vaultSettings(),
        ...(patch.attachments ? { attachments: patch.attachments } : {}),
      };
    },
    // ---- M4b part 3: files outside the vault (§9) and the Attach button (§7) ----
    links_external: (a) =>
      (a.targets as { kind: string; target: string }[]).map(({ target }) => {
        const f = outside[target];
        return f ? { network: false, askFirst: false, openable: true, ...f } : null;
      }),
    // Final review C1: the user loads a network file; it is found from then on.
    external_network_allow: (a) => {
      ((w.__nimwNetworkLoads ??= []) as unknown[]).push(a.path);
      for (const [target, f] of Object.entries(outside)) {
        if (f.path === a.path) outside[target] = { ...f, askFirst: false, exists: true };
      }
      const f = Object.values(outside).find((o) => o.path === a.path);
      return { network: true, askFirst: false, openable: true, ...f };
    },
    file_pick: () => filePicks,
    external_open: (a) => {
      ((w.__nimwExternalOpens ??= []) as unknown[]).push(a.path);
      return null;
    },
    external_reveal: (a) => {
      ((w.__nimwReveals ??= []) as unknown[]).push(a.path);
      return null;
    },
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
    // ---- M5: search over `pages` (folded word prefixes, the filters, a
    // snippet), close enough to the index for the UI's flows ----
    search: (a) => {
      const q = a.query as {
        text?: string;
        project?: string | null;
        tags?: string[];
        linksTo?: string | null;
        hasImage?: boolean;
        archived?: boolean;
        textFiles?: boolean;
        offset?: number;
      };
      // Batch 6: text and code files are searched by name and content too.
      const isText = (p: string) => !/\.md$/i.test(p);
      const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      const tokens = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).map(fold);
      const words = tokens(q.text ?? '');
      const tagsOf = (path: string) => {
        if (isText(path)) return [];
        const text = pages[path] ?? '';
        const fm = (front(text).tags ?? '').replace(/[[\]]/g, '').split(',');
        const body = [...text.replace(FRONT, '').matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map(
          (m) => m[1],
        );
        return [...new Set([...fm, ...body].map((t) => t.trim()).filter(Boolean))];
      };
      const image = (path: string) =>
        /!\[[^\]]*\]\([^)]+\.(png|jpe?g|gif|webp|svg)\)|!\[\[[^\]]+\.(png|jpe?g|gif|webp|svg)\]\]/i.test(
          pages[path] ?? '',
        );
      const to = q.linksTo ? (resolveName(q.linksTo.replace(/\.md$/, '')) ?? q.linksTo) : null;
      const all = Object.keys(pages).filter((p) =>
        /\.(md|txt|log|csv|json|ya?ml|js|ts|py|rs)$/i.test(p),
      );
      const title = (p: string) => (isText(p) ? p.split('/').pop()! : titleOf(p, pages[p] ?? ''));
      const matches = all
        .filter((p) => q.archived || !p.startsWith('.archive/'))
        .filter((path) => {
          const body = (pages[path] ?? '').replace(FRONT, '');
          const hay = tokens(
            [title(path), path.replace(/\.md$/, ''), tagsOf(path).join(' '), body].join(' '),
          );
          return words.every((w) => hay.some((t) => t.startsWith(w)));
        })
        .filter((p) => !q.project || p.startsWith(`${q.project}/`))
        .filter((p) =>
          (q.tags ?? []).every((t) =>
            tagsOf(p).some((x) => x.toLowerCase() === t.toLowerCase().replace(/^#/, '')),
          ),
        )
        .filter((p) => !to || (!isText(p) && linksOf(p).includes(to)))
        .filter((p) => !q.hasImage || image(p))
        .filter((p) => !q.textFiles || isText(p));
      const recent =
        !words.length && !q.project && !q.tags?.length && !to && !q.hasImage && !q.textFiles;
      const shown = matches.slice(q.offset ?? 0, (q.offset ?? 0) + (recent ? 20 : 50));
      const snippet = (path: string) => {
        if (!words.length) return null;
        const body = (pages[path] ?? '').replace(FRONT, '').replace(/^#.*$/m, '');
        const runs = body.split(/([\p{L}\p{N}]+)/u);
        const at = runs.findIndex((r) => words.some((w) => fold(r).startsWith(w)));
        if (at < 0) return null;
        const part = (r: string[]) => r.join('').replace(/\s+/g, ' ');
        return [
          { text: part(runs.slice(Math.max(0, at - 6), at)), hit: false },
          { text: runs[at], hit: true },
          { text: part(runs.slice(at + 1, at + 8)), hit: false },
        ].filter((x) => x.text);
      };
      const count = (values: string[]) => {
        const m = new Map<string, number>();
        for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
        return [...m].map(([value, n]) => ({ value, count: n }));
      };
      return {
        results: shown.map((path) => ({
          path,
          title: title(path),
          cover: null,
          tags: tagsOf(path),
          hasImage: image(path),
          hasAudio: false,
          snippet: snippet(path),
        })),
        total: recent ? shown.length : matches.length,
        facets: {
          projects: count(matches.filter((p) => p.includes('/')).map((p) => p.split('/')[0])),
          tags: count(matches.flatMap(tagsOf)),
          linksTo: count(matches.filter((p) => !isText(p)).flatMap(linksOf)).map(
            ({ value, count: n }) => ({
              path: value,
              title: titleOf(value, pages[value] ?? ''),
              count: n,
              active: value === to,
            }),
          ),
          linksFrom: null,
          hasImage: matches.filter(image).length,
          hasAudio: 0,
          archived: all.filter((p) => p.startsWith('.archive/')).length,
          textFiles: matches.filter(isText).length,
        },
        recent,
        indexing: false,
      };
    },
    entry_create_folder: (a) => (a.parent ? `${a.parent}/${a.name}` : (a.name as string)),
    scratchpad_default: () => SCRATCH_DEFAULT,
    scratchpad_choose: () => null,
    scratchpad_set: (a) => {
      settings = { ...settings, scratchpadPath: a.path };
      return settings;
    },
    scratchpad_open: () => {
      inScratchpad = true;
      return {
        name: 'Scratchpad',
        root: settings.scratchpadPath,
        scratchpad: true,
        report: {
          files: 0,
          pages: 0,
          parsed: 0,
          skippedUnchanged: 0,
          removed: 0,
          warnings: [],
          durationMs: 1,
        },
      };
    },
    quick_notes_state: () => ({
      folder: inScratchpad ? null : 'Scratchpad',
      autoNamed: [...autoNamed],
    }),
    quick_note_create: (a) => {
      const path = freeName(scratchDir(), a.name as string);
      if (scratchDir()) madeFolders.add(scratchDir());
      pages[path] = '';
      autoNamed.add(path);
      return path;
    },
    quick_note_autoname: (a) => {
      const from = a.path as string;
      const unchanged = { path: from, autoNamed: autoNamed.has(from), outcome: null };
      const stem = stemOf(pages[from] ?? '');
      if (!autoNamed.has(from) || !stem.replace(/-/g, '')) return unchanged;
      const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      const to = freeName(dir, stem, from);
      if (to === from) return unchanged;
      pages[to] = pages[from];
      delete pages[from];
      autoNamed.delete(from);
      autoNamed.add(to);
      return {
        path: to,
        autoNamed: true,
        outcome: { moved: [[from, to]], updatedFiles: [], updatedLinks: 0, failed: [] },
      };
    },
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
