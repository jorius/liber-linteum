import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '../ipc';
import { clearMocks, emit, mockIPC } from '../ipc/testing';
import { usePageStore } from './pageStore';
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';
import { useTrailStore } from './trailStore';
import { useToastStore } from './toastStore';
import { resetVaultStore, useVaultStore } from './vaultStore';

type Handler = (args: Record<string, unknown>) => unknown;

/** A scriptable fake backend for mockIPC. */
function backend(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      const h = handlers[cmd];
      if (!h) return undefined;
      return h((args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const info = { name: 'V', root: '/v', report: { pages: 2, warnings: [] } };
const tree: TreeNode[] = [
  { path: 'A', kind: 'folder' },
  { path: 'A/one.md', kind: 'page' },
  { path: 'A/two.md', kind: 'page' },
  { path: 'b.md', kind: 'page' },
];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  usePageStore.getState().clear();
  useToastStore.getState().clear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, warning: null, loaded: false });
});

afterEach(async () => {
  await resetVaultStore();
  vi.useRealTimers();
  clearMocks();
});

describe('settingsStore', () => {
  it('M2b §7: the defaults match the Rust defaults (settings.rs)', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      palette: 'lavender',
      accentColor: '#d1477a',
      fontLivePreview: 'atkinson-hyperlegible',
      fontSource: 'jetbrains-mono',
      fontSize: 15,
      toolbar: true,
    });
  });

  it('review focus: a settings warning (reset values, unreadable file) is shown as a toast', async () => {
    backend({
      settings_get: () => ({
        settings: DEFAULT_SETTINGS,
        warning: 'settings.json: unrecognised values reset to defaults: theme',
      }),
    });
    await useSettingsStore.getState().load();
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.detail?.some((d) => d.includes('theme')))).toBe(true);
  });

  it('loads before first render and applies theme and language', async () => {
    backend({
      settings_get: () => ({
        settings: { ...DEFAULT_SETTINGS, theme: 'dark', language: 'es' },
      }),
    });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().loaded).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(i18next.language).toBe('es');
  });

  it('M3a: the Global View defaults (Drill-down, every edge kind) fill in for an older backend', async () => {
    const older: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS };
    delete older.globalViewMode;
    delete older.globalViewEdges;
    backend({ settings_get: () => ({ settings: older }) });
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState().settings;
    expect(s.globalViewMode).toBe('drill');
    expect(s.globalViewEdges).toEqual({ links: true, tree: true, manual: true, aggregated: true });
  });

  it('falls back to defaults outside Tauri / on error', async () => {
    backend({
      settings_get: () => {
        throw { kind: 'io', message: 'x' };
      },
    });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('update saves and re-applies', async () => {
    backend({ settings_set: (a) => ({ ...DEFAULT_SETTINGS, ...(a.patch as object) }) });
    await useSettingsStore.getState().update({ theme: 'light' });
    expect(useSettingsStore.getState().settings.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('M2b §4: the palette applies on load and on update', async () => {
    backend({
      settings_get: () => ({ settings: { ...DEFAULT_SETTINGS, palette: 'sepia' } }),
      settings_set: (a) => ({ ...DEFAULT_SETTINGS, ...(a.patch as object) }),
    });
    await useSettingsStore.getState().load();
    expect(document.documentElement.dataset.palette).toBe('sepia');
    await useSettingsStore.getState().update({ palette: 'ink' });
    expect(document.documentElement.dataset.palette).toBe('ink');
  });
});

describe('vaultStore', () => {
  it('M2b §3: renames and trashing in the app update the link trail; a new vault clears it', async () => {
    backend({
      entry_rename: () => ({ moved: [], updatedFiles: [], updatedLinks: 0, failed: [] }),
      entry_trash: () => null,
      vault_tree: () => [],
      vault_open: () => ({ name: 'V', root: '/v', report: { warnings: [] } }),
    });
    const trail = useTrailStore.getState();
    trail.followed({ path: 'Notes/A.md', heading: null });
    trail.followed({ path: 'B.md', heading: null });
    await useVaultStore.getState().rename('Notes', 'Archive');
    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['Archive/A.md', 'B.md']);
    await useVaultStore.getState().trash('B.md');
    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['Archive/A.md']);
    await useVaultStore.getState().open('/v');
    expect(useTrailStore.getState().back).toEqual([]);
  });

  it('final review m4: a failed rename toasts by default (explorer), not when asked to stay quiet (title)', async () => {
    backend({
      entry_rename: () => {
        throw { kind: 'io', message: 'disk is read-only' };
      },
    });
    const loud = await useVaultStore.getState().rename('a.md', 'b.md');
    expect(loud.ok).toBe(false);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'Something went wrong: disk is read-only',
    ]);
    useToastStore.getState().clear();
    const quiet = await useVaultStore.getState().rename('a.md', 'b.md', { quiet: true });
    expect(quiet.ok).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('final review m2: a page removed and re-created in one coalesced change stays on the trail', async () => {
    vi.useFakeTimers();
    let current: TreeNode[] = [
      { path: 'A.md', kind: 'page' },
      { path: 'B.md', kind: 'page' },
      { path: 'C.md', kind: 'page' },
    ];
    backend({ vault_open: () => info, vault_tree: () => current });
    await useVaultStore.getState().open('/v');
    const trail = useTrailStore.getState();
    trail.followed({ path: 'A.md', heading: null });
    trail.followed({ path: 'B.md', heading: null });
    // Another editor saves A.md atomically (delete + re-create); B.md is deleted.
    current = [
      { path: 'A.md', kind: 'page' },
      { path: 'C.md', kind: 'page' },
    ];
    await emit('vault:changed', {
      created: [],
      modified: [],
      removed: ['A.md', 'B.md'],
      renamed: [],
    });
    await emit('vault:changed', { created: ['A.md'], modified: [], removed: [], renamed: [] });
    await vi.advanceTimersByTimeAsync(150);
    expect(useTrailStore.getState().back.map((x) => x.path)).toEqual(['A.md']);
  });

  it('VLT-01 open: closed → opening → open, with tree loaded', async () => {
    const gate = deferred<typeof info>();
    backend({ vault_open: () => gate.promise, vault_tree: () => tree });
    const opening = useVaultStore.getState().open('/v');
    expect(useVaultStore.getState().status).toBe('opening');
    gate.resolve(info);
    await opening;
    const s = useVaultStore.getState();
    expect(s.status).toBe('open');
    expect(s.info?.name).toBe('V');
    expect(s.nodes).toEqual(tree);
  });

  it('open failure returns to closed with a translated toast', async () => {
    backend({
      vault_open: () => {
        throw { kind: 'notFound', message: 'gone' };
      },
    });
    const res = await useVaultStore.getState().open('/gone');
    expect(res.ok).toBe(false);
    expect(useVaultStore.getState().status).toBe('closed');
    expect(useToastStore.getState().toasts[0].message).toBe('Not found.');
  });

  it('open with index warnings shows one toast with details', async () => {
    backend({
      vault_open: () => ({ ...info, report: { pages: 1, warnings: ['bad.md: x', 'locked: y'] } }),
      vault_tree: () => tree,
    });
    await useVaultStore.getState().open('/v');
    const t = useToastStore.getState().toasts[0];
    expect(t.message).toBe('Opened with 2 warnings');
    expect(t.detail).toEqual(['bad.md: x', 'locked: y']);
  });

  /** Review Focus: a slow, older tree response must not overwrite a newer one. */
  it('review_focus stale tree responses are ignored', async () => {
    const first = deferred<TreeNode[]>();
    let n = 0;
    backend({
      vault_open: () => info,
      vault_tree: () => (++n === 2 ? first.promise : n === 3 ? [tree[3]] : tree),
    });
    await useVaultStore.getState().open('/v');
    const slow = useVaultStore.getState().refreshTree();
    await useVaultStore.getState().refreshTree();
    first.resolve(tree);
    await slow;
    expect(useVaultStore.getState().nodes).toEqual([tree[3]]);
  });

  it('EXP-04 rename refreshes, follows selection and reports link updates', async () => {
    let renamed = false;
    backend({
      vault_open: () => info,
      vault_tree: () =>
        renamed ? [tree[0], { path: 'A/uno.md', kind: 'page' }, tree[2], tree[3]] : tree,
      entry_rename: () => {
        renamed = true;
        return {
          moved: [['A/one.md', 'A/uno.md']],
          updatedFiles: ['b.md', 'A/two.md'],
          updatedLinks: 3,
          failed: [],
        };
      },
      page_get: (a) => ({ path: a.path, title: 'T', tags: [], text: '', links: 0, backlinks: 0 }),
    });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('A/one.md');
    await usePageStore.getState().load('A/one.md');
    await useVaultStore.getState().rename('A/one.md', 'A/uno.md');
    expect(useVaultStore.getState().selected).toBe('A/uno.md');
    expect(usePageStore.getState().path).toBe('A/uno.md');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Updated links in 2 files');
  });

  it('rename with failures shows a persistent detail toast', async () => {
    backend({
      vault_open: () => info,
      vault_tree: () => tree,
      entry_rename: () => ({
        moved: [],
        updatedFiles: [],
        updatedLinks: 0,
        failed: [['b.md', 'symlinked note']],
      }),
    });
    await useVaultStore.getState().open('/v');
    await useVaultStore.getState().rename('A/one.md', 'A/x.md');
    const t = useToastStore.getState().toasts.at(-1)!;
    expect(t.message).toBe("Renamed. 1 file couldn't be updated");
    expect(t.detail).toEqual(['b.md — symlinked note']);
  });

  it('EXP-03 trash moves selection to the next sibling, then the parent', async () => {
    let current = tree;
    backend({
      vault_open: () => info,
      vault_tree: () => current,
      entry_trash: (a) => {
        current = current.filter((n) => n.path !== a.path);
      },
    });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('A/one.md');
    await useVaultStore.getState().trash('A/one.md');
    expect(useVaultStore.getState().selected).toBe('A/two.md');
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Moved to Trash');
    await useVaultStore.getState().trash('A/two.md');
    expect(useVaultStore.getState().selected).toBe('A');
  });

  it('EXP-02 create page picks a free name, selects it and starts inline rename', async () => {
    let current = tree;
    backend({
      vault_open: () => info,
      vault_tree: () => current,
      entry_create_page: (a) => {
        const path = `${a.dir}/${a.name}.md`;
        current = [...current, { path, kind: 'page' }];
        return path;
      },
    });
    await useVaultStore.getState().open('/v');
    const res = await useVaultStore.getState().createPage('A');
    expect(res.ok && res.value).toBe('A/Untitled.md');
    const s = useVaultStore.getState();
    expect(s.selected).toBe('A/Untitled.md');
    expect(s.expanded.has('A')).toBe(true);
    expect(s.renaming).toBe('A/Untitled.md');
  });

  it('VLT-04 external changes are coalesced into one tree refresh', async () => {
    vi.useFakeTimers();
    const calls = backend({ vault_open: () => info, vault_tree: () => tree });
    await useVaultStore.getState().open('/v');
    const before = calls.filter((c) => c === 'vault_tree').length;
    for (let i = 0; i < 3; i++) {
      await emit('vault:changed', {
        created: [`n${i}.md`],
        modified: [],
        removed: [],
        renamed: [],
      });
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(calls.filter((c) => c === 'vault_tree').length).toBe(before);
    await vi.advanceTimersByTimeAsync(5);
    expect(calls.filter((c) => c === 'vault_tree').length).toBe(before + 1);
  });

  it('VLT-04 an external rename of the selected page moves the selection', async () => {
    vi.useFakeTimers();
    let current = tree;
    backend({ vault_open: () => info, vault_tree: () => current });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('A/one.md');
    current = [tree[0], { path: 'A/1.md', kind: 'page' }, tree[2], tree[3]];
    await emit('vault:changed', {
      created: [],
      modified: [],
      removed: [],
      renamed: [['A/one.md', 'A/1.md']],
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(useVaultStore.getState().selected).toBe('A/1.md');
  });

  /** Review Focus: the selected item's parent folder is deleted outside the app. */
  it('review_focus selection falls back to the nearest existing ancestor', async () => {
    vi.useFakeTimers();
    let current: TreeNode[] = [
      { path: 'X', kind: 'folder' },
      { path: 'X/Y', kind: 'folder' },
      { path: 'X/Y/z.md', kind: 'page' },
    ];
    backend({ vault_open: () => info, vault_tree: () => current });
    await useVaultStore.getState().open('/v');
    useVaultStore.getState().select('X/Y/z.md');
    useVaultStore.getState().toggle('X/Y');
    current = [{ path: 'X', kind: 'folder' }];
    await emit('vault:changed', { created: [], modified: [], removed: ['X/Y'], renamed: [] });
    await vi.advanceTimersByTimeAsync(150);
    const s = useVaultStore.getState();
    expect(s.selected).toBe('X');
    expect(s.expanded.has('X/Y')).toBe(false);
  });

  it('vault warnings become toasts; close resets everything', async () => {
    backend({ vault_open: () => info, vault_tree: () => tree, vault_close: () => undefined });
    await useVaultStore.getState().open('/v');
    await emit('vault:warning', { message: 'locked: not readable' });
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('locked: not readable');
    await useVaultStore.getState().close();
    const s = useVaultStore.getState();
    expect(s.status).toBe('closed');
    expect(s.nodes).toEqual([]);
    expect(s.selected).toBeNull();
  });
});

describe('pageStore', () => {
  it('EXP-05 loads a page and reacts to external modify, rename and delete', async () => {
    let title = 'One';
    backend({
      page_get: (a) => ({ path: a.path, title, tags: [], text: 'x', links: 0, backlinks: 0 }),
    });
    await usePageStore.getState().load('A/one.md');
    expect(usePageStore.getState().state).toBe('ready');
    title = 'Changed';
    await usePageStore
      .getState()
      .onExternalChange({ created: [], modified: ['A/one.md'], removed: [], renamed: [] });
    expect(usePageStore.getState().page?.title).toBe('Changed');
    await usePageStore.getState().onExternalChange({
      created: [],
      modified: [],
      removed: [],
      renamed: [['A/one.md', 'A/1.md']],
    });
    expect(usePageStore.getState().path).toBe('A/1.md');
    await usePageStore
      .getState()
      .onExternalChange({ created: [], modified: [], removed: ['A'], renamed: [] });
    expect(usePageStore.getState().state).toBe('deleted');
  });
});

describe('pageStore — atomic saves (final review, upgraded M7)', () => {
  it('EXP-05 a page removed and recreated in one batch reloads instead of showing "deleted"', async () => {
    let title = 'One';
    backend({
      page_get: (a) => ({ path: a.path, title, tags: [], text: 'x', links: 0, backlinks: 0 }),
    });
    await usePageStore.getState().load('a.md');
    title = 'Saved by another editor';
    await usePageStore
      .getState()
      .onExternalChange(
        { created: ['a.md'], modified: [], removed: ['a.md'], renamed: [] },
        (p) => p === 'a.md',
      );
    expect(usePageStore.getState().state).toBe('ready');
    expect(usePageStore.getState().page?.title).toBe('Saved by another editor');
  });

  it('EXP-05 a deleted page recovers when it is recreated later', async () => {
    backend({
      page_get: (a) => ({
        path: a.path,
        title: 'Back',
        tags: [],
        text: 'x',
        links: 0,
        backlinks: 0,
      }),
    });
    await usePageStore.getState().load('a.md');
    await usePageStore
      .getState()
      .onExternalChange({ created: [], modified: [], removed: ['a.md'], renamed: [] }, () => false);
    expect(usePageStore.getState().state).toBe('deleted');
    await usePageStore
      .getState()
      .onExternalChange({ created: ['a.md'], modified: [], removed: [], renamed: [] }, () => true);
    expect(usePageStore.getState().state).toBe('ready');
  });
});

describe('toastStore', () => {
  it('auto-dismisses after 5 s unless the toast has details', async () => {
    vi.useFakeTimers();
    useToastStore.getState().push({ message: 'short' });
    useToastStore.getState().push({ message: 'long', detail: ['a'] });
    await vi.advanceTimersByTimeAsync(5001);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['long']);
  });
});

describe('vaultStore — event subscriptions refused (real-window regression)', () => {
  /** Backend where every event subscription is refused, as when the
   *  capability lacked core:event:allow-listen. */
  function refusingEvents(handlers: Record<string, Handler>) {
    mockIPC((cmd, args) => {
      if (cmd.startsWith('plugin:event|')) {
        throw new Error('event.listen not allowed');
      }
      const h = handlers[cmd];
      return h ? h((args ?? {}) as Record<string, unknown>) : undefined;
    });
  }

  it('VLT-01 opening never gets stuck when progress/change events cannot be subscribed', async () => {
    refusingEvents({ vault_open: () => info, vault_tree: () => tree });
    const res = await useVaultStore.getState().open('/v');
    expect(res.ok).toBe(true);
    expect(useVaultStore.getState().status).toBe('open');
    expect(useVaultStore.getState().nodes.map((n) => n.path)).toContain('b.md');
    expect(useToastStore.getState().toasts.some((t) => t.tone === 'error')).toBe(true);
  });

  it('VLT-01 a failing open after refused subscriptions returns to the welcome screen', async () => {
    refusingEvents({
      vault_open: () => {
        throw { kind: 'notFound', message: 'gone' };
      },
    });
    const res = await useVaultStore.getState().open('/v');
    expect(res.ok).toBe(false);
    expect(useVaultStore.getState().status).toBe('closed');
  });
});
