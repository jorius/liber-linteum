// A tiny static server for the showcase tests: serves site/ under /liber-linteum/, as GitHub
// Pages does, with Pages' 404 behaviour (404.html for anything missing). No dependencies.
// Usage: node site/tests/serve.mjs [port]
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PREFIX = '/liber-linteum/';
const port = Number(process.argv[2] ?? 4327);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

async function send(res, file, status = 200) {
  const body = await readFile(file);
  res.writeHead(status, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/liber-linteum') {
    res.writeHead(302, { Location: PREFIX }).end();
    return;
  }
  try {
    if (!url.pathname.startsWith(PREFIX)) throw new Error('outside');
    const rel = normalize(decodeURIComponent(url.pathname.slice(PREFIX.length)));
    let file = join(root, rel);
    const base = join(root, '.');
    if (rel.split(sep).includes('..') || !(file === base || file.startsWith(base + sep))) {
      throw new Error('outside');
    }
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await send(res, file);
  } catch {
    await send(res, join(root, '404.html'), 404).catch(() => res.writeHead(404).end());
  }
}).listen(port, '127.0.0.1', () => console.log(`site on http://127.0.0.1:${port}${PREFIX}`));
