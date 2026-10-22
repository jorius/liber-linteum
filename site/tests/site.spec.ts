// The showcase site (docs/superpowers/specs/2026-10-21-showcase-site-design.md §5, §7).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

const SITE = join(__dirname, '..');
const AXE = readFileSync(join(SITE, '../apps/desktop/node_modules/axe-core/axe.min.js'), 'utf8');
const RELEASE = readFileSync(join(SITE, 'release.example.json'), 'utf8');
const ASSETS = 'https://github.com/jorius/liber-linteum/releases/latest/download/';

const UA = {
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macos:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

type Dict = Record<'en' | 'es', Record<string, string>>;

/** Every request the page makes, and every one that failed. */
function track(page: Page) {
  const urls: string[] = [];
  const failed: string[] = [];
  const console: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on('requestfailed', (r) => failed.push(`failed ${r.url()}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.push(m.text());
  });
  page.on('pageerror', (e) => console.push(`pageerror: ${e.message}`));
  return { urls, failed, console };
}

/** Scroll top to bottom so every lazy image and observer fires. */
async function walk(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 400) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
    await page.waitForTimeout(30);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForLoadState('networkidle');
}

async function withRelease(page: Page, body: string | null) {
  await page.route('**/release.json', (route) =>
    body === null
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ status: 200, contentType: 'application/json', body }),
  );
}

async function loadDict(page: Page): Promise<Dict> {
  return page.evaluate(async () => (await import('./js/i18n.js')).dict);
}

async function axeClean(page: Page) {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const { axe } = window as unknown as {
      axe: {
        run: (
          el: Element,
          opts: object,
        ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
      };
    };
    const res = await axe.run(document.documentElement, {
      resultTypes: ['violations'],
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`);
  });
  expect(violations).toEqual([]);
}

test.describe('privacy', () => {
  test('makes zero requests to any other origin, and none that fail', async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const net = track(page);
    await page.goto('./');
    await walk(page);
    await page.getByRole('button', { name: 'Español' }).click();
    await walk(page);
    expect(net.urls.length).toBeGreaterThan(5);
    expect(net.urls.filter((u) => new URL(u).origin !== origin)).toEqual([]);
    // Before the first release only release.json is missing. A clip's download
    // the browser cancels when it scrolls away isn't a failure; a 404 would be.
    const media = /\/media\/[\w-]+\.(webm|mp4)$/;
    expect(net.failed.filter((f) => !(f.startsWith('failed ') && media.test(f)))).toEqual([
      '404 /liber-linteum/release.json',
    ]);
    // Only the clips the config lists are fetched, from this site.
    for (const u of net.urls.filter((u) => media.test(u))) {
      expect(new URL(u).pathname).toMatch(
        /\/media\/(hero|obsidian|notion|global-view|atoms|editor|maths|drag-drop|voice|search|encryption|sample-vault)\./,
      );
    }
    expect(net.console.filter((m) => /Content Security Policy|pageerror|i18n/.test(m))).toEqual([]);
  });

  test('the CSP allows only the page itself, with no inline script', async ({ page }) => {
    await page.goto('./');
    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toMatch(/https?:/);
    expect(await page.locator('script:not([src])').count()).toBe(0);
    // Only the clip progress bars' width, set by script (CSSOM, which the
    // CSP allows); no style written into the markup.
    expect(
      await page.evaluate(
        () =>
          [...document.querySelectorAll('[style]')].filter((e) => !e.closest('.clip-bar')).length,
      ),
    ).toBe(0);
  });

  test('every URL in the HTML is relative or an outbound link', async ({ page }) => {
    await page.goto('./');
    const refs = await page.evaluate(() =>
      [...document.querySelectorAll('[src], link[href], use')].map(
        (el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '',
      ),
    );
    for (const ref of refs) expect(ref, ref).not.toMatch(/^(\/|https?:)/);
  });

  test('every outbound link opens in a new tab; in-page anchors stay put', async ({ browser }) => {
    // With a release, an OS and the donate buttons, so every link main.js makes exists too.
    const ctx = await browser.newContext({ userAgent: UA.linux, locale: 'en-US' });
    const page = await ctx.newPage();
    await withRelease(page, RELEASE);
    await page.route('**/js/config.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace('enabled: false', 'enabled: true');
      await route.fulfill({ response: res, body });
    });
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('data-release', 'ready');
    await expect(page.locator('[data-donate]')).toBeVisible();
    const links = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map((a) => ({
          href: a.getAttribute('href')!,
          target: a.getAttribute('target'),
          rel: (a.getAttribute('rel') ?? '').split(/\s+/),
        })),
      );
    const all = await links();
    const outbound = all.filter((l) => /^https?:/i.test(l.href));
    // Static ones, the hero's OS button, file rows, VirusTotal, donate, sample vault, Notion.
    expect(outbound.length).toBeGreaterThan(20);
    for (const l of outbound) {
      expect(l.target, l.href).toBe('_blank');
      expect(l.rel, l.href).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
    for (const l of all.filter((l) => l.href.startsWith('#'))) {
      expect(l.target, l.href).toBeNull();
    }
    // The 404 page has only same-site links, which stay in the tab.
    await page.goto('./no/such/page');
    for (const l of await links()) {
      if (/^https?:/i.test(l.href)) expect(l.target, l.href).toBe('_blank');
      else expect(l.target, l.href).toBeNull();
    }
    await ctx.close();
  });
});

test.describe('languages', () => {
  test('English and Spanish have the same keys, and the HTML uses only those', async ({ page }) => {
    await page.goto('./');
    const dict = await loadDict(page);
    expect(Object.keys(dict.es).sort()).toEqual(Object.keys(dict.en).sort());
    for (const lang of ['en', 'es'] as const) {
      for (const [key, value] of Object.entries(dict[lang])) {
        expect(value.trim(), `${lang} ${key}`).not.toBe('');
      }
    }
    const used = await page.evaluate(() => {
      const keys: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
        keys.push(el.dataset.i18n!);
      }
      for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
        keys.push(el.dataset.i18nHtml!);
      }
      for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
        for (const pair of el.dataset.i18nAttr!.split(',')) keys.push(pair.split(':')[1].trim());
      }
      return keys;
    });
    expect(used.length).toBeGreaterThan(100);
    for (const key of used) expect(dict.en, key).toHaveProperty([key]);
  });

  for (const lang of ['en', 'es'] as const) {
    test(`${lang}: every string is rendered, no raw key shows`, async ({ page }) => {
      const net = track(page);
      await withRelease(page, RELEASE);
      await page.goto('./');
      if (lang === 'es') await page.getByRole('button', { name: 'Español' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      const dict = await loadDict(page);
      const d = dict[lang];
      await expect(page).toHaveTitle(d['meta.title']);
      const wrong = await page.evaluate((strings) => {
        const bad: string[] = [];
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
          if (norm(el.textContent!) !== norm(strings[el.dataset.i18n!])) bad.push(el.dataset.i18n!);
        }
        for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
          for (const pair of el.dataset.i18nAttr!.split(',')) {
            const [attr, key] = pair.split(':').map((s) => s.trim());
            if (el.getAttribute(attr) !== strings[key]) bad.push(`${attr}:${key}`);
          }
        }
        return bad;
      }, d);
      expect(wrong).toEqual([]);
      // No dictionary key leaks into what a visitor reads or hears.
      const text = await page.evaluate(() => {
        const attrs = [...document.querySelectorAll('[aria-label], [alt], [title]')].map(
          (el) =>
            `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('alt') ?? ''} ${el.getAttribute('title') ?? ''}`,
        );
        return `${document.title}\n${document.body.innerText}\n${attrs.join('\n')}`;
      });
      for (const key of Object.keys(d).filter((k) => k.includes('.'))) {
        expect(text, key).not.toContain(key);
      }
      expect(text).not.toMatch(/\{\w+\}/); // unfilled placeholders
      expect(net.console.filter((m) => m.includes('i18n'))).toEqual([]);
    });
  }

  test('the credits read exactly as agreed, in both languages', async ({ page }) => {
    await page.goto('./');
    const credits = page.locator('[data-i18n-html="credit"]');
    await expect(credits).toHaveCount(2);
    for (const c of await credits.all()) {
      await expect(c).toHaveText('An idea by José Meza, built by Jose Ríos.');
    }
    await page.getByRole('button', { name: 'Español' }).click();
    for (const c of await credits.all()) {
      await expect(c).toHaveText('Una idea de José Meza, construida por Jose Ríos.');
    }
    const footer = page.getByRole('contentinfo');
    await expect(footer).toContainText('GPL-3.0-or-later');
    await expect(footer.getByRole('link', { name: 'jorius.github.io' })).toHaveAttribute(
      'href',
      'https://jorius.github.io/',
    );
    await expect(footer).toContainText('React Flow (MIT)');
  });

  test('the first visit follows navigator.languages; a choice is remembered', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ locale: 'es-CO' });
    const page = await ctx.newPage();
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('heading', { level: 2, name: 'Lo que nunca hará' })).toBeVisible();
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await ctx.close();

    const fr = await browser.newContext({ locale: 'fr-FR' });
    const frPage = await fr.newPage();
    await frPage.goto('./');
    await expect(frPage.locator('html')).toHaveAttribute('lang', 'en');
    await fr.close();
  });

  test('works when storage is blocked', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'es-MX' });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    const page = await ctx.newPage();
    const net = track(page);
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(net.console.filter((m) => m.startsWith('pageerror'))).toEqual([]);
    await ctx.close();
  });
});

test.describe('downloads', () => {
  async function openAs(browser: Browser, ua: string, release: string | null = RELEASE) {
    const ctx = await browser.newContext({ userAgent: ua, locale: 'en-US' });
    const page = await ctx.newPage();
    await withRelease(page, release);
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('data-release', /ready|pending/);
    return { ctx, page };
  }

  for (const [os, name, file] of [
    ['linux', 'Linux', 'Liber-Linteum_amd64.deb'],
    ['windows', 'Windows', 'Liber-Linteum_x64-setup.exe'],
    ['macos', 'macOS', 'Liber-Linteum_universal.dmg'],
  ] as const) {
    test(`the primary button is for ${name} on ${name}`, async ({ browser }) => {
      const { ctx, page } = await openAs(browser, UA[os]);
      const buttons = page.locator('.os-buttons a');
      await expect(buttons).toHaveCount(3);
      await expect(buttons.first()).toHaveAttribute('data-os', os);
      await expect(buttons.first()).toHaveClass(/\bdark\b/);
      await expect(buttons.first()).toHaveText(`Download for ${name}`);
      await expect(buttons.first()).toHaveAttribute('href', ASSETS + file);
      await expect(page.locator('.os-buttons a.dark')).toHaveCount(1);
      await expect(page.locator(`.plat[data-platform="${os}"]`)).toHaveClass(/is-mine/);
      // The other two stay as outlined buttons with just their name.
      const others = await buttons.evaluateAll((els) =>
        els.slice(1).map((e) => e.textContent!.trim()),
      );
      expect(others).not.toContain(`Download for ${name}`);
      await ctx.close();
    });
  }

  test('a phone gets no OS button promoted', async ({ browser }) => {
    const { ctx, page } = await openAs(browser, UA.iphone);
    await expect(page.locator('.os-buttons a.dark')).toHaveCount(0);
    await expect(page.locator('.os-buttons a')).toHaveText(['Linux', 'Windows', 'macOS']);
    await ctx.close();
  });

  test('with release.json: version, files, checksums and VirusTotal links', async ({ browser }) => {
    const { ctx, page } = await openAs(browser, UA.linux);
    await expect(page.locator('html')).toHaveAttribute('data-release', 'ready');
    await expect(page.locator('[data-release-version]')).toHaveText('v0.1.0');
    await expect(page.locator('[data-release-pending]')).toBeHidden();
    const linux = page.locator('.plat[data-platform="linux"]');
    await expect(linux.getByRole('link', { name: 'Download .deb' })).toHaveAttribute(
      'href',
      `${ASSETS}Liber-Linteum_amd64.deb`,
    );
    await expect(linux.getByRole('link', { name: 'Liber-Linteum_amd64.AppImage' })).toHaveAttribute(
      'href',
      `${ASSETS}Liber-Linteum_amd64.AppImage`,
    );
    await expect(linux.locator('summary').first()).toHaveText('SHA-256 3f9a…c21e');
    await expect(linux.getByRole('link', { name: 'VirusTotal report' }).first()).toHaveAttribute(
      'href',
      /^https:\/\/www\.virustotal\.com\/gui\/file\/3f9a/,
    );
    await expect(linux).toContainText('8.7 MB');
    // A file with no scan yet says so rather than linking nowhere.
    await expect(page.locator('.plat[data-platform="windows"]')).toContainText(
      'VirusTotal scan pending',
    );
    const sample = page.getByRole('link', { name: 'Download the sample vault (.zip)' });
    await expect(sample).toBeVisible();
    await expect(sample).toHaveAttribute('href', `${ASSETS}The-Moons-of-Kessari.zip`);
    await expect(page.getByText('Unzip it, then choose Open folder as vault.')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Also: the sample Notion export (.zip)' }),
    ).toHaveAttribute('href', `${ASSETS}Notion-Sample-Export.zip`);
    await ctx.close();
  });

  test('the sample vault link takes its name from release.json when it lists one', async ({
    browser,
  }) => {
    const renamed = RELEASE.replace('"The-Moons-of-Kessari.zip"', '"Kessari 2.zip"');
    const { ctx, page } = await openAs(browser, UA.linux, renamed);
    await expect(page.locator('html')).toHaveAttribute('data-release', 'ready');
    await expect(
      page.getByRole('link', { name: 'Download the sample vault (.zip)' }),
    ).toHaveAttribute('href', `${ASSETS}Kessari%202.zip`);
    await ctx.close();
  });

  for (const [label, body] of [
    ['missing', null],
    ['malformed', '{"version": 1, "files": "nope"'],
  ] as const) {
    test(`with release.json ${label}: "First release coming soon" and the repo`, async ({
      browser,
    }) => {
      const { ctx, page } = await openAs(browser, UA.windows, body);
      await expect(page.locator('html')).toHaveAttribute('data-release', 'pending');
      const notice = page.locator('[data-release-pending]');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('First release coming soon.');
      await expect(notice.getByRole('link', { name: 'See the repository' })).toHaveAttribute(
        'href',
        'https://github.com/jorius/liber-linteum',
      );
      await expect(page.locator('[data-release-version]')).toBeHidden();
      await expect(page.locator('[data-release-primary]').first()).toBeHidden();
      await expect(page.locator('.plat-pending').first()).toBeVisible();
      await expect(page.locator('.os-buttons a.dark')).toHaveAttribute('href', '#download');
      // The sample vault has a stable name, so its link is there even before a release.
      const sample = page.getByRole('link', { name: 'Download the sample vault (.zip)' });
      await expect(sample).toBeVisible();
      await expect(sample).toHaveAttribute('href', `${ASSETS}The-Moons-of-Kessari.zip`);
      await expect(page.getByText('Unzip it, then choose Open folder as vault.')).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Also: the sample Notion export (.zip)' }),
      ).toHaveAttribute('href', `${ASSETS}Notion-Sample-Export.zip`);
      await expect(page.getByText('It arrives with the first release.')).toHaveCount(0);
      await ctx.close();
    });
  }
});

test.describe('title', () => {
  test('draws itself once, in about three seconds, then stays filled', async ({ page }) => {
    await page.goto('./');
    const timing = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect).target?.closest('.title-art'))
        .map((a) => {
          const t = a.effect!.getComputedTiming();
          return { end: Number(t.endTime), iterations: t.iterations };
        }),
    );
    expect(timing.length).toBeGreaterThan(12);
    expect(timing.every((t) => t.iterations === 1)).toBe(true);
    const end = Math.max(...timing.map((t) => t.end));
    expect(end).toBeGreaterThan(2500);
    expect(end).toBeLessThanOrEqual(3300);
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const state = await page.evaluate(() => ({
      fills: [...document.querySelectorAll('.title-art .f')].map(
        (p) => getComputedStyle(p).fillOpacity,
      ),
      strokes: [...document.querySelectorAll('.title-art .s')].map(
        (p) => getComputedStyle(p).strokeOpacity,
      ),
    }));
    expect(state.fills).toHaveLength(12);
    expect(new Set(state.fills)).toEqual(new Set(['1']));
    expect(new Set(state.strokes)).toEqual(new Set(['0']));
  });

  test('with reduced motion it is filled at once', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    const state = await page.evaluate(() => ({
      animations: document
        .getAnimations()
        .filter((a) => (a.effect as KeyframeEffect).target?.closest('.title-art')).length,
      fills: [...document.querySelectorAll('.title-art .f')].map(
        (p) => getComputedStyle(p).fillOpacity,
      ),
    }));
    expect(state.animations).toBe(0);
    expect(new Set(state.fills)).toEqual(new Set(['1']));
    await ctx.close();
  });

  test('has one h1 that names the app for assistive tech', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Liber Linteum');
  });
});

test.describe('clips', () => {
  /** A one-second WebM made in the browser, standing in for a real capture. */
  async function makeWebm(browser: Browser): Promise<Buffer> {
    const page = await browser.newPage();
    const b64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const ctx = canvas.getContext('2d')!;
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();
      const start = performance.now();
      let frame = 0;
      await new Promise<void>((done) => {
        const draw = () => {
          ctx.fillStyle = `hsl(${(frame += 7)}, 50%, 60%)`;
          ctx.fillRect(0, 0, 320, 200);
          if (performance.now() - start < 1200) requestAnimationFrame(draw);
          else done();
        };
        draw();
      });
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    });
    await page.close();
    return Buffer.from(b64, 'base64');
  }

  async function withVideos(page: Page, webm: Buffer, videos: string[]) {
    await page.route('**/js/config.js', async (route) => {
      const res = await route.fetch();
      // The setting itself, not the example in the comment above it.
      const body = (await res.text()).replace(
        /^ {2}videos: \[[^\]]*\]/m,
        `  videos: ${JSON.stringify(videos)}`,
      );
      await route.fulfill({ response: res, body });
    });
    await page.route(/\/media\/[\w-]+\.webm$/, (route) =>
      route.fulfill({ status: 200, contentType: 'video/webm', body: webm }),
    );
  }

  const paused = (page: Page, slug: string) =>
    page.locator(`[data-clip="${slug}"] video`).evaluate((v: HTMLVideoElement) => v.paused);

  test('only the visible clip plays, and its button pauses it', async ({ browser }) => {
    const webm = await makeWebm(browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const net = track(page);
    await withVideos(page, webm, ['global-view', 'editor']);
    await page.goto('./');
    const gv = page.locator('[data-clip="global-view"]');
    await expect(gv.locator('video')).toHaveAttribute('poster', 'media/global-view.poster.webp');
    await expect(gv.locator('img')).toHaveCount(0);
    // Not on screen yet: nothing requested.
    expect(net.urls.filter((u) => u.endsWith('.webm'))).toEqual([]);

    await gv.scrollIntoViewIfNeeded();
    await expect.poll(() => paused(page, 'global-view')).toBe(false);
    expect(await paused(page, 'editor')).toBe(true);
    expect(net.urls.some((u) => u.endsWith('editor.webm'))).toBe(false);

    await page
      .locator('[data-clip="editor"]')
      .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect.poll(() => paused(page, 'editor')).toBe(false);
    await expect.poll(() => paused(page, 'global-view')).toBe(true);

    const button = page.locator('[data-clip="editor"] .clip-toggle');
    await expect(button).toHaveAccessibleName('Pause the clip');
    await button.click();
    await expect.poll(() => paused(page, 'editor')).toBe(true);
    await expect(button).toHaveAccessibleName('Play the clip');
    // A clip the visitor paused stays paused when it scrolls back into view.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page
      .locator('[data-clip="editor"]')
      .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    expect(await paused(page, 'editor')).toBe(true);
    expect(net.urls.some((u) => u.endsWith('.mp4'))).toBe(false); // WebM came first and played
    await ctx.close();
  });

  test('with reduced motion a clip shows its poster and waits for play', async ({ browser }) => {
    const webm = await makeWebm(browser);
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await withVideos(page, webm, ['global-view']);
    await page.goto('./');
    const gv = page.locator('[data-clip="global-view"]');
    await gv.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    expect(await paused(page, 'global-view')).toBe(true);
    const button = gv.locator('.clip-toggle');
    await expect(button).toHaveAccessibleName('Play the clip');
    await button.click();
    await expect.poll(() => paused(page, 'global-view')).toBe(false);
    await ctx.close();
  });

  test('a click on a clip opens it large; Esc closes it and the clip plays on', async ({
    browser,
  }) => {
    const webm = await makeWebm(browser);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await withVideos(page, webm, ['global-view', 'editor']);
    await page.goto('./');
    const gv = page.locator('[data-clip="global-view"]');
    await gv.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect.poll(() => paused(page, 'global-view')).toBe(false);
    await expect(gv).toHaveCSS('cursor', 'zoom-in');

    await gv.click({ position: { x: 150, y: 60 } });
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(
      'Cards in the Global View expanding in place to show a folder’s pages.',
    );
    const big = dialog.locator('video');
    await expect(big).toHaveCount(1);
    expect(
      await big.evaluate((v: HTMLVideoElement) => [v.controls, v.muted, v.loop, v.poster]),
    ).toEqual([true, true, true, expect.stringContaining('media/global-view.poster.webp')]);
    await expect.poll(() => big.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    // Inline clips hold still behind it.
    expect(await paused(page, 'global-view')).toBe(true);
    // As large as fits, 16:10, inside the viewport.
    const frame = (await dialog.locator('.lightbox-frame').boundingBox())!;
    expect(frame.width / frame.height).toBeCloseTo(1.6, 1);
    expect(frame.x).toBeGreaterThanOrEqual(16);
    expect(frame.y).toBeGreaterThanOrEqual(16);
    expect(frame.x + frame.width).toBeLessThanOrEqual(1280 - 16);
    expect(frame.y + frame.height).toBeLessThanOrEqual(800 - 16);
    expect(frame.height).toBeGreaterThan(600);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(dialog.locator('video')).toHaveCount(0);
    await expect(gv.getByRole('button', { name: 'Enlarge the clip' })).toBeFocused();
    await expect.poll(() => paused(page, 'global-view')).toBe(false);
    await ctx.close();
  });

  test('keyboard: Enlarge opens it, Close and the backdrop close it, a paused clip stays paused', async ({
    browser,
  }) => {
    const webm = await makeWebm(browser);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await withVideos(page, webm, ['editor']);
    await page.goto('./');
    const editor = page.locator('[data-clip="editor"]');
    await editor.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect.poll(() => paused(page, 'editor')).toBe(false);
    await editor.locator('.clip-toggle').click();
    await expect.poll(() => paused(page, 'editor')).toBe(true);

    const zoom = editor.getByRole('button', { name: 'Enlarge the clip' });
    await zoom.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole('button', { name: 'Close' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(zoom).toBeFocused();

    await page.keyboard.press('Space');
    await expect(dialog).toBeVisible();
    await page.mouse.click(8, 400); // the backdrop, beside the frame
    await expect(dialog).toBeHidden();
    await expect(zoom).toBeFocused();
    // The visitor had paused it; it stays paused.
    await page.waitForTimeout(300);
    expect(await paused(page, 'editor')).toBe(true);
    await ctx.close();
  });

  test('a clip with only a poster opens the poster large, in Spanish too', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'es-CO' });
    const page = await ctx.newPage();
    await page.route('**/js/config.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/^ {2}videos: \[[^\]]*\]/m, '  videos: []');
      await route.fulfill({ response: res, body });
    });
    await page.goto('./');
    const atoms = page.locator('[data-clip="atoms"]');
    await expect(atoms.locator('img')).toHaveCount(1);
    await atoms.getByRole('button', { name: 'Ampliar el clip' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const img = dialog.locator('img');
    await expect(img).toHaveAttribute('src', 'media/atoms.poster.webp');
    await expect(img).toHaveAttribute(
      'alt',
      'Los átomos de una página en la Vista global: sus secciones y bloques como un árbol de tarjetas pequeñas.',
    );
    await expect(dialog.getByRole('button', { name: 'Cerrar' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await ctx.close();
  });

  test('with reduced motion the large clip waits for play', async ({ browser }) => {
    const webm = await makeWebm(browser);
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await withVideos(page, webm, ['search']);
    await page.goto('./');
    const search = page.locator('[data-clip="search"]');
    await search.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await search.getByRole('button', { name: 'Enlarge the clip' }).click();
    const big = page.getByRole('dialog').locator('video');
    await expect
      .poll(() => big.evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(400);
    expect(await big.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await big.evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => big.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    await ctx.close();
  });
});

test.describe('page content', () => {
  test('the hero shows the recorded window whole, with no drawn menu bar', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('.window-bar')).toHaveCount(0);
    await expect(page.locator('.hero-shot')).not.toContainText('File');
    const box = (await page.locator('.clip-hero').boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(1.6, 2);
  });

  test('the feature tour: eight rows, alternating, then the minis', async ({ page }) => {
    await page.goto('./');
    const rows = page.locator('#features .row');
    expect(
      await rows.evaluateAll((els) =>
        els.map((e) => e.querySelector('[data-clip]')!.getAttribute('data-clip')),
      ),
    ).toEqual([
      'global-view',
      'atoms',
      'editor',
      'maths',
      'drag-drop',
      'voice',
      'search',
      'encryption',
    ]);
    expect(await rows.evaluateAll((els) => els.map((e) => e.classList.contains('flip')))).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    await expect(rows.last().locator('.tag')).toHaveText('Beta');
    const minis = page.locator('.minis h3');
    await expect(minis).toContainText(['Find in the page']);
    await expect(minis.filter({ hasText: 'Voice clips' })).toHaveCount(0);
  });
});

test.describe('roadmap', () => {
  const cards = {
    en: {
      nav: 'Roadmap',
      kicker: 'What’s next',
      planned: 'Planned',
      titles: ['Version history', 'Slash menu', 'Focus mode'],
    },
    es: {
      nav: 'Hoja de ruta',
      kicker: 'Lo que viene',
      planned: 'Planeado',
      titles: ['Historial de versiones', 'Menú de barra (/)', 'Modo concentración'],
    },
  };

  for (const lang of ['en', 'es'] as const) {
    test(`${lang}: three planned features, and the nav link scrolls to them`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({ locale: lang === 'es' ? 'es-CO' : 'en-US' });
      const page = await ctx.newPage();
      await page.goto('./');
      const c = cards[lang];
      const section = page.locator('section#roadmap');
      await expect(section).not.toBeInViewport();
      await page.getByRole('navigation').getByRole('link', { name: c.nav, exact: true }).click();
      await expect(page).toHaveURL(/#roadmap$/);
      await expect(section.getByRole('heading', { level: 2 })).toBeInViewport();
      await expect(section.locator('.kicker').first()).toHaveText(c.kicker);
      await expect(section.getByRole('heading', { level: 3 })).toHaveText(c.titles);
      await expect(section.locator('.plan .tag')).toHaveText([c.planned, c.planned, c.planned]);
      await expect(section.getByRole('link')).toHaveAttribute(
        'href',
        'https://github.com/jorius/liber-linteum/issues',
      );
      // It sits after the sample vault and before Support.
      const order = await page.evaluate(() =>
        [...document.querySelectorAll('main > section[id]')].map((s) => s.id),
      );
      expect(order.indexOf('roadmap')).toBe(order.indexOf('vault') + 1);
      expect(order.indexOf('support')).toBe(order.indexOf('roadmap') + 1);
      await ctx.close();
    });
  }
});

test.describe('donations', () => {
  test('hidden until the config enables them', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('[data-donate]')).toBeHidden();
    await expect(page.locator('[data-donate-fallback]')).toBeVisible();
  });

  test('shown, with their links, when enabled', async ({ page }) => {
    await page.route('**/js/config.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text())
        .replace('enabled: false', 'enabled: true')
        .replace('https://ko-fi.com/REPLACE-ME', 'https://ko-fi.com/example');
      await route.fulfill({ response: res, body });
    });
    await page.goto('./');
    await expect(page.getByRole('link', { name: 'Sponsor on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/sponsors/jorius',
    );
    await expect(page.getByRole('link', { name: 'Buy a coffee on Ko-fi' })).toHaveAttribute(
      'href',
      'https://ko-fi.com/example',
    );
    await expect(page.locator('[data-donate-fallback]')).toBeHidden();
  });
});

test.describe('layout and accessibility', () => {
  for (const width of [360, 390, 768, 1440]) {
    test(`no horizontal scroll at ${width} px`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, locale: 'es-CO' });
      const page = await ctx.newPage();
      await withRelease(page, RELEASE);
      await page.goto('./');
      await walk(page);
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
      await ctx.close();
    });
  }

  test('the hero stacks on a phone', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const page = await ctx.newPage();
    await page.goto('./');
    const copy = await page.locator('.hero-copy').boundingBox();
    const shot = await page.locator('.hero-shot').boundingBox();
    expect(shot!.y).toBeGreaterThanOrEqual(copy!.y + copy!.height - 1);
    await ctx.close();
  });

  for (const [label, opts] of [
    ['English, no release', { locale: 'en-US', release: null }],
    ['Spanish, with a release', { locale: 'es-CO', release: RELEASE }],
    ['phone width', { locale: 'en-US', release: RELEASE, width: 360 }],
  ] as const) {
    test(`axe finds no violations (${label})`, async ({ browser }) => {
      const ctx = await browser.newContext({
        locale: opts.locale,
        userAgent: UA.linux,
        viewport: { width: 'width' in opts ? opts.width : 1280, height: 800 },
      });
      const page = await ctx.newPage();
      await withRelease(page, opts.release);
      await page.goto('./');
      await expect(page.locator('html')).toHaveAttribute('data-release', /ready|pending/);
      await walk(page);
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      await axeClean(page);
      await ctx.close();
    });
  }

  test('keyboard: skip link first, then the nav, and visible focus', async ({ page }) => {
    await page.goto('./');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    const landmarks = await page.evaluate(() => ({
      header: document.querySelectorAll('body > header').length,
      main: document.querySelectorAll('main').length,
      footer: document.querySelectorAll('body > footer').length,
      nav: document.querySelectorAll('nav').length,
    }));
    expect(landmarks).toEqual({ header: 1, main: 1, footer: 1, nav: 1 });
  });

  test('reads without JavaScript', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('./');
    await expect(
      page.getByRole('heading', { level: 2, name: 'What it will never do' }),
    ).toBeVisible();
    await expect(page.locator('.os-buttons a')).toHaveCount(3);
    await expect(page.locator('.title-art')).toBeVisible();
    await expect(page.locator('.lang')).toBeHidden();
    await ctx.close();
  });

  test('the 404 page is styled, same-origin and links home', async ({ page }) => {
    const net = track(page);
    const res = await page.goto('./no/such/page');
    expect(res!.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lost in the dunes');
    await expect(page.getByRole('link', { name: 'Back to Liber Linteum' })).toHaveAttribute(
      'href',
      '/liber-linteum/',
    );
    expect(net.failed).toEqual(['404 /liber-linteum/no/such/page']);
    await axeClean(page);
  });
});
