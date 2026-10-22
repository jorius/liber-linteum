// Draws the placeholder posters in site/media/ (WebP, 1440×900) until the real captures exist.
// Each is a quiet sketch of the app's screen for that clip, in the site's palette, with no text,
// so it needs no translation. The real capture work overwrites these files (media/README.md).
//
// Usage, from the repo root after `pnpm install`:
//   node site/tools/make-posters.mjs
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

const POSTERS = {
  hero: () => canvasView(0),
  obsidian: obsidianView,
  notion: notionView,
  'global-view': () => canvasView(2),
  editor: editorView,
  encryption: encryptionView,
  search: searchView,
  'sample-vault': () => canvasView(5),
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas width="1440" height="900"></canvas>');
for (const [slug, draw] of Object.entries(POSTERS)) {
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
