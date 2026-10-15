// Installed before the app's scripts (page.addInitScript): a fake Tauri IPC
// for a single-file window (M4c §3), labelled `file-1`, showing one file.
// Runs in the page, so it must be self-contained.
export function installFileWindowMock({
  name,
  kind,
  text,
  vault = null,
  settings: overrides = {},
}: {
  name: string;
  kind: 'page' | 'text';
  text: string;
  vault?: { root: string; name: string; page: string } | null;
  settings?: Record<string, unknown>;
}) {
  type Args = Record<string, unknown>;
  const w = window as unknown as Record<string, unknown>;
  let nextId = 1;
  let file = name;
  let disk = text;
  let hash = 1;
  let settings: Record<string, unknown> = { editorMode: 'livePreview', ...overrides };
  const calls: [string, Args][] = [];
  w.__nimwCalls = calls;
  w.__nimwDisk = () => disk;
  const handlers: Record<string, (a: Args) => unknown> = {
    app_info: () => ({ name: 'Notes In My Way', version: '0.0.0-e2e' }),
    settings_get: () => ({ settings }),
    settings_set: (a) => {
      settings = { ...settings, ...(a.patch as object) };
      return settings;
    },
    fonts_list: () => [],
    file_info: () => ({ name: file, kind, folder: '/Users/me/Notes', vault }),
    file_read: () => ({ text: disk, hash: `h${hash}` }),
    file_write: (a) => {
      if (a.expectedHash !== `h${hash}`) throw { kind: 'conflict', message: 'changed' };
      disk = a.text as string;
      return { hash: `h${++hash}` };
    },
    file_rename: (a) => (file = a.newName as string),
    file_links_resolve: (a) => (a.targets as unknown[]).map(() => null),
    file_follow: () => 'window',
    file_open_in_vault: () => null,
    'window_close_self': () => null,
    'plugin:event|listen': () => nextId++,
    'plugin:event|unlisten': () => null,
  };
  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'file-1' },
      currentWebview: { windowLabel: 'file-1', label: 'file-1' },
    },
    transformCallback: (cb: unknown) => {
      const id = nextId++;
      w[`_${id}`] = cb;
      return id;
    },
    unregisterCallback: (id: number) => delete w[`_${id}`],
    convertFileSrc: (p: string) => p,
    invoke: async (cmd: string, args: Args) => {
      calls.push([cmd, args ?? {}]);
      const handler = handlers[cmd];
      if (!handler) throw { kind: 'notPermitted', message: `not in a file window: ${cmd}` };
      return handler(args ?? {});
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  w.isTauri = true;
  // tauri.conf.json: "freezePrototype": true
  Object.freeze(Object.prototype);
}
