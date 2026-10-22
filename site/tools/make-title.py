"""Generates the hero title ("LIBER" / "LINTEUM") as SVG outlines from the site's own font.

Usage (Python with `fonttools` and `brotli`, see make-fonts.py):
    /tmp/fontvenv/bin/python site/tools/make-title.py

Reads site/fonts/plus-jakarta-sans-300.woff2 and writes:
  - site/img/title.svg: the filled title on its own (a reference copy, also usable as an image);
  - the inline <svg> in site/index.html between the `title:start` / `title:end` markers.

Each letter is a <g class="ch cN"> holding one filled path (all its contours, so counters stay
holes) and one stroked path per contour, with pathLength="1", which the CSS traces with
stroke-dasharray before fading the fill in. Run Prettier on index.html afterwards.
"""

from pathlib import Path
import re

from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
FONT = ROOT / 'site/fonts/plus-jakarta-sans-300.woff2'
LINES = ['LIBER', 'LINTEUM']
TRACKING = 0.3  # em, as the mock's letter-spacing
LINE_PITCH = 1.18  # em, baseline to baseline
PAD = 12  # font units around the outlines, so the stroke isn't clipped


def fmt(v: float) -> str:
    s = f'{v:.1f}'.rstrip('0').rstrip('.')
    return '0' if s == '-0' else s


def path_d(recording: list, dx: float, base: float) -> str:
    pen = SVGPathPen(None, ntos=fmt)
    tpen = TransformPen(pen, (1, 0, 0, -1, dx, base))
    for op, args in recording:
        getattr(tpen, op)(*args)
    return pen.getCommands()


def contours(recording: list) -> list[list]:
    out, cur = [], []
    for op, args in recording:
        cur.append((op, args))
        if op in ('closePath', 'endPath'):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def main() -> None:
    font = TTFont(FONT)
    upm = font['head'].unitsPerEm
    cap = font['OS/2'].sCapHeight
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font['hmtx']
    track = TRACKING * upm

    letters = []  # (line index, fill d, [stroke d])
    width = 0.0
    for li, text in enumerate(LINES):
        base = cap + li * LINE_PITCH * upm
        x = 0.0
        for ch in text:
            name = cmap[ord(ch)]
            rec = RecordingPen()
            glyphs[name].draw(rec)
            fill = path_d(rec.value, x, base)
            strokes = [path_d(c, x, base) for c in contours(rec.value)]
            letters.append((li, fill, strokes))
            x += hmtx[name][0] + track
        width = max(width, x - track)
    height = cap + (len(LINES) - 1) * LINE_PITCH * upm

    vb = f'{fmt(-PAD)} {fmt(-PAD)} {fmt(width + 2 * PAD)} {fmt(height + 2 * PAD)}'
    groups = []
    for i, (li, fill, strokes) in enumerate(letters):
        paths = [f'<path class="f" d="{fill}"/>']
        paths += [f'<path class="s" pathLength="1" d="{d}"/>' for d in strokes]
        groups.append(f'<g class="ch c{i} l{li + 1}">' + ''.join(paths) + '</g>')

    inline = (
        f'<svg class="title-art" viewBox="{vb}" aria-hidden="true" focusable="false">'
        + ''.join(groups)
        + '</svg>'
    )
    index = ROOT / 'site/index.html'
    html = index.read_text(encoding='utf-8')
    new, n = re.subn(
        r'(<!-- title:start -->).*?(<!-- title:end -->)',
        lambda m: m.group(1) + inline + m.group(2),
        html,
        flags=re.S,
    )
    if n != 1:
        raise SystemExit('title markers not found in site/index.html')
    index.write_text(new, encoding='utf-8')

    fills = ''.join(f'<path d="{fill}"/>' for _, fill, _ in letters)
    standalone = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" fill="#2a1c10">'
        '<title>Liber Linteum</title>' + fills + '</svg>\n'
    )
    (ROOT / 'site/img/title.svg').write_text(standalone, encoding='utf-8')
    print(f'viewBox {vb}; {len(letters)} letters; units per em {upm}')


if __name__ == '__main__':
    main()
