// @vitest-environment node
// The macOS Dock icon (M4b §7): icon.icns is drawn inside Apple's icon grid,
// an 824 px rounded square centred on a 1024 canvas, so it sits as large as
// other apps' icons. Its 1024 px representation, read with macOS's `sips`,
// has transparent corners and a transparent margin all round. macOS only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const icns = fileURLToPath(new URL('../src-tauri/icons/icon.icns', import.meta.url));

/** An 8-bit RGBA, non-interlaced PNG (what `sips` writes): its size and
 *  each pixel's alpha. */
function decodePng(png: Buffer) {
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  for (let pos = 8; pos < png.length;) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      // 8 bits per channel, RGBA, not interlaced.
      expect([body[8], body[9], body[12]]).toEqual([8, 6, 0]);
    } else if (type === 'IDAT') data.push(body);
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[y * stride + i - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4] : 0;
      let v = raw[y * (stride + 1) + 1 + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, alpha: (x: number, y: number) => pixels[y * stride + x * 4 + 3] };
}

describe.runIf(process.platform === 'darwin')('the macOS Dock icon (M4b §7)', () => {
  it('icon.icns at 1024 px: a rounded 824 px square, with transparent corners and margin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liber-icon-'));
    try {
      const png = join(dir, 'icon.png');
      execFileSync('sips', ['-s', 'format', 'png', icns, '--out', png], { stdio: 'ignore' });
      const { width, height, alpha } = decodePng(readFileSync(png));
      expect([width, height]).toEqual([1024, 1024]);
      // The corners, and the outer 64 px across the middle (the shadow ends
      // before them).
      for (const [x, y] of [
        [0, 0],
        [1023, 0],
        [0, 1023],
        [1023, 1023],
      ])
        expect(alpha(x, y)).toBe(0);
      for (let d = 0; d < 64; d++) {
        expect(alpha(d, 512)).toBe(0);
        expect(alpha(1023 - d, 512)).toBe(0);
        expect(alpha(512, d)).toBe(0);
        expect(alpha(512, 1023 - d)).toBe(0);
      }
      // The square: opaque from 100 to 924 px, its corners rounded.
      for (const [x, y] of [
        [104, 512],
        [919, 512],
        [512, 104],
        [512, 919],
        [512, 512],
      ])
        expect(alpha(x, y)).toBe(255);
      for (const [x, y] of [
        [95, 512],
        [928, 512],
        [512, 95],
        [512, 928],
        [110, 110],
      ])
        expect(alpha(x, y)).toBeLessThan(128);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
