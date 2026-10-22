// Draws the placeholder posters in site/media/ (WebP, 1440×900) until the real captures exist.
// Each is a quiet sketch of the app's screen for that clip, in the site's palette, with no text,
// so it needs no translation. The real capture work overwrites these files (media/README.md).
//
// Usage, from the repo root after `pnpm install`:
//   node site/tools/make-posters.mjs              # every slot (overwrites real posters too)
//   node site/tools/make-posters.mjs atoms voice  # only these slots
// It uses the Playwright Chromium that the desktop app's tests already install.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(`${root}apps/desktop/package.json`);
const { chromium } = require('@playwright/test');

const W = 1440;
const H = 900;
const C = {
  paper: '#fbf5e8',
  card: '#fffaf0',
  side: '#f4ead6',
  rule: '#e6d3ad',
  line: '#e2d0ae',
  ink: '#2a1c10',
  ink2: '#5b4128',
  spice: '#9c4a17',
  sand: '#e9d3a6',
  dune: '#cf9f5d',
  dune2: '#b97f3f',
  night: '#1f1a14',
};

const bar = (x, y, w, h = 10, fill = C.line, r = 5) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;

let coverN = 0;
function cover(x, y, w, h) {
  const id = `cv${coverN++}`;
  const sunX = x + w * (0.25 + ((coverN * 37) % 50) / 100);
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f3e6c9"/><stop offset=".6" stop-color="#e9d3a6"/><stop offset="1" stop-color="#d9b67c"/></linearGradient>
      <clipPath id="${id}c"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/></clipPath></defs>
    <g clip-path="url(#${id}c)">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>
      <circle cx="${sunX}" cy="${y + h * 0.42}" r="${h * 0.2}" fill="#fffaf0" opacity=".85"/>
      <path d="M${x} ${y + h * 0.75} C ${x + w * 0.3} ${y + h * 0.6}, ${x + w * 0.6} ${y + h * 0.82}, ${x + w} ${y + h * 0.68} V ${y + h} H ${x}Z" fill="${C.dune}" opacity=".7"/>
      <path d="M${x} ${y + h * 0.88} C ${x + w * 0.4} ${y + h * 0.78}, ${x + w * 0.7} ${y + h * 0.92}, ${x + w} ${y + h * 0.84} V ${y + h} H ${x}Z" fill="${C.dune2}" opacity=".6"/>
    </g>`;
}

function card(x, y, w = 230, h = 214) {
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
    ${cover(x + 8, y + 8, w - 16, h * 0.46)}
    ${bar(x + 16, y + h * 0.46 + 24, w * 0.55, 12, C.ink2, 6)}
    ${bar(x + 16, y + h * 0.46 + 46, w * 0.75)}
    ${bar(x + 16, y + h * 0.46 + 64, w * 0.62)}
    ${bar(x + 16, y + h * 0.46 + 82, w * 0.4)}
  </g>`;
}

function chrome(content, { sidebar = true } = {}) {
  const tree = [];
  if (sidebar) {
    for (let i = 0; i < 14; i++) {
      const indent = [0, 1, 1, 2, 2, 1, 0, 1, 1, 0, 1, 2, 1, 0][i] * 18;
      tree.push(bar(32 + indent, 104 + i * 34, 120 - indent + ((i * 29) % 50), 10));
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${C.paper}"/>
    ${sidebar ? `<rect width="248" height="${H}" fill="${C.side}"/><rect x="248" width="1.5" height="${H}" fill="${C.rule}"/>${bar(32, 40, 150, 14, C.ink2, 7)}${tree.join('')}` : ''}
    <g>
      <rect x="${sidebar ? 640 : 560}" y="24" width="300" height="40" rx="20" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
      <rect x="${sidebar ? 644 : 564}" y="28" width="146" height="32" rx="16" fill="${C.ink}"/>
      ${bar(sidebar ? 690 : 610, 40, 54, 8, C.sand, 4)}
      ${bar(sidebar ? 838 : 758, 40, 60, 8, C.line, 4)}
    </g>
    ${content}
  </svg>`;
}

function edge(x1, y1, x2, y2, dashed = false) {
  const mx = (x1 + x2) / 2;
  return `<path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${C.spice}" stroke-opacity=".45" stroke-width="2.5" ${dashed ? 'stroke-dasharray="8 7"' : ''}/>`;
}

function canvasView(seed = 0) {
  const pos = [
    [330, 120],
    [640, 96],
    [950, 150],
    [430, 420],
    [760, 470],
    [1110, 450],
  ].map(([x, y], i) => [x + ((seed * 31 + i * 17) % 40) - 20, y + ((seed * 13 + i * 23) % 30)]);
  const edges = [
    [0, 1],
    [1, 2],
    [0, 3],
    [1, 4],
    [3, 4],
    [4, 5],
    [2, 5],
  ];
  const lines = edges
    .map(([a, b], i) =>
      edge(pos[a][0] + 230, pos[a][1] + 107, pos[b][0], pos[b][1] + 107, i % 3 === 2),
    )
    .join('');
  return chrome(lines + pos.map(([x, y]) => card(x, y)).join(''));
}

function editorView() {
  const x = 380;
  const lines = [];
  let y = 400;
  for (let i = 0; i < 4; i++) lines.push(bar(x, (y += 26), 640 - ((i * 53) % 160)));
  y += 34;
  const callout = `<rect x="${x}" y="${y}" width="680" height="96" rx="8" fill="#fff3dc"/>
    <rect x="${x}" y="${y}" width="5" height="96" rx="2" fill="${C.spice}"/>
    ${bar(x + 24, y + 22, 140, 12, C.spice, 6)}${bar(x + 24, y + 48, 560)}${bar(x + 24, y + 66, 420)}`;
  y += 124;
  const code = `<rect x="${x}" y="${y}" width="680" height="120" rx="8" fill="${C.night}"/>
    ${bar(x + 24, y + 26, 220, 9, '#e9a45f', 4)}${bar(x + 48, y + 50, 300, 9, '#cdb894', 4)}${bar(x + 48, y + 72, 250, 9, '#8fb3a0', 4)}${bar(x + 24, y + 94, 90, 9, '#cdb894', 4)}`;
  const drag = `<g opacity=".95"><rect x="${x + 90}" y="${y - 70}" width="600" height="40" rx="6" fill="${C.card}" stroke="${C.spice}" stroke-width="2"/>${bar(x + 110, y - 55, 380)}</g>`;
  return chrome(
    `${cover(300, 96, 1100, 170)}
     <rect x="${x - 4}" y="236" width="64" height="64" rx="14" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
     <circle cx="${x + 28}" cy="268" r="16" fill="${C.dune}"/>
     ${bar(x, 324, 420, 26, C.ink, 10)}${bar(x, 366, 280, 12, C.ink2, 6)}
     ${lines.join('')}${callout}${code}${drag}`,
  );
}

function encryptionView() {
  const cx = W / 2;
  return chrome(
    `<rect width="${W}" height="${H}" fill="${C.ink}" opacity=".18"/>
     <rect x="${cx - 260}" y="210" width="520" height="430" rx="16" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
     <circle cx="${cx}" cy="300" r="46" fill="#fff3dc" stroke="${C.rule}" stroke-width="1.5"/>
     <g fill="none" stroke="${C.ink}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
       <rect x="${cx - 20}" y="292" width="40" height="30" rx="5"/><path d="M${cx - 12} 292v-10a12 12 0 0 1 24 0v10"/></g>
     ${bar(cx - 120, 374, 240, 16, C.ink, 8)}${bar(cx - 170, 404, 340, 10)}
     <rect x="${cx - 200}" y="446" width="400" height="52" rx="8" fill="${C.paper}" stroke="${C.dune}" stroke-width="2"/>
     ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `<circle cx="${cx - 176 + i * 22}" cy="472" r="5" fill="${C.ink2}"/>`).join('')}
     <rect x="${cx - 200}" y="528" width="190" height="48" rx="8" fill="none" stroke="${C.ink}" stroke-width="1.5"/>
     <rect x="${cx + 10}" y="528" width="190" height="48" rx="8" fill="${C.ink}"/>
     ${bar(cx - 140, 548, 70, 9, C.ink2, 4)}${bar(cx + 70, 548, 70, 9, C.sand, 4)}`,
    { sidebar: false },
  );
}

function searchView() {
  const x = 330;
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const y = 240 + i * 104;
    rows.push(`<rect x="${x}" y="${y}" width="980" height="88" rx="10" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
      ${bar(x + 24, y + 20, 260 - ((i * 37) % 90), 12, C.ink2, 6)}
      ${bar(x + 24, y + 46, 520 + ((i * 41) % 200))}
      ${bar(x + 120 + ((i * 53) % 200), y + 44, 90, 14, '#f3c98f', 4)}
      ${bar(x + 24, y + 66, 300)}`);
  }
  const chips = ['folder', 'tag', 'links'].map(
    (_, i) =>
      `<rect x="${x + i * 150}" y="182" width="136" height="34" rx="17" fill="${i < 2 ? '#fff3dc' : C.card}" stroke="${i < 2 ? '#ecd2a8' : C.rule}" stroke-width="1.5"/>${bar(x + 22 + i * 150, 195, 90, 8, i < 2 ? C.spice : C.line, 4)}`,
  );
  return chrome(
    `<rect x="${x}" y="100" width="980" height="60" rx="12" fill="${C.card}" stroke="${C.dune}" stroke-width="2"/>
     <circle cx="${x + 34}" cy="128" r="11" fill="none" stroke="${C.ink2}" stroke-width="3"/><path d="M${x + 42} 136l9 9" stroke="${C.ink2}" stroke-width="3" stroke-linecap="round"/>
     ${bar(x + 64, 123, 240, 12, C.ink, 6)}<rect x="${x + 308}" y="114" width="2.5" height="28" fill="${C.ink}"/>
     ${chips.join('')}${rows.join('')}`,
  );
}

function obsidianView() {
  const folder = (x, y) =>
    `<path d="M${x} ${y + 4}a3 3 0 0 1 3-3h7l3 3h11a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H${x + 3}a3 3 0 0 1-3-3z" fill="none" stroke="${C.spice}" stroke-width="2"/>`;
  const tree = [];
  for (let i = 0; i < 9; i++) {
    const y = 120 + i * 62;
    const indent = [0, 1, 1, 0, 1, 2, 2, 1, 0][i] * 26;
    tree.push(
      folder(300 + indent, y) + bar(342 + indent, y + 6, 160 + ((i * 47) % 120), 12, C.ink2, 6),
    );
  }
  const right = [card(860, 120, 250, 230), card(1130, 140, 250, 230), card(990, 420, 250, 230)];
  return chrome(
    `<rect x="270" y="90" width="520" height="620" rx="12" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>${tree.join('')}
     ${edge(1110, 235, 1130, 255)}${edge(985, 350, 1115, 420, true)}${right.join('')}`,
  );
}

function notionView() {
  const cx = W / 2;
  const checks = [0, 1, 2, 3].map(
    (
      i,
    ) => `<circle cx="${cx - 190}" cy="${430 + i * 44}" r="11" fill="${i < 3 ? C.spice : 'none'}" stroke="${C.spice}" stroke-width="2"/>
      ${i < 3 ? `<path d="M${cx - 195} ${430 + i * 44}l4 4 7-8" fill="none" stroke="${C.card}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
      ${bar(cx - 164, 425 + i * 44, 220 + ((i * 61) % 120), 10, i < 3 ? C.ink2 : C.line)}`,
  );
  return chrome(
    `<rect width="${W}" height="${H}" fill="${C.ink}" opacity=".14"/>
     <rect x="${cx - 240}" y="170" width="480" height="520" rx="16" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
     ${bar(cx - 200, 212, 220, 18, C.ink, 9)}${bar(cx - 200, 248, 320, 10)}
     <rect x="${cx - 200}" y="284" width="400" height="64" rx="10" fill="${C.paper}" stroke="${C.rule}" stroke-width="1.5"/>
     <rect x="${cx - 184}" y="298" width="30" height="36" rx="4" fill="${C.sand}"/>${bar(cx - 140, 305, 170, 11, C.ink2, 5)}${bar(cx - 140, 324, 90, 8)}
     <rect x="${cx - 200}" y="370" width="400" height="10" rx="5" fill="${C.line}"/><rect x="${cx - 200}" y="370" width="290" height="10" rx="5" fill="${C.spice}"/>
     ${checks.join('')}
     <rect x="${cx + 40}" y="620" width="160" height="44" rx="8" fill="${C.ink}"/>${bar(cx + 80, 638, 80, 9, C.sand, 4)}`,
    { sidebar: false },
  );
}

function atomsView() {
  // A page card on the left, its atoms as a tree of small cards to the right.
  const atom = (x, y, w, kind) => {
    const inner = {
      text: `${bar(x + 14, y + 18, w * 0.6, 8)}${bar(x + 14, y + 34, w * 0.42, 8)}`,
      list: [0, 1, 2]
        .map(
          (i) =>
            `<circle cx="${x + 18}" cy="${y + 16 + i * 14}" r="3" fill="${C.spice}"/>${bar(x + 28, y + 12 + i * 14, w * 0.5, 8)}`,
        )
        .join(''),
      code: `<rect x="${x + 10}" y="${y + 10}" width="${w - 20}" height="34" rx="5" fill="${C.night}"/>${bar(x + 18, y + 18, w * 0.4, 6, '#e9a45f', 3)}${bar(x + 18, y + 30, w * 0.55, 6, '#cdb894', 3)}`,
      callout: `<rect x="${x + 10}" y="${y + 10}" width="${w - 20}" height="34" rx="5" fill="#fff3dc"/><rect x="${x + 10}" y="${y + 10}" width="4" height="34" fill="${C.spice}"/>${bar(x + 22, y + 22, w * 0.5, 8, C.spice, 4)}`,
      maths: `<path d="M${x + 16} ${y + 34}l8-20 8 20M${x + 44} ${y + 20}h16M${x + 52} ${y + 12}v16" fill="none" stroke="${C.ink2}" stroke-width="3" stroke-linecap="round"/>${bar(x + 72, y + 20, w * 0.3, 8)}`,
      image: `${cover(x + 10, y + 8, w - 20, 38)}`,
    }[kind];
    return `<rect x="${x}" y="${y}" width="${w}" height="56" rx="8" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>${inner}`;
  };
  const kinds = ['text', 'list', 'callout', 'code', 'maths', 'image', 'text', 'list'];
  const items = [];
  const links = [];
  kinds.forEach((kind, i) => {
    const col = i < 3 ? 0 : 1;
    const x = 760 + col * 300 + (i % 2) * 20;
    const y = 120 + (col ? i - 3 : i) * 130 + col * 40;
    items.push(atom(x, y, 240, kind));
    links.push(edge(col ? 1000 : 560, col ? 230 + (i % 3) * 40 : 330, x, y + 28));
  });
  return chrome(
    `${links.join('')}${card(330, 220, 230, 214)}
     <rect x="${730}" y="96" width="${1380 - 730}" height="${H - 160}" rx="14" fill="none" stroke="${C.rule}" stroke-width="1.5" stroke-dasharray="6 6"/>
     ${items.join('')}`,
  );
}

function mathsView() {
  // Split: source on the left, the rendered page on the right.
  const src = [];
  for (let i = 0; i < 14; i++) {
    const y = 130 + i * 38;
    const w = 180 + ((i * 67) % 220);
    const fill = [2, 3, 7, 8, 9, 10].includes(i) ? '#e9a45f' : C.line;
    src.push(bar(300 + (i % 4 === 3 ? 24 : 0), y, w, 10, fill));
  }
  const node = (x, y, w = 130) =>
    `<rect x="${x}" y="${y}" width="${w}" height="46" rx="8" fill="${C.card}" stroke="${C.spice}" stroke-width="2"/>${bar(x + 20, y + 18, w - 40, 9, C.ink2, 4)}`;
  const arrow = (x1, y1, x2, y2) =>
    `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${C.spice}" stroke-width="2.5" stroke-opacity=".7"/>`;
  return chrome(
    `<rect x="270" y="100" width="530" height="${H - 140}" rx="10" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
     ${src.join('')}
     <rect x="830" y="100" width="560" height="${H - 140}" rx="10" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
     ${bar(870, 140, 260, 18, C.ink, 9)}${bar(870, 176, 420)}
     <g fill="none" stroke="${C.ink}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
       <path d="M940 250h70M975 222v56M1040 268l20-40 20 40M1110 250h40M1110 236v28M1170 236c20 0 20 28 0 28"/>
       <path d="M920 300h280"/>
       <path d="M1000 320l22 24 22-24M1070 330h50"/>
     </g>
     ${node(990, 400)}${arrow(1055, 446, 960, 500)}${arrow(1055, 446, 1150, 500)}
     ${node(895, 500)}${node(1085, 500)}${arrow(960, 546, 1055, 600)}${arrow(1150, 546, 1055, 600)}
     ${node(990, 600)}
     ${bar(870, 700, 440)}${bar(870, 720, 300)}`,
  );
}

function dragDropView() {
  // The sidebar's own tree (from chrome) with one folder lit up as the drop target.
  const tree = [
    `<rect x="16" y="398" width="216" height="32" rx="6" fill="#fff3dc" stroke="${C.spice}" stroke-width="2"/>${bar(32, 410, 140, 10, C.spice)}`,
  ];
  const x = 380;
  const lines = [];
  let y = 140;
  for (let i = 0; i < 12; i++) {
    if (i === 5) {
      lines.push(`<rect x="${x}" y="${y + 6}" width="700" height="3" rx="1.5" fill="${C.spice}"/>`);
      y += 22;
      continue;
    }
    lines.push(bar(x, (y += 34), 640 - ((i * 53) % 200)));
  }
  const handle = (hx, hy) =>
    [0, 1, 2]
      .map((r) =>
        [0, 1]
          .map((c) => `<circle cx="${hx + c * 8}" cy="${hy + r * 8}" r="2.5" fill="${C.ink2}"/>`)
          .join(''),
      )
      .join('');
  const dragged = `<g><rect x="${x + 60}" y="420" width="640" height="46" rx="8" fill="${C.card}" stroke="${C.spice}" stroke-width="2"/>
    ${handle(x + 76, 435)}${bar(x + 104, 438, 420)}</g>`;
  const page = `<g opacity=".95"><rect x="120" y="360" width="190" height="34" rx="6" fill="${C.card}" stroke="${C.spice}" stroke-width="2"/>${bar(140, 372, 120, 10, C.ink2)}</g>`;
  return chrome(`<g>${tree.join('')}</g>${lines.join('')}${dragged}${page}`, { sidebar: true });
}

function voiceView() {
  const x = 380;
  const lines = [];
  let y = 120;
  for (let i = 0; i < 5; i++) lines.push(bar(x, (y += 30), 640 - ((i * 53) % 160)));
  const wave = [];
  for (let i = 0; i < 60; i++) {
    const h = 8 + Math.abs(Math.sin(i * 0.55) * 34 + Math.sin(i * 1.7) * 12);
    wave.push(
      `<rect x="${x + 90 + i * 9}" y="${370 - h / 2}" width="5" height="${h}" rx="2.5" fill="${i < 34 ? C.spice : C.line}"/>`,
    );
  }
  const player = `<rect x="${x}" y="320" width="700" height="100" rx="12" fill="${C.card}" stroke="${C.rule}" stroke-width="1.5"/>
    <circle cx="${x + 48}" cy="370" r="26" fill="${C.ink}"/><path d="M${x + 40} 356v28l22-14z" fill="${C.sand}"/>${wave.join('')}`;
  const rec = `<rect x="${x}" y="460" width="700" height="80" rx="12" fill="#fff3dc" stroke="${C.tag ?? '#ecd2a8'}" stroke-width="1.5"/>
    <circle cx="${x + 44}" cy="500" r="14" fill="#c0392b"/>${bar(x + 76, 494, 90, 12, C.ink2, 6)}
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => `<rect x="${x + 200 + i * 12}" y="${500 - (6 + ((i * 7) % 18))}" width="6" height="${2 * (6 + ((i * 7) % 18))}" rx="3" fill="${C.spice}" opacity=".7"/>`).join('')}
    <rect x="${x + 560}" y="480" width="120" height="40" rx="8" fill="${C.ink}"/>${bar(x + 590, 496, 60, 8, C.sand, 4)}`;
  y = 570;
  for (let i = 0; i < 4; i++) lines.push(bar(x, (y += 30), 600 - ((i * 47) % 180)));
  return chrome(`${bar(x, 110, 380, 24, C.ink, 10)}${lines.join('')}${player}${rec}`);
}

const POSTERS = {
  hero: () => canvasView(0),
  obsidian: obsidianView,
  notion: notionView,
  'global-view': () => canvasView(2),
  atoms: atomsView,
  editor: editorView,
  maths: mathsView,
  'drag-drop': dragDropView,
  voice: voiceView,
  encryption: encryptionView,
  search: searchView,
  'sample-vault': () => canvasView(5),
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas width="1440" height="900"></canvas>');
const only = process.argv.slice(2);
for (const slug of only) if (!POSTERS[slug]) throw new Error(`no poster for "${slug}"`);
for (const [slug, draw] of Object.entries(POSTERS)) {
  if (only.length && !only.includes(slug)) continue;
  const svg = draw();
  const dataUrl = await page.evaluate(async (markup) => {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await img.decode();
    const canvas = document.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/webp', 0.8);
  }, svg);
  const out = `${root}site/media/${slug}.poster.webp`;
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`site/media/${slug}.poster.webp`);
}
await browser.close();
