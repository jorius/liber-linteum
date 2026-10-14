// Installed before the app's scripts (page.addInitScript): a fake Tauri IPC
// with one vault holding `remote.md`, then Tauri's freezePrototype.
// Runs in the page, so it must be self-contained.
export function installIpcMock({
  pages,
  editorMode,
  settings: overrides = {},
  remoteCover = true,
}: {
  pages: Record<string, string>;
  editorMode: string;
  /** Extra settings (palette, fonts, toolbar…) for M2b tests. */
  settings?: Record<string, unknown>;
  /** Pages without a `cover:` get a remote one (the zero-network check). */
  remoteCover?: boolean;
}) {
  type Args = Record<string, unknown>;
  const w = window as unknown as Record<string, unknown>;
  let nextId = 1;
  /** Vault files other than pages (pasted, dropped, covers). */
  const files = new Set<string>();
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
  const titleOf = (path: string, text: string) =>
    /^# (.+)$/m.exec(text)?.[1] ?? path.replace(/\.md$/, '').split('/').pop()!;
  const page = (path: string) => ({
    path,
    title: titleOf(path, pages[path] ?? ''),
    subtitle: front(pages[path] ?? '').subtitle ?? null,
    // M2a's zero-network page keeps a remote cover; M2c pages set their own.
    cover:
      front(pages[path] ?? '').cover ?? (remoteCover ? 'https://remote.example/cover.png' : null),
    coverY: front(pages[path] ?? '')['cover-y'] ? Number(front(pages[path])['cover-y']) : null,
    tags: [],
    links: 0,
    backlinks: 0,
    text: pages[path],
    truncated: false,
    binary: false,
  });
  let settings: Record<string, unknown> = {
    version: 1,
    language: 'en',
    theme: 'light',
    rewriteLinks: true,
    confirmDelete: true,
    editorMode,
    ...overrides,
  };
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
    vault_tree: () => Object.keys(pages).map((path) => ({ path, kind: 'page' })),
    page_get: (a) => page(a.path as string),
    page_read: (a) => ({ text: pages[a.path as string], hash: 'h' }),
    page_write: (a) => {
      // Recorded so tests can assert what an edit saved; kept for page_get.
      ((w.__nimwWrites ??= []) as unknown[]).push(a);
      pages[a.path as string] = a.text as string;
      // A new hash per write: the header refreshes when the hash changes.
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
    vault_settings_get: () => ({
      attachments: { mode: 'subfolder', path: 'attachments' },
      obsidian: null,
    }),
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
