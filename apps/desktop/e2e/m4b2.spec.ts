// M4b part 2 in the built UI, in Chromium and WebKit (≈ WKWebView): code
// highlighting and its language picker, KaTeX maths, Mermaid diagrams (under
// the frozen Object.prototype Tauri ships with), the outline, word count,
// full page width and text files — without a request leaving the machine.
import { expect, test, type Page } from '@playwright/test';
import { installIpcMock } from './ipcMock';

// One of each kind Mermaid draws: their code pulls in a long tail of
// libraries (dayjs, d3-format, cytoscape, langium…) that must all load with
// Object.prototype frozen, as Tauri ships it.
const KINDS: Record<string, string> = {
  flowchart: 'flowchart LR\n  A[Start] --> B[End]',
  sequenceDiagram: 'sequenceDiagram\n  Alice->>Bob: Hi',
  classDiagram: 'classDiagram\n  Animal <|-- Duck',
  stateDiagram: 'stateDiagram-v2\n  [*] --> Still\n  Still --> [*]',
  erDiagram: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  gantt:
    'gantt\n  dateFormat YYYY-MM-DD\n  section Build\n  Write :a1, 2026-10-01, 3d\n  Test :after a1, 2d',
  pie: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  journey: 'journey\n  title Day\n  section Work\n    Code: 5: Me',
  mindmap: 'mindmap\n  root((Notes))\n    Ideas\n    Tasks',
  timeline: 'timeline\n  2025 : Started\n  2026 : Shipped',
  gitGraph: 'gitGraph\n  commit\n  branch dev\n  commit',
  quadrantChart: 'quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]',
  xychart: 'xychart-beta\n  x-axis [a, b, c]\n  bar [1, 3, 2]',
  sankey: 'sankey-beta\n\nA,B,10\nB,C,5',
  block: 'block-beta\n  columns 2\n  a b',
  packet: 'packet-beta\n  0-15: "Source"\n  16-31: "Dest"',
  architecture:
    'architecture-beta\n  service db(database)[DB]\n  service api(server)[API]\n  db:L -- R:api',
  radar: 'radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}',
  kanban: 'kanban\n  Todo\n    [Write]\n  Done\n    [Plan]',
  requirementDiagram: 'requirementDiagram\n  requirement r {\n    id: 1\n    text: t\n  }',
  C4Context: 'C4Context\n  Person(u, "User")',
  treemap: 'treemap-beta\n"Root"\n    "A": 10\n    "B": 20',
};

const PAGES = {
  'Code.md': '# Code\n\nIntro.\n\n```js\nconst answer = 42;\n```\n\nAfter.\n',
  'Maths.md': '# Maths\n\nInline $E = mc^2$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter.\n',
  'Diagram.md':
    '# Diagram\n\nBefore.\n\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n\nAfter.\n',
  'Kinds.md':
    '# Kinds\n\n' +
    Object.values(KINDS)
      .map((d) => '```mermaid\n' + d + '\n```\n')
      .join('\n'),
};

async function watchNetwork(page: Page) {
  const outside: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    const local =
      (url.protocol === 'http:' && url.hostname === '127.0.0.1') ||
      url.protocol === 'data:' ||
      url.protocol === 'blob:' ||
      url.protocol === 'nimw-asset:' ||
      url.hostname === 'nimw-asset.localhost';
    if (!local) outside.push(r.url());
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|nimw-asset\.localhost)/, (route) => route.abort());
  return outside;
}

async function open(page: Page, name: string, mode = 'livePreview') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const outside = await watchNetwork(page);
  await page.addInitScript(installIpcMock, { pages: { ...PAGES }, editorMode: mode });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue(name);
  return { outside, errors };
}

async function stayedLocal(page: Page, outside: string[], errors: string[]) {
  await page.waitForLoadState('networkidle');
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { __nimwCspViolations: string[] }).__nimwCspViolations,
    ),
  ).toEqual([]);
}

test.use({ viewport: { width: 1280, height: 900 } });

test('§4: a Mermaid diagram draws in Split and Live Preview, offline', async ({ page }) => {
  const { outside, errors } = await open(page, 'Diagram', 'split');
  const pane = page.getByRole('region', { name: 'Preview' });
  await expect(pane.getByRole('img', { name: 'Diagram: flowchart LR' }).locator('svg')).toBeVisible(
    {
      timeout: 15_000,
    },
  );
  await expect(pane.getByText('Start', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Live Preview' }).click();
  await expect(
    page.locator('.cm-content').getByRole('img', { name: 'Diagram: flowchart LR' }).locator('svg'),
  ).toBeVisible({ timeout: 15_000 });
  await stayedLocal(page, outside, errors);
});

test('§4: every kind of Mermaid diagram draws under the frozen prototype', async ({ page }) => {
  test.slow();
  const { outside, errors } = await open(page, 'Kinds', 'split');
  const pane = page.getByRole('region', { name: 'Preview' });
  const drawn = pane
    .getByRole('img', { name: /^Diagram: / })
    .filter({ has: page.locator(':scope > svg') });
  const failed = pane.getByRole('group', { name: "Diagram that couldn't be drawn" });
  await expect
    .poll(async () => (await drawn.count()) + (await failed.count()), { timeout: 30_000 })
    .toBe(Object.keys(KINDS).length);
  // Name the kinds that failed, with Mermaid's message, rather than a count.
  const failures = await failed.evaluateAll((els) =>
    els.map((el) => el.textContent?.replace(/\s+/g, ' ').slice(0, 160)),
  );
  expect(failures).toEqual([]);
  await stayedLocal(page, outside, errors);
});

test('§3: maths renders with KaTeX, fonts from the app', async ({ page }) => {
  const { outside, errors } = await open(page, 'Maths', 'split');
  const pane = page.getByRole('region', { name: 'Preview' });
  await expect(pane.locator('.katex')).toHaveCount(2);
  await expect(pane.locator('.katex-display')).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const katexFont = await page.evaluate(() =>
    [...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded'),
  );
  expect(katexFont).toBe(true);
  await stayedLocal(page, outside, errors);
});
