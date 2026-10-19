// M4b part 2 in the built UI, in Chromium and WebKit (≈ WKWebView): code
// highlighting and its language picker, KaTeX maths, Mermaid diagrams (under
// the frozen Object.prototype Tauri ships with), the outline, word count,
// full page width and text files — without a request leaving the machine.
import { readFileSync } from 'node:fs';
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

const AXE = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the long section.`).join(
  '\n\n',
);

const PAGES: Record<string, string> = {
  'Outline.md': `# One\n\nIntro.\n\n## Two\n\n${LONG}\n\n### Three\n\nThe end.\n`,
  'Words.md': '# Words\n\nOne two three.\n',
  'conf.json': '{\n  "name": "nimw"\n}\n',
  'Code.md': '# Code\n\nIntro.\n\n```js\nconst answer = 42;\n```\n\nAfter.\n',
  'Maths.md': '# Maths\n\nInline $E = mc^2$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter.\n',
  'Diagram.md':
    '# Diagram\n\nBefore.\n\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n\nAfter.\n',
  'Linked.md':
    '# Linked\n\nBefore.\n\n```mermaid\nflowchart LR\n  A[Go] --> B[Stay]\n' +
    '  click A href "https://example.com/x" "Leaves the app"\n```\n\nAfter.\n',
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

async function open(
  page: Page,
  name: string,
  mode = 'livePreview',
  settings: Record<string, unknown> = {},
) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const outside = await watchNetwork(page);
  await page.addInitScript(installIpcMock, {
    pages: { ...PAGES },
    editorMode: mode,
    settings,
    remoteCover: false,
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^vault/ }).click();
  await openItem(page, name);
  return { outside, errors };
}

/** Opens `name` from the explorer of the open vault. */
async function openItem(page: Page, name: string) {
  await page.getByRole('treeitem', { name, exact: true }).click();
  const field = name.includes('.') ? 'File name' : 'Page title';
  await expect(page.getByRole('textbox', { name: field })).toHaveValue(name.replace(/\.\w+$/, ''));
}

const writes = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __nimwWrites?: { path: string; text: string }[] }).__nimwWrites ?? [],
  );

async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    const { axe } = window as unknown as {
      axe: {
        run: (
          el: Element,
          o: object,
        ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
      };
    };
    const res = await axe.run(document.querySelector(sel)!, {
      resultTypes: ['violations'],
      // Pre-existing (M2b feedback round): the "Format" button is named
      // "Formatting toolbar"; not part of this milestone.
      rules: { 'label-content-name-mismatch': { enabled: false } },
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
  }, selector);
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

test('final review I5: a link in a diagram is inert in Split and Live Preview', async ({
  page,
}) => {
  const { outside, errors } = await open(page, 'Linked', 'split');
  const app = page.url();
  const diagram = (where: ReturnType<Page['locator']>) =>
    where.getByRole('img', { name: 'Diagram: flowchart LR' }).locator('svg');
  // The linked node's shape, off its label (WebKit hit-tests a label's
  // foreignObject as the whole <svg>).
  const shapeOfGo = (where: ReturnType<Page['locator']>) =>
    diagram(where).locator('g.node', { hasText: 'Go' }).locator('rect, path, polygon').first();
  const pane = page.getByRole('region', { name: 'Preview' });
  await expect(diagram(pane)).toBeVisible({ timeout: 15_000 });
  await expect(diagram(pane).locator('a')).toHaveCount(0);
  await shapeOfGo(pane).click({ position: { x: 3, y: 3 } });
  await page.getByRole('radio', { name: 'Live Preview' }).click();
  const live = page.locator('.cm-content');
  await expect(diagram(live)).toBeVisible({ timeout: 15_000 });
  await expect(diagram(live).locator('a')).toHaveCount(0);
  await shapeOfGo(live).click({ position: { x: 3, y: 3 } });
  // Still the app: nothing navigated the window.
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Linked');
  expect(page.url()).toBe(app);
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

test('§1: Full width is kept for the page after a reload', async ({ page }) => {
  const { outside, errors } = await open(page, 'Words');
  const host = page.locator('[data-width]');
  await expect(host).toHaveAttribute('data-width', 'readable');
  const full = page.getByRole('button', { name: 'Full width' });
  await full.click();
  await expect(full).toHaveAttribute('aria-pressed', 'true');
  await expect(host).toHaveAttribute('data-width', 'full');
  const measure = await page.locator('.cm-content').evaluate((el) => el.clientWidth);
  expect(measure).toBeGreaterThan(760);
  await page.reload();
  await page.getByRole('button', { name: /^vault/ }).click();
  await openItem(page, 'Words');
  await expect(page.locator('[data-width]')).toHaveAttribute('data-width', 'full');
  await expect(page.getByRole('button', { name: 'Full width' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await stayedLocal(page, outside, errors);
});

test('§2: the language badge picks a language; code takes the palette colours', async ({
  page,
}) => {
  const { outside, errors } = await open(page, 'Code');
  const keyword = page.locator('.cm-nimw-code-keyword').first();
  await expect(keyword).toHaveText('const');
  const colours = await keyword.evaluate((el) => ({
    token: getComputedStyle(el).color,
    text: getComputedStyle(el.closest('.cm-content')!).color,
  }));
  expect(colours.token).not.toBe(colours.text);
  await page.getByRole('button', { name: 'Language: JavaScript' }).click();
  const picker = page.getByRole('combobox', { name: 'Code language' });
  await expect(picker).toBeFocused();
  await picker.fill('python');
  await picker.press('Enter');
  await expect.poll(async () => (await writes(page)).at(-1)?.text ?? '').toContain('```python\n');
  await expect(page.getByRole('button', { name: 'Language: Python' })).toBeVisible();
  // One undo puts the old fence back.
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await writes(page)).at(-1)?.text ?? '').toContain('```js\n');
  await stayedLocal(page, outside, errors);
});

test('§5: the outline jumps to a heading', async ({ page }) => {
  const { outside, errors } = await open(page, 'Outline', 'livePreview', { outline: true });
  const tree = page.getByRole('tree', { name: 'Outline' });
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  await expect(tree.getByRole('treeitem', { name: 'One' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await tree.getByRole('treeitem', { name: 'Three' }).click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await expect(tree.getByRole('treeitem', { name: 'Three' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  // The heading is on screen and the cursor at its text.
  await expect(page.locator('.cm-line', { hasText: 'Three' })).toBeInViewport();
  await page.keyboard.type('X');
  await expect.poll(async () => (await writes(page)).at(-1)?.text ?? '').toContain('### XThree');
  await stayedLocal(page, outside, errors);
});

test('§5: the word count follows typing', async ({ page }) => {
  const { outside, errors } = await open(page, 'Words');
  await expect(page.getByText('4 words · 1 min')).toBeVisible();
  await page.locator('.cm-line', { hasText: 'One two three.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Four five.');
  await expect(page.getByText('6 words · 1 min')).toBeVisible();
  await stayedLocal(page, outside, errors);
});

test('§6: a .json file opens in the text view and saves', async ({ page }) => {
  const { outside, errors } = await open(page, 'conf.json');
  await expect(page.getByText('4 lines · 21 characters')).toBeVisible();
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(page.locator('.cm-nimw-code-string, .cm-nimw-code-function').first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Editor mode' })).toHaveCount(0);
  await page.locator('.cm-line', { hasText: '"name"' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(',');
  await expect
    .poll(async () => (await writes(page)).at(-1))
    .toEqual(expect.objectContaining({ path: 'conf.json', text: '{\n  "name": "nimw",\n}\n' }));
  await stayedLocal(page, outside, errors);
});

for (const theme of ['light', 'dark']) {
  test(`axe-clean: outline, code badge and the text view (${theme})`, async ({ page }) => {
    await open(page, 'Code', 'livePreview', { theme, outline: true });
    await expect(page.getByRole('button', { name: 'Language: JavaScript' })).toBeVisible();
    expect(await axeViolations(page, 'main')).toEqual([]);
    await openItem(page, 'conf.json');
    expect(await axeViolations(page, 'main')).toEqual([]);
  });
}
