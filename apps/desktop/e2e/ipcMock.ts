// Installed before the app's scripts (page.addInitScript): a fake Tauri IPC
// with one vault holding `remote.md`, then Tauri's freezePrototype.
// Runs in the page, so it must be self-contained.
export function installIpcMock({
  pages,
  editorMode,
}: {
  pages: Record<string, string>;
  editorMode: string;
}) {
  type Args = Record<string, unknown>;
  const w = window as unknown as Record<string, unknown>;
  let nextId = 1;
  const page = (path: string) => ({
    path,
    title: path.replace(/\.md$/, ''),
    subtitle: null,
    cover: 'https://remote.example/cover.png',
    tags: [],
    links: 0,
    backlinks: 0,
    text: pages[path],
    truncated: false,
    binary: false,
  });
  const handlers: Record<string, (a: Args) => unknown> = {
    app_info: () => ({ name: 'Notes In My Way', version: '0.0.0-e2e' }),
    settings_get: () => ({
      settings: {
        version: 1,
        language: 'en',
        theme: 'light',
        rewriteLinks: true,
        confirmDelete: true,
        editorMode,
      },
    }),
    settings_set: (a) => ({
      version: 1,
      language: 'en',
      theme: 'light',
      editorMode,
      ...(a.patch as object),
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
    vault_tree: () => Object.keys(pages).map((path) => ({ path, kind: 'page' })),
    page_get: (a) => page(a.path as string),
    page_read: (a) => ({ text: pages[a.path as string], hash: 'h' }),
    page_write: (a) => {
      // Recorded so tests can assert what an edit saved.
      ((w.__nimwWrites ??= []) as unknown[]).push(a);
      return { hash: 'h2' };
    },
    backlink_count: () => 0,
    links_resolve: (a) =>
      (a.targets as { kind: string; target: string }[]).map(({ target }) => {
        const name = `${target.replace(/^\//, '').replace(/#.*$/, '')}.md`;
        return name in pages ? name : null;
      }),
    'plugin:event|listen': () => nextId++,
    'plugin:event|unlisten': () => null,
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
    invoke: async (cmd: string, args: Args) => {
      const handler = handlers[cmd];
      if (!handler) throw { kind: 'io', message: `not mocked: ${cmd}` };
      return handler(args ?? {});
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
