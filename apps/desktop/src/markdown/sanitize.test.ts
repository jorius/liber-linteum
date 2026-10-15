import type { Element, Root, RootContent } from 'hast';
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

/** The tree as tags, properties and text, source ranges aside. */
function shape(n: Root | RootContent): string {
  if (n.type === 'text') return n.value.replace(/\n/g, '\\n');
  if (n.type === 'root') return n.children.map(shape).join('');
  if (n.type !== 'element') return `[${n.type}]`;
  const props = Object.entries(n.properties)
    .filter(([k]) => !k.startsWith('dataSource'))
    .map(([k, v]) => ` ${k}=${JSON.stringify(v)}`)
    .join('');
  return `<${n.tagName}${props}>${n.children.map(shape).join('')}</${n.tagName}>`;
}

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
    // M4b part 3 §9: a Markdown path above the vault root names a file
    // outside it (Rust decides whether it may be shown).
    expect(imgs[2].properties.dataExternal).toBe('../../c.png');
    expect(imgs[2].properties.dataNimw).toBeUndefined();
  });

  it('M4b part 3 §9: Markdown links and images to files outside the vault', () => {
    const tree = render(
      [
        '![a](D:\\Pics\\a.png) ![b](file:///Users/j/b%20c.png) ![r](/Users/j/r.png)',
        '[doc](file:///D:/Docs/x.pdf#p2) [up](../../Docs/y.pdf)',
        '<img src="file:///Users/j/raw.png"> <img src="../../raw2.png">',
        '',
      ].join('\n'),
      'Notes/page.md',
    );
    const imgs = elements(tree).filter((e) => e.tagName === 'img');
    expect(
      imgs.map((i) => [
        i.properties.dataExternal ?? null,
        i.properties.dataAssetPath ?? null,
        i.properties.src ?? null,
      ]),
    ).toEqual([
      ['D:\\Pics\\a.png', null, null],
      ['file:///Users/j/b c.png', null, null],
      // A leading `/` is the vault root first, then the disk.
      ['/Users/j/r.png', 'Users/j/r.png', null],
      // Raw HTML never reaches outside files (the index doesn't see it).
      [null, null, null],
      [null, null, null],
    ]);
    const links = elements(tree).filter((e) => e.tagName === 'a');
    expect(
      links.map((a) => [a.properties.dataNimw, a.properties.dataExternal, a.properties.href]),
    ).toEqual([
      ['link', 'file:///D:/Docs/x.pdf', undefined],
      ['link', '../../Docs/y.pdf', undefined],
    ]);
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

  it('M4: an HTML block’s first element carries the block’s source range (the drag gutter’s anchor), with no wrapper', () => {
    const src = 'Before\n\n<div class="x">raw <b>html</b></div>\n\n<!-- note -->\n\nAfter\n';
    const tree = render(src);
    const ranged = elements(tree).filter((e) => e.properties.dataSourceStart !== undefined);
    expect(
      ranged.map((e) => [
        e.tagName,
        src.slice(Number(e.properties.dataSourceStart), Number(e.properties.dataSourceEnd)),
      ]),
    ).toEqual([
      ['p', 'Before'],
      ['div', '<div class="x">raw <b>html</b></div>'],
      ['p', 'After'],
    ]);
    // The comment renders nothing, so it has no anchor; the tree is M3b's.
    expect(shape(tree)).toBe('<p>Before</p>\\n<div>raw <b>html</b></div>\\n\\n<p>After</p>');
  });

  it('final review I1: HTML split across blocks renders as at M3b — <details> holds the Markdown after it', () => {
    // The expected shapes are c307c86's (M3b) output for the same notes.
    expect(
      shape(render('<details>\n<summary>More</summary>\n\nHidden *text*\n\n</details>\n')),
    ).toBe('<details>\\n<summary>More</summary>\\n<p>Hidden <em>text</em></p>\\n</details>');
    expect(
      shape(render('<details open>\n<summary>S</summary>\n\n- a\n- b\n\n</details>\n\nAfter\n')),
    ).toBe(
      '<details open=true>\\n<summary>S</summary>\\n<ul>\\n<li>a</li>\\n<li>b</li>\\n</ul>\\n</details>\\n<p>After</p>',
    );
    expect(shape(render('<div align="center">\n\n![[img.png]]\n\n</div>\n'))).toBe(
      '<div>\\n<p><span dataNimw="embed" dataTarget="img.png"></span></p>\\n</div>',
    );
    // The opening block's element is the gutter's anchor; the Markdown inside
    // keeps its own.
    const src = '<details>\n<summary>More</summary>\n\nHidden\n\n</details>\n';
    const ranged = elements(render(src)).filter((e) => e.properties.dataSourceStart !== undefined);
    expect(
      ranged.map((e) => [
        e.tagName,
        src.slice(Number(e.properties.dataSourceStart), Number(e.properties.dataSourceEnd)),
      ]),
    ).toEqual([
      ['details', '<details>\n<summary>More</summary>'],
      ['p', 'Hidden'],
    ]);
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

describe('highlighted code (M4b part 2 §2)', () => {
  const spans = (src: string) => elements(render(src)).filter((e) => e.tagName === 'span');

  it("keeps highlight.js's sub-scope classes: a class name takes the type colour (final review M6)", () => {
    const foo = spans('```js\nclass Foo extends Bar {}\n```\n').find((s) =>
      s.children.some((c) => c.type === 'text' && c.value === 'Foo'),
    );
    expect(foo?.properties.className).toEqual(['hljs-title', 'class_']);
  });

  it('keeps no other class on a span', () => {
    expect(
      spans('<span class="evil hljs-x x_ _x X_ a-b_">s</span>\n').map(
        (s) => s.properties.className,
      ),
    ).toEqual([['hljs-x', 'x_']]);
  });
});
