import type { Element, Root } from 'hast';
import { describe, expect, it } from 'vitest';
import { parsePage } from './parse';
import { PALETTE, toSafeHast, vaultJoin } from './sanitize';

function elements(tree: Root): Element[] {
  const out: Element[] = [];
  const walk = (n: Root | Element) => {
    for (const c of n.children) {
      if (c.type === 'element') {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(tree);
  return out;
}

const render = (src: string, sourcePath = 'Notes/page.md') =>
  toSafeHast(parsePage(src), { sourcePath });
const html = (src: string) => JSON.stringify(render(src));

describe('sanitizer (M2a §2.4, P4)', () => {
  it('strips scripts, handlers, javascript: URLs, style, iframes and forms', () => {
    const out = html(
      '<script>alert(1)</script>\n\n<img src="a.png" onerror="alert(1)">\n\n' +
        '<a href="javascript:alert(1)">x</a> <span style="color:red">s</span>\n\n' +
        '<iframe src="https://e.com"></iframe>\n\n<form action="/x"><input name="q"></form>\n',
    );
    for (const bad of ['alert', 'onerror', 'javascript', 'style', 'iframe', 'form', '"q"']) {
      expect(out).not.toContain(bad);
    }
  });

  it('keeps allowed formatting HTML and palette colors only', () => {
    const tree = render(
      '<span data-color="red">r</span> <span data-color="url(x)">u</span> <mark>m</mark> <kbd>k</kbd>\n',
    );
    const spans = elements(tree).filter((e) => e.tagName === 'span');
    expect(spans.map((s) => s.properties.dataColor ?? null)).toEqual(['red', null]);
    expect(elements(tree).map((e) => e.tagName)).toEqual(expect.arrayContaining(['mark', 'kbd']));
    expect(PALETTE).toContain('purple');
  });
});

describe('URL policy (M2a §2.4, PG acceptance: no remote request)', () => {
  it('replaces every remote media source with a blocked placeholder', () => {
    const tree = render(
      '![a](https://x.com/p.png)\n\n<img src="https://x.com/q.png">\n\n' +
        '<audio src="http://x.com/a.mp3" controls></audio>\n\n' +
        '<video controls><source src="https://x.com/v.mp4"></video>\n\n' +
        '<img src="local.png" srcset="https://x.com/2x.png 2x">\n',
    );
    const out = JSON.stringify(tree);
    expect(out).not.toMatch(/"src":"https?:/);
    expect(out).not.toContain('srcset');
    const blocked = elements(tree).filter((e) => e.properties.dataNimw === 'remote-blocked');
    expect(blocked.map((b) => b.properties.dataUrl)).toEqual([
      'https://x.com/p.png',
      'https://x.com/q.png',
      'http://x.com/a.mp3',
      'https://x.com/v.mp4',
    ]);
  });

  it('maps vault paths to data-asset-path relative to the page, refusing paths outside the vault', () => {
    const tree = render(
      '![a](img/a.png) <img src="../b.png"> ![c](../../c.png)\n',
      'Notes/page.md',
    );
    const imgs = elements(tree).filter((e) => e.tagName === 'img');
    expect(imgs.map((i) => [i.properties.src ?? null, i.properties.dataAssetPath ?? null])).toEqual(
      [
        [null, 'Notes/img/a.png'],
        [null, 'b.png'],
        [null, null],
      ],
    );
    expect(imgs[2].properties.dataNimw).toBe('missing');
  });

  it('marks external links and internal Markdown links', () => {
    const tree = render('[e](https://e.com) [m](mailto:a@b.c) [p](Other.md#H)\n');
    const links = elements(tree).filter((e) => e.tagName === 'a');
    expect(links.map((a) => [a.properties.dataNimw, a.properties.href ?? null])).toEqual([
      ['external', 'https://e.com'],
      ['external', 'mailto:a@b.c'],
      ['link', null],
    ]);
    expect(links[2].properties.dataTarget).toBe('Notes/Other.md');
    expect(links[2].properties.dataHeading).toBe('H');
  });

  it('vaultJoin normalises relative paths and refuses escapes', () => {
    expect(vaultJoin('A/B/page.md', '../c.png')).toBe('A/c.png');
    expect(vaultJoin('A/page.md', '/root.png')).toBe('root.png');
    expect(vaultJoin('page.md', '../x.png')).toBeNull();
    expect(vaultJoin('A/page.md', 'sub%20dir/x.png')).toBe('A/sub dir/x.png');
  });
});

describe('extension nodes become marked elements', () => {
  it('wikilinks, embeds, tags, highlights, callouts and columns', () => {
    const tree = render(
      '[[Game 1#Plot|play]] ![[a.png|300]] #tag ==hi==\n\n> [!tip]- Fold\n> body\n\n' +
        '::::columns\n:::column\nL\n:::\n::::\n',
    );
    const marks = elements(tree)
      .map((e) => e.properties.dataNimw)
      .filter(Boolean);
    expect(marks).toEqual([
      'wikilink',
      'embed',
      'tag',
      'callout',
      'callout-title',
      'columns',
      'column',
    ]);
    const wl = elements(tree).find((e) => e.properties.dataNimw === 'wikilink')!;
    expect([wl.properties.dataTarget, wl.properties.dataHeading]).toEqual(['Game 1', 'Plot']);
    expect(elements(tree).some((e) => e.tagName === 'mark')).toBe(true);
    const callout = elements(tree).find((e) => e.properties.dataNimw === 'callout')!;
    expect([callout.properties.dataCallout, callout.properties.dataFolded]).toEqual([
      'tip',
      'true',
    ]);
  });

  it('block elements carry their source range for scroll sync and (M4) dragging', () => {
    const src = '# Title\n\nPara one.\n';
    const tree = render(src);
    const p = elements(tree).find((e) => e.tagName === 'p')!;
    expect(
      src.slice(Number(p.properties.dataSourceStart), Number(p.properties.dataSourceEnd)),
    ).toBe('Para one.');
    const h = elements(tree).find((e) => e.tagName === 'h1')!;
    expect(h.properties.id).toBe('title');
  });

  it('frontmatter is not rendered', () => {
    expect(html('---\nsubtitle: S\n---\nBody\n')).not.toContain('subtitle');
  });
});

describe('malformed percent-encoding (I4)', () => {
  it('raw-HTML links with a bare % keep the text as written instead of throwing', () => {
    const tree = render('<a href="#100%">a</a> <a href="B.md#50%">b</a> <a href="C%.md">c</a>');
    const links = elements(tree).filter((e) => e.tagName === 'a');
    expect(links.map((e) => e.properties.dataNimw)).toEqual(['anchor', 'link', 'link']);
    expect(links[1].properties.dataHeading).toBe('50%');
    expect(links[2].properties.dataTarget).toBe('Notes/C%.md');
  });
});
