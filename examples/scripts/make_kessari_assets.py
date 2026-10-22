#!/usr/bin/env python3
"""Generate the artwork and the sound for the sample vault *The Moons of Kessari*.

Everything is procedural: no samples, photos or fonts are copied in. The script
needs Python 3 and Pillow; it writes into
``examples/the-moons-of-kessari/attachments/``:

* ``covers/*.jpg``            page covers (1600x600) for the vault's pages
* ``covers/screening-N.jpg``  eight cinematic dune scenes for the film shelf
* ``map-of-the-salt-road.png`` a stylised map of the Salt Road
* ``the-dunes-at-dusk.wav``   a synthesised "singing dune" drone with wind

Run it from anywhere:  ``python3 examples/scripts/make_kessari_assets.py``
Pass ``--only name1,name2`` to regenerate a few covers while iterating.
The output is deterministic (every scene has a fixed seed).
"""

from __future__ import annotations

import argparse
import math
import random
import struct
import wave
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent / "the-moons-of-kessari" / "attachments"
COVERS = ROOT / "covers"

W, H = 1600, 600          # cover size
S = 2                     # the per-pixel passes run at 1/S resolution
HW, HH = W // S, H // S
MARGIN = 200              # extra columns either side for shear look-ups


# ---------------------------------------------------------------- helpers

def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def mix(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def grad(stops, t):
    """Colour at t (0..1) along a list of (position, colour) stops."""
    if t <= stops[0][0]:
        return stops[0][1]
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if t <= p1:
            return mix(c0, c1, (t - p0) / (p1 - p0) if p1 > p0 else 0)
    return stops[-1][1]


def rgb8(c):
    return (int(clamp(c[0], 0, 255)), int(clamp(c[1], 0, 255)), int(clamp(c[2], 0, 255)))


def font(size, italic=False, bold=False):
    names = []
    if italic:
        names += ["NotoSerif-Italic.ttf", "FreeSerifItalic.ttf", "DejaVuSerif-Italic.ttf",
                  "LiberationSerif-Italic.ttf"]
    if bold:
        names += ["NotoSerif-Bold.ttf", "FreeSerifBold.ttf", "DejaVuSerif-Bold.ttf",
                  "LiberationSerif-Bold.ttf"]
    names += ["NotoSerif-Regular.ttf", "FreeSerif.ttf", "DejaVuSerif.ttf", "LiberationSerif-Regular.ttf"]
    dirs = [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts",
            Path("/Library/Fonts"), Path("/System/Library/Fonts"), Path("C:/Windows/Fonts")]
    for name in names:
        for d in dirs:
            if d.exists():
                for hit in d.rglob(name):
                    return ImageFont.truetype(str(hit), size)
    return ImageFont.load_default(size=size)


# ------------------------------------------------------------- palettes

PALETTES = {
    "dusk": dict(sky=[(0, (34, 26, 58)), (0.45, (112, 58, 78)), (0.8, (214, 112, 72)), (1, (246, 170, 96))],
                 lit=(222, 142, 84), shadow=(84, 42, 46), haze=(232, 140, 90)),
    "day": dict(sky=[(0, (96, 132, 166)), (0.6, (178, 186, 182)), (1, (242, 218, 180))],
                lit=(236, 190, 126), shadow=(168, 104, 66), haze=(240, 214, 176)),
    "noon": dict(sky=[(0, (140, 150, 160)), (0.7, (222, 206, 178)), (1, (250, 232, 200))],
                 lit=(242, 204, 146), shadow=(190, 128, 82), haze=(246, 226, 192)),
    "night": dict(sky=[(0, (6, 8, 20)), (0.7, (20, 22, 46)), (1, (52, 46, 72))],
                  lit=(104, 96, 118), shadow=(28, 26, 44), haze=(50, 46, 72)),
    "lowmoon": dict(sky=[(0, (4, 5, 14)), (0.75, (14, 14, 30)), (1, (40, 30, 44))],
                    lit=(58, 50, 62), shadow=(20, 18, 28), haze=(38, 30, 44)),
    "closing": dict(sky=[(0, (10, 12, 34)), (0.55, (40, 34, 72)), (0.85, (118, 70, 88)), (1, (186, 112, 96))],
                    lit=(178, 130, 120), shadow=(52, 36, 56), haze=(150, 92, 96)),
    "dawn": dict(sky=[(0, (54, 64, 106)), (0.5, (150, 132, 150)), (0.85, (242, 180, 140)), (1, (252, 214, 160))],
                 lit=(236, 176, 132), shadow=(112, 80, 94), haze=(244, 196, 156)),
    "red": dict(sky=[(0, (22, 8, 16)), (0.6, (70, 22, 30)), (1, (160, 56, 42))],
                lit=(176, 78, 58), shadow=(52, 18, 24), haze=(140, 48, 40)),
    "indigo": dict(sky=[(0, (8, 12, 36)), (0.6, (24, 36, 78)), (1, (66, 86, 140))],
                   lit=(84, 96, 140), shadow=(18, 22, 48), haze=(60, 78, 128)),
    "mono": dict(sky=[(0, (30, 30, 30)), (0.7, (150, 150, 150)), (1, (220, 220, 220))],
                 lit=(236, 236, 236), shadow=(40, 40, 40), haze=(210, 210, 210)),
    "violet": dict(sky=[(0, (40, 30, 70)), (0.55, (120, 90, 140)), (1, (236, 170, 170))],
                   lit=(214, 150, 150), shadow=(84, 60, 96), haze=(220, 160, 170)),
    "storm": dict(sky=[(0, (120, 82, 54)), (0.6, (196, 132, 78)), (1, (232, 176, 112))],
                  lit=(214, 150, 92), shadow=(120, 74, 48), haze=(214, 156, 98)),
}


# ------------------------------------------------------------------ sky

def render_sky(pal, glows, horizon=0.78):
    """Sky gradient plus soft glows, computed at half resolution, returned full size.

    glows: list of (x, y, radius, colour, strength, squash) in full-res pixels;
    squash > 1 spreads the glow sideways (a sun on the horizon)."""
    buf = bytearray(HW * HH * 3)
    hg = [(gx / S, gy / S, r / S, col, st, sq) for gx, gy, r, col, st, sq in glows]
    for y in range(HH):
        base = grad(pal["sky"], min(1.0, y / (HH * horizon)))
        i = y * HW * 3
        if not hg:
            px = bytes(rgb8(base)) * HW
            buf[i:i + HW * 3] = px
            continue
        for x in range(HW):
            r, g, b = base
            for gx, gy, rad, col, st, sq in hg:
                dx = (x - gx) / sq
                dy = y - gy
                f = st * math.exp(-math.sqrt(dx * dx + dy * dy) / rad)
                r += col[0] * f
                g += col[1] * f
                b += col[2] * f
            buf[i] = 255 if r > 255 else int(r)
            buf[i + 1] = 255 if g > 255 else int(g)
            buf[i + 2] = 255 if b > 255 else int(b)
            i += 3
    return Image.frombytes("RGB", (HW, HH), bytes(buf)).resize((W, H), Image.BICUBIC)


def add_stars(img, rng, count=900, horizon=0.8, warm=False):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w, h = img.size
    for _ in range(count):
        x = rng.uniform(0, w)
        y = rng.uniform(0, h * horizon) ** 1.0
        fade = 1 - (y / (h * horizon)) ** 2
        a = int(255 * fade * rng.uniform(0.25, 1) ** 2)
        tint = rng.choice([(255, 250, 240), (230, 236, 255), (255, 226, 200) if warm else (255, 255, 255)])
        if rng.random() < 0.04:
            d.ellipse([x - 1.6, y - 1.6, x + 1.6, y + 1.6], fill=tint + (a,))
            d.line([x - 4, y, x + 4, y], fill=tint + (a // 3,))
            d.line([x, y - 4, x, y + 4], fill=tint + (a // 3,))
        else:
            d.point((x, y), fill=tint + (a,))
    # a faint river of stars
    for _ in range(count):
        t = rng.random()
        x = t * w
        y = h * (0.05 + 0.5 * t) + rng.gauss(0, 30)
        if 0 < y < h * horizon:
            d.point((x, y), fill=(255, 248, 236, rng.randint(20, 90)))
    img.alpha_composite(layer) if img.mode == "RGBA" else img.paste(layer, (0, 0), layer)


def draw_moon(img, cx, cy, radius, color, seed, light=(-0.35, -0.3, 0.88), maria=6, ambient=0.08, day=False):
    """A shaded moon disc composited onto img (RGB or RGBA)."""
    rng = random.Random(seed)
    r = int(math.ceil(radius)) + 2
    size = 2 * r
    blobs = []
    for _ in range(maria):
        mx, my = rng.uniform(-0.55, 0.55), rng.uniform(-0.55, 0.55)
        for _ in range(7):
            blobs.append((mx + rng.gauss(0, 0.13), my + rng.gauss(0, 0.1), rng.uniform(0.07, 0.17),
                          rng.uniform(0.03, 0.06)))
    craters = [(rng.uniform(-0.75, 0.75), rng.uniform(-0.75, 0.75), rng.uniform(0.025, 0.06)) for _ in range(maria)]
    lx, ly, lz = light
    ln = math.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / ln, ly / ln, lz / ln
    buf = bytearray(size * size * 4)
    i = 0
    for py in range(size):
        for px in range(size):
            dx = (px + 0.5 - r) / radius
            dy = (py + 0.5 - r) / radius
            rr = dx * dx + dy * dy
            dist = math.sqrt(rr) * radius
            a = clamp(radius - dist + 0.5)
            if a > 0:
                nz = math.sqrt(max(0.0, 1 - rr))
                raw = smoothstep(-0.04, 0.22, dx * lx + dy * ly + nz * lz)
                shade = ambient + (1 - ambient) * raw
                if day:
                    a *= 0.12 + 0.88 * raw
                m = 1.0
                for bx, by, br, depth in blobs:
                    m -= depth * math.exp(-((dx - bx) ** 2 + (dy - by) ** 2) / (br * br))
                for bx, by, br in craters:
                    q = math.sqrt((dx - bx) ** 2 + (dy - by) ** 2) / br
                    if q < 1.3:
                        m += -0.05 if q < 0.8 else 0.05
                m = max(m, 0.78)
                limb = 0.9 + 0.1 * nz
                k = shade * m * limb
                buf[i] = int(clamp(color[0] * k, 0, 255))
                buf[i + 1] = int(clamp(color[1] * k, 0, 255))
                buf[i + 2] = int(clamp(color[2] * k, 0, 255))
                buf[i + 3] = int(a * 255)
            i += 4
    disc = Image.frombytes("RGBA", (size, size), bytes(buf))
    img.paste(disc, (int(cx - r), int(cy - r)), disc)


# ---------------------------------------------------------------- dunes

class Layer:
    def __init__(self, base, amp, freq, rng, lit, shadow, haze=0.0, haze_col=None, asym=0.45,
                 sharp=1.6, light=1, shear=0.6, ripple=0.0, flat=0.0, fade=0.25):
        self.lit, self.shadow, self.haze, self.haze_col = lit, shadow, haze, haze_col
        self.light, self.shear, self.ripple, self.fade = light, shear, ripple, fade
        ph = [rng.uniform(0, 2 * math.pi) for _ in range(5)]
        n = HW + 2 * MARGIN
        ys = []
        for i in range(n):
            x = i - MARGIN
            t = x * freq + ph[0]
            t2 = t + asym * math.sin(t)
            c = (1 - abs(math.sin(t2))) ** sharp
            lng = 0.5 * math.sin(x * freq * 0.31 + ph[1]) + 0.5 * math.sin(x * freq * 0.13 + ph[2])
            det = 0.07 * math.sin(x * freq * 2.7 + ph[3]) + 0.04 * math.sin(x * freq * 5.3 + ph[4])
            y = base * HH - amp / S * ((1 - flat) * (0.62 * c + 0.38 * (0.5 * lng + 0.5)) + det)
            ys.append(y)
        self.ys = ys
        sl = [0.0] * n
        for i in range(1, n - 1):
            sl[i] = (ys[i + 1] - ys[i - 1]) * 0.5
        lt = light if light else -0.35
        self.sh = [smoothstep(-0.18, 0.18, -s * lt) for s in sl]

    def ridge(self, X):
        """Ridge height at full-resolution x."""
        x = X / S + MARGIN
        i = int(clamp(x, 0, len(self.ys) - 2))
        f = x - i
        return (self.ys[i] * (1 - f) + self.ys[i + 1] * f) * S


def render_dunes(layers):
    """One RGBA image per layer, each holding only the pixels where that layer is in front."""
    n = len(layers)
    out = []
    for k, L in enumerate(layers):
        buf = bytearray(HW * HH * 4)
        lit, shadow = L.lit, L.shadow
        hz, hc = L.haze, L.haze_col
        for x in range(HW):
            xi = x + MARGIN
            top = L.ys[xi]
            bottom = HH
            for j in range(k + 1, n):
                bottom = min(bottom, layers[j].ys[xi])
            y0 = max(0, int(math.floor(top)))
            y1 = min(HH, int(math.ceil(bottom)) + 2)
            if y0 >= y1:
                continue
            depth_span = max(8.0, HH - top)
            for y in range(max(0, y0 - 1), y1):
                d = y - top
                xs = int(xi - d * L.shear * (L.light or 1))
                if xs < 0:
                    xs = 0
                elif xs >= len(L.sh):
                    xs = len(L.sh) - 1
                s = L.sh[xs]
                r = shadow[0] + (lit[0] - shadow[0]) * s
                g = shadow[1] + (lit[1] - shadow[1]) * s
                b = shadow[2] + (lit[2] - shadow[2]) * s
                f = 1 - L.fade * min(1.0, max(0.0, d) / depth_span)
                if L.ripple and d > 2:
                    f *= 1 + L.ripple * math.sin((d + 5 * math.sin(x * 0.021) + 3 * math.sin(x * 0.07)) * 1.25) \
                        * min(1.0, d / 25)
                r, g, b = r * f, g * f, b * f
                if hz:
                    r += (hc[0] - r) * hz
                    g += (hc[1] - g) * hz
                    b += (hc[2] - b) * hz
                a = 255 if y > y0 else int(255 * clamp(y + 1 - top))
                if y < y0:
                    a = 0
                i = (y * HW + x) * 4
                buf[i] = int(clamp(r, 0, 255))
                buf[i + 1] = int(clamp(g, 0, 255))
                buf[i + 2] = int(clamp(b, 0, 255))
                buf[i + 3] = a
        out.append(Image.frombytes("RGBA", (HW, HH), bytes(buf)).resize((W, H), Image.BICUBIC))
    return out


def make_layers(rng, pal, n=6, top=0.62, bottom=1.02, amp=(40, 160), freq=(0.03, 0.007), light=1,
                ripple=0.05, shear=0.6, flat=0.0, sharp=0.9, layer_flat=None):
    layers = []
    layer_flat = layer_flat or {}
    for k in range(n):
        t = k / max(1, n - 1)
        base = top + (bottom - top) * t ** 1.15
        a = amp[0] + (amp[1] - amp[0]) * t
        f = freq[0] + (freq[1] - freq[0]) * t
        haze = (1 - t) ** 1.6 * 0.75
        fl = layer_flat.get(k, flat * (1 - t))
        layers.append(Layer(base, a, f * rng.uniform(0.85, 1.15), rng, pal["lit"], pal["shadow"], haze, pal["haze"],
                            light=light, shear=shear, ripple=ripple * t * t, flat=fl, sharp=sharp))
    return layers


# ------------------------------------------------------------- overlays

def overlay_layer():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def figure(d, x, y, s, color, staff=True, lamp=None):
    d.polygon([(x - 4.2 * s, y), (x + 4.2 * s, y), (x + 2.2 * s, y - 13 * s), (x - 2.0 * s, y - 13 * s)], fill=color)
    d.ellipse([x - 2.4 * s, y - 18.5 * s, x + 2.4 * s, y - 13 * s], fill=color)
    d.polygon([(x - 2.6 * s, y - 13 * s), (x + 2.6 * s, y - 13 * s), (x + 1.6 * s, y - 17.8 * s),
               (x - 1.2 * s, y - 18.8 * s)], fill=color)
    if staff:
        d.line([(x + 5 * s, y + 0.5 * s), (x + 6.2 * s, y - 21 * s)], fill=color, width=max(1, int(0.9 * s)))
    if lamp:
        return (x + 6.2 * s, y - 21 * s)
    return None


def beast(d, x, y, s, color, load=True, facing=1):
    f = facing
    d.ellipse([x - 11 * s, y - 21 * s, x + 11 * s, y - 11 * s], fill=color)
    d.ellipse([x - 5 * s, y - 26 * s, x + 4 * s, y - 16 * s], fill=color)
    for lx, ph in ((-8, 0.6), (-5, -0.5), (6, 0.5), (9, -0.6)):
        d.line([(x + lx * s, y - 13 * s), (x + (lx + ph * 2) * s, y)], fill=color, width=max(1, int(1.6 * s)))
    d.polygon([(x + f * 9 * s, y - 19 * s), (x + f * 13 * s, y - 15 * s), (x + f * 19 * s, y - 29 * s),
               (x + f * 16 * s, y - 31 * s)], fill=color)
    d.ellipse([x + f * 15 * s - 3.5 * s, y - 33 * s, x + f * 15 * s + 4.5 * s, y - 28.5 * s], fill=color)
    if load:
        d.rectangle([x - 9 * s, y - 30 * s, x - 1 * s, y - 22 * s], fill=color)
        d.rectangle([x + 1 * s, y - 28 * s, x + 7 * s, y - 21 * s], fill=color)


def caravan(img, layer, x0, x1, count, s, color, rng, lamps=False):
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    glow = overlay_layer()
    gd = ImageDraw.Draw(glow)
    xs = [x0 + (x1 - x0) * i / max(1, count - 1) for i in range(count)]
    for i, x in enumerate(xs):
        y = layer.ridge(x) + 2
        if i % 3 == 1:
            p = figure(d, x, y, s * 1.05, color, lamp=lamps)
            if p and lamps:
                gd.ellipse([p[0] - 14, p[1] - 14, p[0] + 14, p[1] + 14], fill=(255, 180, 90, 120))
                d.ellipse([p[0] - 1.8, p[1] - 1.8, p[0] + 1.8, p[1] + 1.8], fill=(255, 220, 160, 255))
        else:
            beast(d, x, y, s * rng.uniform(0.92, 1.05), color, load=rng.random() < 0.8)
    if lamps:
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(8)))
    img.alpha_composite(lay)


def crest(layers, k, x, span=160):
    """The x near `x` where layer k's ridge is highest and not hidden by nearer layers."""
    best, best_y = x, None
    for cx in range(int(x - span), int(x + span), 4):
        y = layers[k].ridge(cx)
        if any(layers[j].ridge(cx + dx) < y + 4 for j in range(k + 1, len(layers)) for dx in (-12, 0, 12)):
            continue
        if best_y is None or y < best_y:
            best, best_y = cx, y
    return best


def lone_figure(img, layer, x, s, color, lamp=False):
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    y = layer.ridge(x) + 2
    p = figure(d, x, y, s, color, lamp=lamp)
    if lamp and p:
        glow = overlay_layer()
        ImageDraw.Draw(glow).ellipse([p[0] - 30, p[1] - 30, p[0] + 30, p[1] + 30], fill=(255, 176, 90, 150))
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(14)))
        d.ellipse([p[0] - 2.5, p[1] - 2.5, p[0] + 2.5, p[1] + 2.5], fill=(255, 230, 170, 255))
    img.alpha_composite(lay)


def vgrad_fill(lay, poly, top, bottom, alpha_top=255, alpha_bottom=255):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    x0, y0, x1, y1 = int(min(xs)), int(min(ys)), int(max(xs)) + 1, int(max(ys)) + 1
    h = max(1, y1 - y0)
    g = Image.new("RGBA", (max(1, x1 - x0), h))
    gd = ImageDraw.Draw(g)
    for yy in range(h):
        t = yy / h
        c = rgb8(mix(top, bottom, t))
        gd.line([(0, yy), (x1 - x0, yy)], fill=c + (int(alpha_top + (alpha_bottom - alpha_top) * t),))
    m = Image.new("L", g.size, 0)
    ImageDraw.Draw(m).polygon([(p[0] - x0, p[1] - y0) for p in poly], fill=255)
    g.putalpha(ImageChops.multiply(g.getchannel("A"), m))
    lay.alpha_composite(g, (x0, y0))


def towers(img, layer, rng, x0, x1, count, hmin, hmax, top_col, bottom_col, edge=(255, 240, 220), lit_windows=False,
           glints=False):
    """Glassreach: spires of fused sand, each a leaning crystal with a lit and a shaded facet."""
    lay = overlay_layer()
    glow = overlay_layer()
    gd = ImageDraw.Draw(glow)
    d = ImageDraw.Draw(lay)
    xs = sorted(rng.uniform(x0, x1) for _ in range(count))
    shade_top = mix(top_col, bottom_col, 0.55)
    for x in xs:
        w = rng.uniform(16, 50)
        h = rng.uniform(hmin, hmax) * (1 - 0.55 * abs((x - (x0 + x1) / 2) / (x1 - x0)))
        lean = rng.uniform(-0.07, 0.07)
        yb = layer.ridge(x) + 30
        mid = x + w * rng.uniform(-0.15, 0.25)
        sx = lean * h
        apex = (mid + sx * 1.1 + rng.uniform(-4, 4), yb - h - w * rng.uniform(0.9, 2.2))
        left = [(x - w / 2, yb), (mid, yb), (mid + sx, yb - h), apex, (x - w / 2 + sx, yb - h * rng.uniform(0.92, 1.0))]
        right = [(mid, yb), (x + w / 2, yb), (x + w / 2 + sx, yb - h * rng.uniform(0.9, 1.0)), apex, (mid + sx, yb - h)]
        vgrad_fill(lay, left, top_col, bottom_col, 215, 240)
        vgrad_fill(lay, right, shade_top, mix(bottom_col, (0, 0, 0), 0.35), 225, 245)
        d.line([(mid, yb), (mid + sx, yb - h), apex], fill=edge + (190,), width=2)
        # fused seams at irregular heights
        yy = yb - rng.uniform(20, 60)
        while yy > yb - h + 10:
            t = (yb - yy) / h
            d.line([(x - w / 2 + sx * t + 2, yy), (x + w / 2 + sx * t - 2, yy + rng.uniform(-3, 3))],
                   fill=edge + (40,), width=1)
            if lit_windows and rng.random() < 0.35:
                wx = rng.uniform(x - w / 2 + 4, x + w / 2 - 6) + sx * t
                d.ellipse([wx, yy - 7, wx + 4, yy - 3], fill=(255, 200, 130, 235))
                gd.ellipse([wx - 8, yy - 13, wx + 12, yy + 3], fill=(255, 180, 100, 90))
            yy -= rng.uniform(26, 70)
        if glints:
            gd.ellipse([apex[0] - 9, apex[1] - 9, apex[0] + 9, apex[1] + 9], fill=edge + (130,))
    # shards at the feet of the spires
    for _ in range(count):
        x = rng.uniform(x0, x1)
        yb = layer.ridge(x) + 30
        w = rng.uniform(8, 20)
        hh = rng.uniform(20, 60)
        vgrad_fill(lay, [(x - w / 2, yb), (x + w / 2, yb), (x + rng.uniform(-6, 6), yb - hh)], top_col, bottom_col, 200,
                   230)
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(6)))
    img.alpha_composite(lay)


def court_building(img, layer, cx, width, height, color, glow_col=(255, 178, 96), arches=7, pennants=True):
    """The Salt Courts: three stepped terraces, seven lit arches, seven pennants on the roof."""
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    glow = overlay_layer()
    gd = ImageDraw.Draw(glow)
    yb = max(layer.ridge(cx - width / 2), layer.ridge(cx), layer.ridge(cx + width / 2)) + 14
    x0, x1 = cx - width / 2, cx + width / 2
    h1, h2, h3 = height * 0.58, height * 0.26, height * 0.2
    top1 = yb - h1
    top2 = top1 - h2
    top3 = top2 - h3
    w2, w3 = width * 0.7, width * 0.4
    d.rectangle([x0, top1, x1, yb + 60], fill=color)
    d.rectangle([cx - w2 / 2, top2, cx + w2 / 2, top1], fill=color)
    d.rectangle([cx - w3 / 2, top3, cx + w3 / 2, top2], fill=color)
    # crenellations on each terrace
    for (a, b, y) in ((x0, x1, top1), (cx - w2 / 2, cx + w2 / 2, top2), (cx - w3 / 2, cx + w3 / 2, top3)):
        step = max(8.0, width / 60)
        xx = a
        while xx < b - step / 2:
            d.rectangle([xx, y - step * 0.6, xx + step * 0.55, y], fill=color)
            xx += step
    # seven pennants on the top terrace
    if pennants:
        for i in range(7):
            px = cx - w3 / 2 + w3 * (i + 0.5) / 7
            ph = height * 0.32
            d.line([(px, top3), (px, top3 - ph)], fill=color, width=2)
            pc = HOUSE_COLOURS[i] if glow_col[2] < 200 else mix(HOUSE_COLOURS[i], (120, 140, 220), 0.5)
            d.polygon([(px, top3 - ph), (px + ph * 0.38, top3 - ph * 0.88), (px, top3 - ph * 0.76)],
                      fill=rgb8(pc) + (255,))
    # seven arches on the ground terrace, slim windows above
    aw = width / (arches * 1.7)
    for i in range(arches):
        ax = x0 + width * (i + 0.5) / arches
        ay0 = top1 + h1 * 0.22
        ay1 = yb - 4
        d.rectangle([ax - aw / 2, ay0 + aw / 2, ax + aw / 2, ay1], fill=glow_col + (255,))
        d.ellipse([ax - aw / 2, ay0, ax + aw / 2, ay0 + aw], fill=glow_col + (255,))
        gd.ellipse([ax - aw * 1.6, ay0 - aw, ax + aw * 1.6, ay1 + aw], fill=glow_col + (80,))
        if i in (1, 4, 5):
            figure(d, ax, ay1, aw / 13, color, staff=False)
        if cx - w2 / 2 < ax < cx + w2 / 2:
            wx = ax
            d.rectangle([wx - aw * 0.12, top2 + h2 * 0.3, wx + aw * 0.12, top1 - h2 * 0.2], fill=glow_col + (230,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(18)))
    img.alpha_composite(lay)


HOUSE_COLOURS = [(46, 84, 156), (164, 46, 44), (204, 112, 40), (214, 172, 48), (62, 128, 76), (110, 66, 140),
                 (122, 118, 112)]


def banners(img, rng, x0, x1, top, length, colours=HOUSE_COLOURS, pole=(44, 30, 26)):
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    d.rectangle([x0 - 6, top - 14, x0 + 6, H], fill=pole)
    d.rectangle([x1 - 6, top - 14, x1 + 6, H], fill=pole)
    d.ellipse([x0 - 10, top - 24, x0 + 10, top - 4], fill=pole)
    d.ellipse([x1 - 10, top - 24, x1 + 10, top - 4], fill=pole)
    d.line([(x0, top - 6), (x1, top - 6)], fill=pole, width=6)
    n = len(colours)
    span = (x1 - x0) / n
    bw = span * 0.72
    for i, col in enumerate(colours):
        cx = x0 + span * (i + 0.5)
        ph = rng.uniform(0, 6)
        L = length * rng.uniform(0.9, 1.05)
        left, right = [], []
        steps = 24
        for k in range(steps + 1):
            yy = top + L * k / steps
            sway = 6 * math.sin(k * 0.35 + ph) * (k / steps)
            left.append((cx - bw / 2 + sway, yy))
            right.append((cx + bw / 2 + sway, yy))
        tail = (cx + 6 * math.sin(steps * 0.35 + ph), top + L - bw * 0.35)
        poly = left + [tail] + right[::-1]
        vgrad_fill(lay, poly, mix(col, (255, 240, 220), 0.12), mix(col, (0, 0, 0), 0.45), 250, 250)
        # sigil
        sy = top + L * 0.38
        sc = rgb8(mix(col, (255, 244, 220), 0.7)) + (230,)
        r = bw * 0.22
        kind = i % 7
        if kind == 0:
            pts = [(cx + r * math.cos(a * math.pi / 3), sy + r * math.sin(a * math.pi / 3)) for a in range(6)]
            d.polygon(pts, outline=sc, width=3)
            d.ellipse([cx - r * 0.3, sy - r * 0.3, cx + r * 0.3, sy + r * 0.3], fill=sc)
        elif kind == 1:
            d.polygon([(cx, sy - r), (cx + r, sy), (cx, sy + r), (cx - r, sy)], fill=sc)
        elif kind == 2:
            d.polygon([(cx, sy - r), (cx + r, sy + r * 0.8), (cx - r, sy + r * 0.8)], outline=sc, width=3)
        elif kind == 3:
            d.ellipse([cx - r, sy - r, cx + r, sy + r], outline=sc, width=3)
            d.ellipse([cx - r * 0.45, sy - r * 0.45, cx + r * 0.45, sy + r * 0.45], fill=sc)
        elif kind == 4:
            for k in (-1, 0, 1):
                d.line([(cx - r, sy + k * r * 0.6), (cx + r, sy + k * r * 0.6)], fill=sc, width=3)
        elif kind == 5:
            d.pieslice([cx - r, sy - r, cx + r, sy + r], 200, 520, fill=sc)
            d.ellipse([cx - r * 0.55 + r * 0.35, sy - r * 0.7, cx + r * 0.75 + r * 0.35, sy + r * 0.6],
                      fill=rgb8(mix(col, (0, 0, 0), 0.2)) + (255,))
        else:
            d.rectangle([cx - r * 0.8, sy - r * 0.8, cx + r * 0.8, sy + r * 0.8], outline=sc, width=3)
    img.alpha_composite(lay)


def linen_lines(img, rng, lines, cloth=(240, 230, 206), alpha=225, ink=(90, 60, 40), wind=0.18, backlit=None):
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    for (xa, ya), (xb, yb), sag, count in lines:
        pts = []
        for k in range(41):
            t = k / 40
            pts.append((xa + (xb - xa) * t, ya + (yb - ya) * t + sag * 4 * t * (1 - t)))
        d.line(pts, fill=(52, 38, 32, 255), width=2)
        for c in range(count):
            t = (c + 0.5) / count + rng.uniform(-0.02, 0.02)
            cx = xa + (xb - xa) * t
            cy = ya + (yb - ya) * t + sag * 4 * t * (1 - t)
            cw = (xb - xa) / count * rng.uniform(0.6, 0.82)
            cl = rng.uniform(0.9, 1.6) * cw
            dx = wind * cl * rng.uniform(0.6, 1.3)
            poly = [(cx - cw / 2, cy), (cx + cw / 2, cy + 1), (cx + cw / 2 + dx, cy + cl),
                    (cx + cw * 0.1 + dx, cy + cl * 1.03), (cx - cw / 2 + dx, cy + cl * 0.98)]
            top_c = cloth if not backlit else mix(cloth, backlit, 0.35)
            vgrad_fill(lay, poly, top_c, mix(cloth, (120, 96, 80), 0.35), alpha, alpha)
            # ink: rows of little marks
            for row in range(int(cl / 12)):
                ry = cy + 10 + row * 11
                if ry > cy + cl - 8:
                    break
                fx = (ry - cy) / cl * dx
                x = cx - cw / 2 + 7 + fx
                end = cx + cw / 2 - 7 + fx - rng.uniform(0, cw * 0.4)
                while x < end:
                    seg = rng.uniform(4, 12)
                    d.line([(x, ry), (min(end, x + seg), ry + rng.uniform(-1, 1))], fill=ink + (130,), width=1)
                    x += seg + rng.uniform(2, 5)
            d.line([(cx - cw / 2 + 2, cy + 2), (cx + cw / 2 - 2, cy + 2)], fill=(60, 44, 36, 200), width=2)
    img.alpha_composite(lay)


def wellhead(img, cx, cy, rx, ry, stone=(164, 120, 86), dark=(10, 14, 20), glint=(120, 210, 210),
             frame=(54, 38, 30)):
    """The well-head of Osk: a drum of stone courses with a glass lip, and a winch above it."""
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    wall = ry * 1.5
    px = rx * 0.7
    beam_y = cy - ry * 3.4
    # winch frame (posts stand on the rim's far side)
    for sx in (-px, px):
        d.polygon([(cx + sx - 7, cy - ry * 0.4), (cx + sx + 7, cy - ry * 0.4), (cx + sx + 5, beam_y),
                   (cx + sx - 5, beam_y)], fill=frame)
    d.rectangle([cx - px - 22, beam_y - 12, cx + px + 22, beam_y + 2], fill=frame)
    wy = beam_y + 24
    d.ellipse([cx - 22, wy - 22, cx + 22, wy + 22], outline=frame, width=5)
    d.ellipse([cx - 5, wy - 5, cx + 5, wy + 5], fill=frame)
    d.line([(cx, wy + 22), (cx, cy + ry * 0.15)], fill=frame, width=2)
    # the drum: the front wall between two half-ellipses
    front = [(cx - rx, cy)]
    for k in range(0, 181, 6):
        a = math.radians(k)
        front.append((cx - rx * math.cos(a), cy + wall + ry * math.sin(a)))
    front.append((cx + rx, cy))
    for k in range(0, 181, 6):
        a = math.radians(k)
        front.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
    vgrad_fill(lay, front, mix(stone, (255, 236, 200), 0.1), mix(stone, (0, 0, 0), 0.5))
    # stone courses and joints
    for row in range(1, 3):
        yo = wall * row / 3
        d.arc([cx - rx, cy - ry + yo, cx + rx, cy + ry + yo], 0, 180, fill=rgb8(mix(stone, (0, 0, 0), 0.55)) + (255,),
              width=2)
    for row in range(3):
        for j in range(9):
            ang = math.radians(10 + j * 20 + (10 if row % 2 else 0))
            if ang > math.pi - 0.05:
                continue
            xj = cx - rx * math.cos(ang)
            y0 = cy + ry * math.sin(ang) + wall * row / 3
            d.line([(xj, y0), (xj, y0 + wall / 3)], fill=rgb8(mix(stone, (0, 0, 0), 0.5)) + (255,), width=2)
    # the top: rim and opening
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=rgb8(mix(stone, (255, 236, 200), 0.18)) + (255,))
    ir, iry = rx * 0.8, ry * 0.68
    d.ellipse([cx - ir, cy - iry, cx + ir, cy + iry], fill=dark + (255,))
    img.alpha_composite(lay)
    g = overlay_layer()
    gd = ImageDraw.Draw(g)
    gd.arc([cx - ir * 0.9, cy - iry * 0.75, cx + ir * 0.9, cy + iry * 0.95], 200, 340, fill=glint + (160,), width=5)
    gd.ellipse([cx - ir * 0.35, cy + iry * 0.05, cx + ir * 0.35, cy + iry * 0.45], fill=glint + (60,))
    img.alpha_composite(g.filter(ImageFilter.GaussianBlur(6)))
    d = ImageDraw.Draw(img)
    d.arc([cx - ir, cy - iry, cx + ir, cy + iry], 190, 350, fill=(200, 245, 240, 200), width=2)


def road(img, rng, start, end, w0, w1, colour=(242, 230, 206), stones=True, bend=120):
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    (xa, ya), (xb, yb) = start, end
    left, right, mids = [], [], []
    N = 60
    for k in range(N + 1):
        t = k / N
        e = t ** 0.55
        x = xa + (xb - xa) * e + bend * math.sin(t * math.pi * 1.6) * (1 - t)
        y = ya + (yb - ya) * e
        w = w0 + (w1 - w0) * e
        left.append((x - w / 2, y))
        right.append((x + w / 2, y))
        mids.append((x, y, w, t))
    poly = left + right[::-1]
    vgrad_fill(lay, [(p[0], p[1]) for p in poly], colour, colour, 200, 200)
    d.line(left, fill=(120, 84, 60, 120), width=2)
    d.line(right, fill=(120, 84, 60, 120), width=2)
    if stones:
        for k in range(0, N, 6):
            x, y, w, t = mids[k]
            sh = 30 * (1 - t) + 3
            sx = x + w / 2 + 10 * (1 - t) + 2
            d.rectangle([sx, y - sh, sx + sh * 0.35, y], fill=(70, 48, 38, 230))
    # fade toward the horizon
    m = Image.new("L", (1, H))
    for yy in range(H):
        m.putpixel((0, yy), int(255 * smoothstep(yb, yb + 140, yy)))
    lay.putalpha(ImageChops.multiply(lay.getchannel("A"), m.resize((W, H))))
    img.alpha_composite(lay)


def rocks(img, layer, rng, x0, x1, height, colour=(26, 18, 22), teeth=14, cairn_at=None, lamp_at=None,
          style="teeth"):
    """A line of black rock breaking out of the sand; optionally a cairn and a lamp."""
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    if style == "knuckles":
        for i in range(teeth):
            t = (i + 0.5) / teeth
            x = x0 + (x1 - x0) * t + rng.uniform(-20, 20)
            base = layer.ridge(x) + 30
            r = height * (0.3 + 0.5 * math.sin(math.pi * t)) * rng.uniform(0.7, 1.1)
            d.ellipse([x - r * 0.8, base - r * 1.4, x + r * 0.8, base + r * 0.3], fill=colour + (255,))
            d.arc([x - r * 0.8, base - r * 1.4, x + r * 0.8, base + r * 0.3], 200, 300,
                  fill=rgb8(mix(colour, (170, 180, 230), 0.3)) + (200,), width=3)
    else:
        pts = [(x0, layer.ridge(x0) + 40)]
        x = x0
        while x < x1:
            t = (x - x0) / (x1 - x0)
            w = rng.uniform(30, 80)
            base = layer.ridge(x) + 24
            h = height * (0.3 + 0.7 * math.sin(math.pi * t) ** 0.7) * rng.uniform(0.5, 1.05)
            lean = rng.uniform(-14, 14)
            pts += [(x + w * 0.1, base - h * rng.uniform(0.3, 0.6)), (x + w * 0.3 + lean, base - h),
                    (x + w * 0.55 + lean, base - h * rng.uniform(0.85, 1.0)), (x + w * 0.85, base - h * rng.uniform(0.2, 0.5)),
                    (x + w, base - h * rng.uniform(0.05, 0.2))]
            x += w
        pts.append((x1, layer.ridge(x1) + 40))
        d.polygon(pts, fill=colour + (255,))
        for a, b in zip(pts[1:-2], pts[2:-1]):
            if b[1] < a[1]:
                d.line([a, b], fill=rgb8(mix(colour, (255, 200, 150), 0.3)) + (170,), width=2)
    if cairn_at:
        cx = cairn_at
        cy = layer.ridge(cx) + 22
        w = 34
        for k in range(7):
            ww = w * (1 - k * 0.12)
            d.ellipse([cx - ww, cy - 14 - k * 13, cx + ww, cy - k * 13], fill=rgb8(mix(colour, (90, 70, 60), 0.3 + 0.05 * k)) + (255,),
                      outline=colour + (255,))
    if lamp_at:
        lx, ly = lamp_at
        g = overlay_layer()
        ImageDraw.Draw(g).ellipse([lx - 40, ly - 40, lx + 40, ly + 40], fill=(255, 170, 90, 150))
        img.alpha_composite(g.filter(ImageFilter.GaussianBlur(18)))
        d.ellipse([lx - 3, ly - 3, lx + 3, ly + 3], fill=(255, 230, 170, 255))
    img.alpha_composite(lay)


def sound_rings(img, cx, cy, n=7, colour=(255, 236, 210), spread=60):
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    for k in range(1, n + 1):
        rx = k * spread
        ry = k * spread * 0.32
        a = int(190 * (1 - k / (n + 1)))
        d.arc([cx - rx, cy - ry, cx + rx, cy + ry], 192, 348, fill=colour + (a,), width=3)
    img.alpha_composite(lay.filter(ImageFilter.GaussianBlur(1.2)))


def dust_wall(img, rng, colour=(200, 140, 86), top=0.15):
    lay = overlay_layer()
    d = ImageDraw.Draw(lay)
    for _ in range(90):
        x = rng.uniform(-100, W + 100)
        y = H * top + rng.uniform(0, H * 0.35) + abs(x - W * 0.6) * 0.1
        r = rng.uniform(60, 180)
        d.ellipse([x - r, y - r * 0.7, x + r, y + r * 0.7], fill=colour + (rng.randint(70, 140),))
    d.rectangle([-10, H * (top + 0.25), W + 10, H], fill=colour + (200,))
    lay = lay.filter(ImageFilter.GaussianBlur(28))
    st = ImageDraw.Draw(lay)
    for _ in range(260):
        x = rng.uniform(0, W)
        y = rng.uniform(H * 0.3, H)
        st.line([(x, y), (x + rng.uniform(40, 160), y + rng.uniform(-6, 2))], fill=(255, 224, 180, rng.randint(14, 40)))
    img.alpha_composite(lay)


# ---------------------------------------------------------------- finish

def finish(img, rng, grain=3, vignette=0.32, warm=None):
    img = img.convert("RGB")
    if warm:
        tint = Image.new("RGB", img.size, warm)
        img = ImageChops.overlay(img, Image.blend(Image.new("RGB", img.size, (128, 128, 128)), tint, 0.25))
    if vignette:
        v = Image.radial_gradient("L").resize((img.width, img.height), Image.BICUBIC)
        v = v.point(lambda p: 255 - int(vignette * 255 * clamp((p - 90) / 165) ** 1.5))
        img = ImageChops.multiply(img, Image.merge("RGB", (v, v, v)))
    if grain:
        n = Image.effect_noise(img.size, grain).convert("RGB")
        img = ImageChops.overlay(img, n.point(lambda p: int(128 + (p - 128) * 0.6)))
    return img


def save_jpeg(img, path, quality=86):
    """Covers as JPEG: smooth gradients and grain compress far better than in a palette PNG."""
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    return path.stat().st_size


def save(img, path, limit=390_000, dither=True):
    """Palette PNG with dithering; fewer colours until the file fits the size limit."""
    path.parent.mkdir(parents=True, exist_ok=True)
    for colours in (256, 160, 96, 64, 48, 32):
        pal = img.quantize(colors=colours, method=Image.Quantize.MEDIANCUT)
        q = img.quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE)
        q.save(path, optimize=True)
        if path.stat().st_size <= limit:
            break
    return path.stat().st_size


# ------------------------------------------------------------ scenes

def dunescape(seed, pal_name="dusk", sun=None, moons=(), stars=0, n=6, top=0.6, amp=(40, 170),
              freq=(0.03, 0.007), light=1, ripple=0.05, shear=0.6, flat=0.0, overlays=(), horizon=0.8,
              grain=3, vignette=0.32, sharp=0.9, glows=(), post=None, layer_flat=None):
    """A layered desert. sun = (x, y, r); moons = [(x, y, r, colour, seed, light)];
    overlays = [(after_layer_index, callable(img, layers, rng))]."""
    rng = random.Random(seed)
    pal = PALETTES[pal_name]
    gl = list(glows)
    if sun:
        sx, sy, sr = sun
        gl.append((sx, sy, 170, (255, 160, 80), 0.45, 2.4))
        gl.append((sx, sy, 34, (255, 226, 170), 0.45, 1.0))
    for mx, my, mr, mc, _, _ in moons:
        gl.append((mx, my, mr * 2.2, mc, 0.32, 1.0))
    img = render_sky(pal, gl, horizon).convert("RGBA")
    if stars:
        add_stars(img, rng, stars, horizon)
    if sun:
        sx, sy, sr = sun
        d = ImageDraw.Draw(img)
        d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=(255, 250, 236, 255))
    for mx, my, mr, mc, ms, ml in moons:
        draw_moon(img, mx, my, mr, mc, ms, light=ml, day=pal_name in ("day", "noon", "dawn"))
    layers = make_layers(rng, pal, n=n, top=top, amp=amp, freq=freq, light=light, ripple=ripple, shear=shear,
                         flat=flat, sharp=sharp, layer_flat=layer_flat)
    images = render_dunes(layers)
    for after, fn in overlays:
        if after == -1:
            fn(img, layers, rng)
    for k, li in enumerate(images):
        img.alpha_composite(li)
        for after, fn in overlays:
            if after == k:
                fn(img, layers, rng)
    if post:
        img = post(img, rng)
    return finish(img, rng, grain=grain, vignette=vignette)


FULL = (0.0, 0.0, 1.0)


def moon_ilu(x, y, r=110, seed=11, light=FULL):
    return (x, y, r, (238, 232, 214), seed, light)


def moon_thane(x, y, r=38, seed=23, light=FULL):
    return (x, y, r, (214, 92, 66), seed, light)


def linen_texture(seed, w=W, h=H, base=(232, 218, 188), dark=(150, 126, 96), lamp=True, ink_rows=True,
                  knots=True, quipu=False, folds=True, soft=0.75):
    rng = random.Random(seed)
    hz = Image.new("L", (w, h), 128)
    d = ImageDraw.Draw(hz)
    y = 0
    while y < h:
        th = rng.choice([2, 2, 2, 3, 3, 4])
        d.rectangle([0, y, w, y + th - 1], fill=rng.randint(118, 160))
        y += th
    vt = Image.new("L", (w, h), 128)
    d = ImageDraw.Draw(vt)
    x = 0
    while x < w:
        th = rng.choice([2, 2, 3, 3])
        d.rectangle([x, 0, x + th - 1, h], fill=rng.randint(118, 160))
        x += th
    chk = Image.new("L", (w, h))
    cd = ImageDraw.Draw(chk)
    for yy in range(0, h, 3):
        for xx in range(0, w, 6):
            off = 3 if (yy // 3) % 2 else 0
            cd.rectangle([xx + off, yy, xx + off + 2, yy + 2], fill=255)
    weave = Image.composite(hz, vt, chk.filter(ImageFilter.GaussianBlur(0.6)))
    # slubs
    sd = ImageDraw.Draw(weave)
    for _ in range(int(w * h / 9000)):
        sx, sy = rng.uniform(0, w), rng.uniform(0, h)
        sd.line([(sx, sy), (sx + rng.uniform(8, 40), sy)], fill=rng.choice([100, 176, 186]), width=2)
    noise = Image.effect_noise((w, h), 40).filter(ImageFilter.GaussianBlur(0.8))
    weave = Image.blend(weave, noise, 0.18).filter(ImageFilter.GaussianBlur(soft))
    weave = ImageOps.autocontrast(weave, cutoff=1).point(lambda p: int(70 + p * 0.72))
    img = ImageOps.colorize(weave, black=dark, white=base, mid=mix(dark, base, 0.62)).convert("RGBA")
    if folds:
        f = Image.new("L", (64, 8))
        for xx in range(64):
            v = 128 + 40 * math.sin(xx * 0.45 + rng.uniform(0, 0.3)) + 25 * math.sin(xx * 0.17 + 1)
            for yy in range(8):
                f.putpixel((xx, yy), int(clamp(v + 10 * math.sin(yy + xx * 0.1), 0, 255)))
        f = f.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(30)).convert("RGB")
        img = ImageChops.overlay(img.convert("RGB"), f).convert("RGBA")
    ink = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    idr = ImageDraw.Draw(ink)
    inkc = (64, 40, 30)
    if ink_rows:
        # ruled columns and rows of script
        cols = [int(w * 0.12), int(w * 0.62), int(w * 0.8)]
        for cx in cols:
            idr.line([(cx, 30), (cx, h - 30)], fill=(150, 60, 40, 90), width=2)
        for row in range(30, h - 40, 34):
            x = 50
            while x < cols[0] - 20:
                idr.line([(x, row + 14), (x, row + 24)], fill=inkc + (190,), width=2)
                x += 7 if rng.random() < 0.8 else 16
            x = cols[0] + 22
            end = cols[1] - rng.uniform(30, 260)
            while x < end:
                word = rng.randint(2, 6)
                for _ in range(word):
                    kind = rng.random()
                    a = rng.randint(150, 215)
                    if kind < 0.35:
                        idr.arc([x, row + 12, x + 9, row + 24], rng.choice([0, 90, 180]), rng.choice([270, 360]),
                                fill=inkc + (a,), width=2)
                    elif kind < 0.6:
                        idr.line([(x + 2, row + 8 + rng.uniform(0, 4)), (x + 4, row + 24)], fill=inkc + (a,), width=2)
                        idr.line([(x, row + 15), (x + 8, row + 15)], fill=inkc + (a,), width=2)
                    elif kind < 0.8:
                        idr.line([(x, row + 24), (x + 4, row + 12), (x + 8, row + 24)], fill=inkc + (a,), width=2)
                    else:
                        idr.ellipse([x, row + 14, x + 8, row + 24], outline=inkc + (a,), width=2)
                    x += rng.uniform(9, 12)
                x += rng.uniform(10, 18)
            x = cols[1] + 24
            for _ in range(rng.randint(2, 4)):
                idr.ellipse([x, row + 12, x + 9, row + 24], outline=inkc + (190,), width=2)
                x += 16
            x = cols[2] + 24
            for _ in range(rng.randint(2, 5)):
                idr.line([(x, row + 12), (x + 6, row + 24)], fill=inkc + (190,), width=2)
                x += 14
    ink = ink.filter(ImageFilter.GaussianBlur(0.7))
    img.alpha_composite(ink)
    if knots or quipu:
        cord = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        cdr = ImageDraw.Draw(cord)
        cordc = (120, 72, 46)
        if quipu:
            ytop = h * 0.14
            pts = [(xx, ytop + 6 * math.sin(xx * 0.01)) for xx in range(-10, w + 10, 8)]
            cdr.line(pts, fill=cordc + (255,), width=7)
            for k in range(26):
                x0 = 40 + k * (w - 80) / 25 + rng.uniform(-8, 8)
                y0 = ytop + 6 * math.sin(x0 * 0.01)
                length = rng.uniform(h * 0.45, h * 0.82)
                col = rng.choice([cordc, (150, 96, 60), (90, 54, 40), (70, 90, 130), (168, 60, 48)])
                pts = [(x0 + 10 * math.sin(t * 0.02 + k) * (t / length), y0 + t) for t in range(0, int(length), 6)]
                cdr.line(pts, fill=col + (255,), width=4)
                groups = rng.randint(2, 4)
                for gix in range(groups):
                    gy = 0.2 + 0.75 * gix / groups
                    for kk in range(rng.randint(1, 6)):
                        t = (gy + kk * 0.025) * length
                        if t >= length - 6:
                            break
                        px = x0 + 10 * math.sin(t * 0.02 + k) * (t / length)
                        py = y0 + t
                        cdr.ellipse([px - 6, py - 4.5, px + 6, py + 4.5], fill=rgb8(mix(col, (0, 0, 0), 0.25)) + (255,))
                        cdr.arc([px - 5, py - 4, px + 5, py + 3], 200, 330, fill=rgb8(mix(col, (255, 230, 200), 0.4))
                                + (220,), width=2)
        else:
            yk = h - 26
            pts = [(xx, yk + 3 * math.sin(xx * 0.02)) for xx in range(-10, w + 10, 6)]
            cdr.line(pts, fill=cordc + (255,), width=5)
            x = 30
            while x < w - 20:
                n = rng.randint(1, 5)
                for kk in range(n):
                    px = x + kk * 13
                    py = yk + 3 * math.sin(px * 0.02)
                    cdr.ellipse([px - 6, py - 6, px + 6, py + 6], fill=(98, 56, 36, 255))
                    cdr.arc([px - 5, py - 5, px + 5, py + 4], 200, 320, fill=(200, 150, 110, 220), width=2)
                x += n * 13 + rng.uniform(30, 60)
        shadow = cord.getchannel("A").filter(ImageFilter.GaussianBlur(4))
        sh = Image.new("RGBA", (w, h), (40, 24, 16, 0))
        sh.putalpha(shadow.point(lambda p: p * 0.55))
        img.alpha_composite(sh, (3, 5))
        img.alpha_composite(cord)
    if lamp:
        v = Image.radial_gradient("L").resize((w, h), Image.BICUBIC)
        warm = Image.new("RGB", (w, h), (255, 236, 205))
        dark_ = Image.new("RGB", (w, h), (120, 72, 44))
        glow = Image.composite(dark_, warm, v.point(lambda p: int(clamp((p - 60) / 190) ** 1.3 * 255)))
        img = ImageChops.multiply(img.convert("RGB"), glow)
    return img.convert("RGBA")


def linen_scene(seed, **kw):
    rng = random.Random(seed)
    img = linen_texture(seed, **kw)
    return finish(img, rng, grain=0, vignette=0.2)


def shaft_scene(seed, salt=(11.6, 17.2), water_at=23.5, moons_in_water=True, warm_top=(222, 160, 98),
                deep=(8, 30, 42), water=(150, 226, 220), cx=None, cy=None, sun_angle=-2.3):
    """Looking down the glass-lined shaft of a well: courses of fused glass blocks,
    salt lines left by high water, and the water far below."""
    rng = random.Random(seed)
    cx = (W * 0.52 if cx is None else cx) / S
    cy = (H * 0.56 if cy is None else cy) / S
    R0 = 1150 / S
    q = 0.9                                    # each course appears this much smaller
    lnq = math.log(1 / q)
    sq = 0.6                                   # vertical squash of the circles
    buf = bytearray(HW * HH * 3)
    jitter = [rng.uniform(-0.12, 0.12) for _ in range(64)]
    for y in range(HH):
        for x in range(HW):
            dx = x + 0.5 - cx
            dy = (y + 0.5 - cy) / sq
            rho = math.sqrt(dx * dx + dy * dy) + 1e-6
            z = math.log(R0 / rho) / lnq       # depth in courses
            th = math.atan2(dy, dx)
            if z >= water_at:
                # the water surface: bright, rippled, with the moons in it
                u = (z - water_at)
                rip = 0.5 + 0.5 * math.sin(u * 9 + math.sin(th * 3) * 0.6)
                c = mix(water, (255, 255, 250), 0.25 * rip * min(1.0, u))
                c = mix(c, deep, max(0.0, 0.35 - u * 0.2))
            else:
                t = z / water_at
                base = mix(warm_top, deep, smoothstep(0.0, 1.0, t) ** 0.75)
                light = 0.62 + 0.38 * math.cos(th - sun_angle)
                course = int(math.floor(z))
                fz = z - course
                blocks = 30
                fb = (th / (2 * math.pi) * blocks + (0.5 if course % 2 else 0) + jitter[course % 64]) % 1.0
                block_shade = 0.94 + 0.12 * jitter[(course * 7 + int(th * 3)) % 64]
                k = light * block_shade * (0.86 + 0.14 * fz)
                if fz < 0.07 or fb < 0.03:
                    k *= 0.74                  # the joints between blocks

                c = (base[0] * k, base[1] * k, base[2] * k)
                # glassy sheen: a soft specular band opposite the light
                ang = (th - sun_angle + math.pi) % (2 * math.pi) - math.pi
                sheen = math.exp(-(ang * ang) / 0.05) * (1 - t) * 0.45
                c = mix(c, (255, 248, 230), sheen * (0.6 + 0.4 * fz))
                for i, zs in enumerate(salt):
                    dz = abs(z - zs)
                    if dz < 0.09:
                        c = mix(c, (248, 246, 236), (1 - dz / 0.09) * (0.85 if i == 0 else 0.55))
                # glow of the water on the lowest courses
                c = mix(c, water, max(0.0, 1 - (water_at - z) / 2.5) * 0.35)
            i = (y * HW + x) * 3
            buf[i:i + 3] = bytes(rgb8(c))
    img = Image.frombytes("RGB", (HW, HH), bytes(buf)).resize((W, H), Image.BICUBIC).convert("RGBA")
    if moons_in_water:
        rw = R0 * S * q ** water_at
        g = overlay_layer()
        gd = ImageDraw.Draw(g)
        X, Y = cx * S, cy * S
        gd.ellipse([X - rw * 0.42, Y - rw * 0.32 * sq, X - rw * 0.06, Y + rw * 0.04 * sq], fill=(255, 255, 248, 170))
        gd.ellipse([X + rw * 0.12, Y + rw * 0.1 * sq, X + rw * 0.26, Y + rw * 0.24 * sq], fill=(255, 120, 96, 200))
        img.alpha_composite(g.filter(ImageFilter.GaussianBlur(5)))
    return finish(img, rng, grain=4, vignette=0.4)


def planet_scene(seed):
    rng = random.Random(seed)
    img = Image.new("RGBA", (W, H), (4, 5, 12, 255))
    add_stars(img, rng, 1400, horizon=1.0)
    pcx, pcy, pr = W * 0.62 / S, H * 1.9 / S, H * 1.45 / S
    buf = bytearray(HW * HH * 4)
    bands = [(196, 132, 78), (222, 168, 104), (176, 108, 64), (232, 190, 130), (160, 96, 60), (210, 150, 96)]
    ph = [rng.uniform(0, 6.28) for _ in range(4)]
    lx, ly, lz = -0.6, -0.55, 0.58
    ln = math.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / ln, ly / ln, lz / ln
    for y in range(HH):
        for x in range(HW):
            dx = (x + 0.5 - pcx) / pr
            dy = (y + 0.5 - pcy) / pr
            rr = dx * dx + dy * dy
            i = (y * HW + x) * 4
            if rr <= 1.0:
                nz = math.sqrt(1 - rr)
                lat = dy + 0.012 * math.sin(dx * 7 + ph[0]) + 0.005 * math.sin(dx * 23 + dy * 9 + ph[1])
                b = (lat * 11 + 0.25 * math.sin(dx * 3 + ph[2]) + 0.1 * math.sin(dx * 13 + lat * 30)) % len(bands)
                k = int(b)
                c = mix(bands[k], bands[(k + 1) % len(bands)], b - k)
                shade = max(0.0, dx * lx + dy * ly + nz * lz)
                c = mix((8, 6, 10), c, shade ** 0.7)
                rim = (1 - nz) ** 3
                c = mix(c, (255, 190, 120), rim * 0.6 * shade ** 0.3)
                a = clamp((1 - math.sqrt(rr)) * pr + 0.5)
                buf[i:i + 4] = bytes(rgb8(c)) + bytes([int(a * 255)])
            elif rr < 1.06:
                r = math.sqrt(rr)
                glow = (1 - (r - 1) / 0.03) if r < 1.03 else 0
                nzish = max(0.0, (dx * lx + dy * ly))
                a = clamp(glow) * 0.6 * (0.3 + nzish)
                buf[i:i + 4] = bytes((255, 170, 100, int(clamp(a) * 255)))
    pl = Image.frombytes("RGBA", (HW, HH), bytes(buf)).resize((W, H), Image.BICUBIC)
    img.alpha_composite(pl.filter(ImageFilter.GaussianBlur(0.5)))
    draw_moon(img, W * 0.18, H * 0.3, 70, (238, 232, 214), 11, light=(-0.6, -0.5, 0.6))
    draw_moon(img, W * 0.86, H * 0.18, 24, (214, 92, 66), 23, light=(-0.6, -0.5, 0.6))
    return finish(img, rng, grain=5, vignette=0.3)


def strata_scene(seed, pal_name="dusk"):
    rng = random.Random(seed)
    pal = PALETTES[pal_name]
    img = render_sky(pal, [(W * 0.2, H * 0.5, 200, (255, 170, 90), 0.5, 2.0)], 0.75).convert("RGBA")
    bands = [(190, 110, 70), (222, 160, 104), (160, 84, 58), (236, 188, 130), (176, 100, 72), (206, 136, 86),
             (140, 74, 54), (226, 170, 112)]
    ph = [rng.uniform(0, 6.28) for _ in range(6)]
    bounds, acc = [], -40.0
    while acc < HH + 60:
        acc += rng.choice([3, 4, 6, 8, 11, 15, 20])
        bounds.append(acc)
    band_col = [rng.choice(bands) for _ in bounds]
    import bisect
    buf = bytearray(HW * HH * 4)
    for x in range(HW):
        raw = math.sin(x * 0.012 + ph[0]) + 0.5 * math.sin(x * 0.031 + ph[1]) + 0.25 * math.sin(x * 0.09 + ph[2])
        mesa = HH * 0.38 - HH * 0.14 * clamp(raw * 1.6, -1, 1)
        for y in range(int(mesa), HH):
            yy = y + 5 * math.sin(x * 0.006 + ph[3]) + 1.5 * math.sin(x * 0.03 + ph[4]) - 0.04 * x
            k = min(len(bounds) - 1, bisect.bisect(bounds, yy))
            lo = bounds[k - 1] if k else bounds[0] - 10
            f = (yy - lo) / max(1.0, bounds[k] - lo)
            c = mix(band_col[k], band_col[(k + 1) % len(band_col)], smoothstep(0.8, 1.0, f))
            streak = 0.96 + 0.04 * math.sin(x * 0.11 + 2 * math.sin(y * 0.03)) + 0.02 * math.sin(x * 0.37)
            shade = 0.72 + 0.28 * smoothstep(-1, 1, math.sin(x * 0.012 + ph[0] + 1.2))
            c = mix(c, pal["haze"], 0.25)
            c = (c[0] * streak * shade, c[1] * streak * shade, c[2] * streak * shade)
            a = 255 if y > mesa else int(255 * clamp(y + 1 - mesa))
            i = (y * HW + x) * 4
            buf[i:i + 4] = bytes(rgb8(c)) + bytes([a])
    cliff = Image.frombytes("RGBA", (HW, HH), bytes(buf)).resize((W, H), Image.BICUBIC)
    img.alpha_composite(cliff)
    layers = make_layers(rng, pal, n=3, top=0.86, amp=(50, 110), freq=(0.03, 0.012), light=1)
    for li in render_dunes(layers):
        img.alpha_composite(li)
    return finish(img, rng)


# --------------------------------------------------------------- the map

def make_map(path):
    rng = random.Random(77)
    w, h = 1600, 1000
    base = linen_texture(77, w, h, base=(236, 222, 190), dark=(176, 150, 112), lamp=False, ink_rows=False,
                         knots=False, folds=True, soft=1.2)
    flat = Image.new("RGBA", base.size, (232, 216, 184, 255))
    img = Image.blend(base.convert("RGBA"), flat, 0.5)
    d = ImageDraw.Draw(img)
    ink = (74, 46, 32, 255)
    paper = (234, 220, 190, 255)
    faint = (120, 84, 58, 150)
    # border
    d.rectangle([24, 24, w - 24, h - 24], outline=ink, width=4)
    d.rectangle([36, 36, w - 36, h - 36], outline=faint, width=2)
    # dune glyphs scattered (two strokes each)
    route = []
    for k in range(101):
        t = k / 100
        x = 230 + (w - 520) * t
        y = 640 - 230 * t + 90 * math.sin(t * math.pi * 2.2) + 30 * math.sin(t * 13)
        route.append((x, y))

    def near_route(x, y, r):
        return any((x - rx) ** 2 + (y - ry) ** 2 < r * r for rx, ry in route[::3])

    for _ in range(420):
        x, y = rng.uniform(70, w - 70), rng.uniform(90, h - 90)
        if near_route(x, y, 46) or (x > w - 470 and y < 380) or (x < 400 and y > 600 and y < 860) \
                or (y > h - 240 and x > w - 600) or (x < 330 and y < 330) or (x > w - 400 and 380 < y < 560):
            continue
        s = rng.uniform(10, 22)
        d.arc([x - s, y - s * 0.5, x + s, y + s * 0.5], 190, 350, fill=faint, width=2)
        d.arc([x - s * 0.4, y - s * 0.3, x + s * 1.2, y + s * 0.5], 200, 340, fill=(120, 84, 58, 90), width=1)
    # the Singing Erg: denser dunes, a label
    for _ in range(160):
        x, y = rng.uniform(560, 980), rng.uniform(660, 880)
        s = rng.uniform(12, 26)
        d.arc([x - s, y - s * 0.5, x + s, y + s * 0.5], 190, 350, fill=(150, 70, 44, 170), width=2)
    # the route: dashes
    for k in range(0, len(route) - 1):
        if k % 3 != 2:
            d.line([route[k], route[k + 1]], fill=(150, 46, 34, 255), width=6)
    # waystations
    f_label = font(30, italic=True)
    f_small = font(22, italic=True)
    f_title = font(54, bold=True)
    f_big = font(38, bold=True)
    for k, name in ((24, "Salt Ninth"), (50, "Dry Fork"), (75, "Cairn of Teeth")):
        x, y = route[k]
        d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(236, 222, 190, 255), outline=ink, width=3)
        d.text((x + 16, y + 10), name, font=f_small, fill=ink, stroke_width=4, stroke_fill=paper)
    # Glassreach: a cluster of towers
    gx, gy = route[0]
    for i, (ox, th) in enumerate(((-34, 70), (-14, 110), (6, 86), (24, 130), (44, 64))):
        d.polygon([(gx + ox - 8, gy + 10), (gx + ox + 8, gy + 10), (gx + ox + 8, gy - th + 20), (gx + ox, gy - th),
                   (gx + ox - 8, gy - th + 20)], fill=(150, 196, 200, 255), outline=ink)
    d.text((gx - 110, gy - 200), "GLASSREACH", font=f_big, fill=ink, stroke_width=5, stroke_fill=paper)
    # the Courts and the Well
    cx, cy = route[-1]
    d.rectangle([cx - 24, cy - 62, cx + 24, cy - 44], fill=(222, 196, 150, 255), outline=ink, width=3)
    d.rectangle([cx - 42, cy - 46, cx + 42, cy - 28], fill=(222, 196, 150, 255), outline=ink, width=3)
    d.rectangle([cx - 60, cy - 30, cx + 60, cy + 12], fill=(222, 196, 150, 255), outline=ink, width=3)
    for i in range(7):
        ax = cx - 52 + i * 17.3
        d.rectangle([ax, cy - 18, ax + 8, cy + 12], fill=ink)
    d.text((cx - 120, cy + 26), "THE SALT COURTS", font=f_big, fill=ink, stroke_width=5, stroke_fill=paper)
    wx, wy = cx + 150, cy - 150
    d.ellipse([wx - 30, wy - 18, wx + 30, wy + 18], fill=(222, 196, 150, 255), outline=ink, width=3)
    d.ellipse([wx - 18, wy - 10, wx + 18, wy + 10], fill=(40, 90, 110, 255))
    d.text((wx - 80, wy - 64), "Well of Osk", font=f_label, fill=ink, stroke_width=4, stroke_fill=paper)
    lx, ly = cx - 10, cy - 190
    d.rectangle([lx - 20, ly - 14, lx + 20, ly + 14], fill=(240, 232, 210, 255), outline=ink, width=3)
    for k in range(3):
        d.line([(lx - 12, ly - 6 + k * 6), (lx + 12, ly - 6 + k * 6)], fill=ink, width=1)
    d.text((lx - 200, ly - 14), "the Loom House", font=f_small, fill=ink, stroke_width=4, stroke_fill=paper)
    d.text((640, 900), "THE SINGING ERG", font=f_label, fill=(150, 70, 44, 255), stroke_width=4, stroke_fill=paper)
    d.text((70, 770), "the Glass Flats", font=f_small, fill=faint, stroke_width=4, stroke_fill=paper)
    d.text((520, 360), "the Salt Road", font=f_label, fill=(150, 46, 34, 255), stroke_width=4, stroke_fill=paper)
    # compass rose
    rx, ry = 190, 200
    for a, L in ((0, 80), (90, 60), (180, 80), (270, 60), (45, 34), (135, 34), (225, 34), (315, 34)):
        ang = math.radians(a - 90)
        tip = (rx + L * math.cos(ang), ry + L * math.sin(ang))
        l1 = (rx + 10 * math.cos(ang + 1.57), ry + 10 * math.sin(ang + 1.57))
        l2 = (rx + 10 * math.cos(ang - 1.57), ry + 10 * math.sin(ang - 1.57))
        d.polygon([tip, l1, (rx, ry)], fill=ink)
        d.polygon([tip, l2, (rx, ry)], fill=(236, 222, 190, 255), outline=ink)
    d.ellipse([rx - 46, ry - 46, rx + 46, ry + 46], outline=faint, width=2)
    d.text((rx - 10, ry - 128), "N", font=f_label, fill=ink)
    # two moons in the corner
    mx, my = w - 210, 170
    d.ellipse([mx - 60, my - 60, mx + 60, my + 60], fill=(244, 238, 222, 255), outline=ink, width=3)
    d.ellipse([mx + 70, my - 70, mx + 104, my - 36], fill=(196, 82, 60, 255), outline=ink, width=3)
    d.text((mx - 110, my - 14), "Ilu", font=f_small, fill=ink)
    d.text((mx + 72, my - 30), "Thane", font=f_small, fill=ink)
    # cartouche
    tx, ty = w - 560, h - 210
    d.rectangle([tx, ty, tx + 500, ty + 150], fill=(240, 228, 200, 255), outline=ink, width=3)
    d.rectangle([tx + 8, ty + 8, tx + 492, ty + 142], outline=faint, width=1)
    d.text((tx + 34, ty + 22), "The Salt Road", font=f_title, fill=ink)
    d.text((tx + 34, ty + 92), "Glassreach to the Courts: nine days", font=f_small, fill=ink)
    # scale bar: one day's march
    sx, sy = 120, h - 110
    for k in range(4):
        d.rectangle([sx + k * 60, sy, sx + (k + 1) * 60, sy + 12], fill=ink if k % 2 == 0 else (236, 222, 190, 255),
                    outline=ink)
    d.text((sx, sy + 20), "two days' march", font=f_small, fill=ink)
    out = finish(img, rng, grain=3, vignette=0.22)
    out = out.resize((1400, 875), Image.LANCZOS)
    return save(out, path, dither=False)


# ----------------------------------------------------------------- audio

def make_wav(path, seconds=22.0, rate=44100):
    rng = random.Random(5)
    n = int(seconds * rate)
    out = [0.0] * n
    two_pi = 2 * math.pi

    # slowly varying random curves (gusts, swells), sampled every 0.25 s and interpolated
    def curve(seed, step=0.25, lo=0.0, hi=1.0):
        r = random.Random(seed)
        pts = [r.uniform(lo, hi) for _ in range(int((seconds + 12) / step) + 3)]

        def at(t):
            x = t / step
            i = int(x)
            f = x - i
            f = f * f * (3 - 2 * f)
            return pts[i] * (1 - f) + pts[i + 1] * f
        return at

    gust = curve(1, 0.6, 0.15, 1.0)
    swell = curve(2, 1.3, 0.0, 1.0)
    drift = curve(3, 1.7, -1.0, 1.0)
    # voices: (base frequency, entry time, length, gain) -- two dunes, a third answering
    voices = [(96.0, 2.0, 15.0, 0.55), (72.0, 7.5, 12.5, 0.45), (128.0, 12.0, 7.5, 0.22)]
    phases = [0.0] * len(voices)
    harm = [1.0, 0.55, 0.32, 0.18, 0.1, 0.06]
    lp1 = lp2 = lp3 = 0.0
    hp = 0.0
    grain_lp = 0.0
    hiss_lp = hiss_prev = 0.0
    for i in range(n):
        t = i / rate
        # wind: white noise, two one-pole low-passes, cutoff following the gusts
        g = gust(t)
        wnoise = rng.uniform(-1, 1)
        a1 = 0.01 + 0.05 * g
        lp1 += a1 * (wnoise - lp1)
        lp2 += a1 * (lp1 - lp2)
        lp3 += 0.0025 * (lp2 - lp3)
        wind = (lp2 - lp3) * (0.6 + 1.6 * g)
        # high sand hiss: noise high-passed, gated by gusts
        hiss_lp += 0.3 * (wnoise - hiss_lp)
        hiss = (hiss_lp - hiss_prev) * 0.04 * g * g
        hiss_prev = hiss_lp
        # the dune: harmonics with a slight wobble and a grainy amplitude
        grain_lp += 0.004 * (rng.uniform(-1, 1) - grain_lp)
        rough = 1 + 6.0 * grain_lp
        s = 0.0
        for v, (f0, start, length, gain) in enumerate(voices):
            if t < start or t > start + length:
                continue
            u = (t - start) / length
            env = smoothstep(0.0, 0.3, u) * (1 - smoothstep(0.7, 1.0, u))
            env *= 0.75 + 0.25 * swell(t + v * 3)
            f = f0 * (1 + 0.012 * drift(t + v) + 0.003 * math.sin(two_pi * 5.2 * t + v))
            phases[v] += two_pi * f / rate
            p = phases[v]
            tone = 0.0
            for k, hk in enumerate(harm):
                tone += hk * math.sin((k + 1) * p + k * 0.7)
            s += gain * env * tone * rough
        fade = smoothstep(0, 1.5, t) * (1 - smoothstep(seconds - 2.5, seconds, t))
        out[i] = (0.28 * s + 2.2 * wind + hiss) * fade
    # gentle DC block, then normalise to -3 dBFS
    prev_x = prev_y = 0.0
    for i in range(n):
        x = out[i]
        y = x - prev_x + 0.9995 * prev_y
        prev_x, prev_y = x, y
        out[i] = y
    peak = max(abs(v) for v in out) or 1.0
    k = 0.707 / peak
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"".join(struct.pack("<h", int(v * k * 32767)) for v in out))
    return path.stat().st_size


# --------------------------------------------------------------- catalogue

def caravan_on(k, x0, x1, count, s, colour, lamps=False):
    return (k, lambda img, L, rng: caravan(img, L[k], x0, x1, count, s, colour, rng, lamps))


def figure_on(k, x, s, colour, lamp=False):
    return (k, lambda img, L, rng: lone_figure(img, L[k], crest(L, k, x), s, colour, lamp))


def towers_on(k, x0, x1, count, hmin, hmax, top, bottom, edge=(255, 240, 220), lit=False, glints=False):
    return (k, lambda img, L, rng: towers(img, L[k], rng, x0, x1, count, hmin, hmax, top, bottom, edge, lit, glints))


SCENES = {
    # --- the vault and the story
    "welcome": lambda: dunescape(101, "closing", moons=[moon_ilu(560, 330, 120), moon_thane(722, 292, 36)], stars=700,
                                 top=0.66, amp=(30, 150), light=0, overlays=[figure_on(4, 1130, 2.4, (24, 16, 24))]),
    "the-story": lambda: dunescape(102, "dusk", sun=(1180, 420, 34), top=0.74, amp=(30, 110),
                                   overlays=[(2, lambda img, L, rng: linen_lines(
                                       img, rng, [((60, 150), (900, 170), 50, 7), ((520, 250), (1560, 230), 40, 8)],
                                       backlit=(255, 180, 110)))]),
    "ch01-the-linen-keepers-daughter": lambda: linen_scene(201, quipu=False),
    "ch02-low-moon": lambda: dunescape(202, "lowmoon", stars=1100, top=0.7, amp=(30, 120), light=0,
                                       overlays=[(2, lambda img, L, rng: court_building(img, L[2], 800, 760, 170,
                                                                                        (22, 16, 22, 255)))]),
    "ch03-the-salt-road": lambda: dunescape(203, "day", sun=(260, 160, 28), top=0.6, amp=(40, 170),
                                            layer_flat={3: 0.85},
                                            overlays=[caravan_on(3, 520, 1080, 12, 1.25, (60, 34, 26, 255))]),
    "ch04-glassreach": lambda: dunescape(204, "dusk", sun=(1300, 410, 40), top=0.74, amp=(30, 120),
                                         overlays=[towers_on(1, 260, 1250, 26, 120, 360, (236, 196, 170),
                                                             (90, 120, 136), lit=True, glints=True)]),
    "ch05-the-closing": lambda: dunescape(205, "closing", moons=[moon_ilu(960, 400, 140, 12), moon_thane(1170, 330, 44)],
                                          stars=800, top=0.7, amp=(30, 150), light=0,
                                          overlays=[(5, lambda img, L, rng: sound_rings(img, 560, 470, 7, spread=70))]),
    "ch06-what-the-glass-remembers": lambda: shaft_scene(206),
    "ch07-epilogue": lambda: dunescape(207, "dawn", sun=(1320, 450, 30),
                                       moons=[moon_ilu(300, 160, 70, 13, (0.6, -0.2, 0.75)),
                                              moon_thane(430, 120, 22, 24, (0.6, -0.2, 0.75))],
                                       top=0.76, amp=(30, 110),
                                       overlays=[(2, lambda img, L, rng: linen_lines(
                                           img, rng, [((40, 190), (1100, 230), 60, 9)], wind=0.3))]),
    # --- world
    "world": lambda: dunescape(301, "day", moons=[moon_ilu(1220, 140, 60, 14, (-0.4, 0.1, 0.9)),
                                                  moon_thane(1330, 110, 18, 25, (-0.4, 0.1, 0.9))],
                               sun=(300, 120, 26), top=0.55, amp=(40, 180), n=7),
    "kessari": lambda: planet_scene(302),
    "timeline": lambda: strata_scene(303),
    "moons": lambda: dunescape(304, "night", moons=[moon_ilu(620, 250, 170, 15), moon_thane(1060, 190, 56, 26)],
                               stars=1200, top=0.8, amp=(20, 90), light=0),
    "ilu": lambda: dunescape(305, "night", moons=[moon_ilu(800, 300, 230, 16, (-0.3, -0.2, 0.93))], stars=600,
                             top=0.82, amp=(20, 80), light=0),
    "thane": lambda: dunescape(306, "red", moons=[moon_thane(900, 220, 90, 27, (-0.5, -0.1, 0.86))], stars=500,
                               top=0.72, amp=(30, 140), light=-1),
    "places": lambda: dunescape(307, "dusk", sun=(300, 420, 30), top=0.68, amp=(30, 140),
                                overlays=[towers_on(0, 1180, 1420, 9, 50, 130, (250, 210, 190), (170, 120, 130)),
                                          (0, lambda img, L, rng: court_building(img, L[0], 360, 220, 46,
                                                                                 (90, 50, 50, 255)))]),
    "well-of-osk": lambda: dunescape(308, "dusk", sun=(260, 400, 30), top=0.62, amp=(30, 120),
                                     overlays=[(5, lambda img, L, rng: wellhead(img, 800, 440, 200, 54))]),
    "the-salt-courts": lambda: dunescape(309, "dusk", sun=(1360, 420, 30), top=0.7, amp=(20, 100),
                                         overlays=[(2, lambda img, L, rng: court_building(img, L[2], 760, 820, 190,
                                                                                          (52, 30, 34, 255)))]),
    "glassreach": lambda: dunescape(310, "day", sun=(1350, 150, 26), top=0.74, amp=(30, 100),
                                    overlays=[towers_on(1, 150, 1450, 34, 110, 400, (226, 240, 236),
                                                        (120, 150, 150))]),
    "the-salt-road": lambda: dunescape(311, "day", sun=(1200, 130, 26), top=0.52, amp=(20, 70), flat=0.7,
                                       overlays=[(5, lambda img, L, rng: road(img, rng, (700, 640), (940, 320), 300, 4))]),
    "the-loom-house": lambda: dunescape(312, "dusk", sun=(800, 440, 30), top=0.78, amp=(20, 90),
                                        overlays=[(1, lambda img, L, rng: linen_lines(
                                            img, rng, [((-20, 120), (820, 150), 40, 6), ((700, 110), (1640, 140), 46, 6),
                                                       ((200, 300), (1400, 320), 50, 10)],
                                            backlit=(255, 190, 120)))]),
    "the-singing-erg": lambda: dunescape(313, "dusk", sun=(1250, 380, 30), top=0.5, amp=(60, 230), n=7, ripple=0.08,
                                         overlays=[(6, lambda img, L, rng: sound_rings(img, 600, 330, 9, spread=70))]),
    "the-glass-annex": lambda: shaft_scene(315, salt=(), moons_in_water=False, warm_top=(176, 206, 214),
                                           deep=(8, 18, 36), water=(255, 214, 150), water_at=26, cx=W * 0.46,
                                           sun_angle=-1.2),
    "hollow-stone": lambda: dunescape(316, "indigo", stars=900, top=0.72, amp=(30, 120), light=0,
                                      moons=[moon_thane(1260, 150, 26, 32)],
                                      overlays=[(3, lambda img, L, rng: rocks(img, L[3], rng, 520, 1000, 130,
                                                                              colour=(14, 14, 28), teeth=9, cairn_at=None,
                                                                              style="teeth",
                                                                              lamp_at=(700, L[3].ridge(700) + 18)))]),
    "cairn-of-teeth": lambda: dunescape(317, "dusk", sun=(1350, 430, 30), top=0.7, amp=(30, 120),
                                        overlays=[(3, lambda img, L, rng: rocks(img, L[3], rng, 200, 1150, 150,
                                                                                cairn_at=1230))]),
    # --- factions
    "factions": lambda: dunescape(401, "dusk", sun=(800, 430, 30), top=0.8, amp=(20, 80),
                                  overlays=[(1, lambda img, L, rng: banners(img, rng, 240, 1360, 120, 330))]),
    "the-seven-houses": lambda: dunescape(402, "day", sun=(1400, 120, 26), top=0.82, amp=(20, 70),
                                          overlays=[(1, lambda img, L, rng: banners(img, rng, 120, 1480, 70, 400))]),
    "house-varn": lambda: dunescape(403, "indigo", moons=[moon_ilu(1160, 170, 70, 17)], stars=900, top=0.72,
                                    amp=(30, 130), light=0,
                                    overlays=[towers_on(1, 300, 700, 7, 120, 260, (120, 150, 220), (20, 30, 80),
                                                        edge=(180, 210, 255), lit=True, glints=True)]),
    "the-linen-keepers": lambda: linen_scene(404, quipu=True, ink_rows=False),
    "the-wellwrights": lambda: shaft_scene(405, moons_in_water=False, warm_top=(196, 160, 120),
                                           cx=W * 0.42),
    # --- people
    "people": lambda: dunescape(501, "dusk", sun=(1300, 420, 30), top=0.7, amp=(30, 130),
                                overlays=[(3, lambda img, L, rng: [lone_figure(img, L[3], x, 2.2, (40, 24, 26, 255))
                                                                   for x in (520, 610, 700, 980, 1090)])]),
    "ama-seyru": lambda: dunescape(502, "dawn", sun=(300, 430, 30), top=0.66, amp=(30, 150),
                                   overlays=[figure_on(4, 980, 3.2, (36, 24, 30, 255), lamp=True)]),
    "mother-hesk": lambda: dunescape(503, "night", moons=[moon_ilu(400, 230, 150, 18)], stars=800, top=0.76,
                                     amp=(30, 110), light=0, overlays=[figure_on(4, 1150, 3.6, (12, 10, 18, 255))]),
    "teodor-varn": lambda: dunescape(504, "indigo", stars=600, top=0.8, amp=(20, 90), light=0,
                                     overlays=[towers_on(0, 600, 1100, 8, 160, 380, (130, 160, 230), (16, 24, 70),
                                                         edge=(190, 220, 255), lit=True),
                                               figure_on(3, 380, 3.0, (8, 10, 24, 255))]),
    "orla-varn": lambda: dunescape(505, "indigo", moons=[moon_thane(1250, 160, 30, 28)], stars=700, top=0.7,
                                   amp=(30, 140), light=0,
                                   overlays=[(1, lambda img, L, rng: court_building(img, L[1], 520, 420, 110,
                                                                                    (10, 12, 30, 255),
                                                                                    glow_col=(120, 160, 255)))]),
    "ilen-seyru": lambda: dunescape(506, "night", moons=[moon_thane(1100, 160, 26, 29)], stars=1100, top=0.68,
                                    amp=(30, 140), light=0,
                                    overlays=[figure_on(3, 760, 1.8, (10, 8, 16, 255), lamp=True)]),
    "dela-fenn": lambda: dunescape(507, "dusk", sun=(1340, 440, 36), top=0.66, amp=(40, 150),
                                   layer_flat={2: 0.85},
                                   overlays=[caravan_on(2, 380, 900, 10, 1.15, (40, 22, 22, 255), lamps=True)]),
    "pell-odrin": lambda: shaft_scene(508, salt=(), warm_top=(170, 130, 96), deep=(6, 20, 30), cx=W * 0.68,
                                      moons_in_water=False),
    # --- field notes
    "field-notes": lambda: linen_scene(601, knots=False),
    "expedition-checklist": lambda: dunescape(602, "noon", sun=(1100, 90, 30), top=0.62, amp=(30, 140),
                                              layer_flat={4: 0.9},
                                              overlays=[caravan_on(4, 200, 560, 5, 2.0, (70, 40, 28, 255))]),
    "knot-reckoning": lambda: linen_scene(603, quipu=True, ink_rows=True, lamp=True),
    "the-dunes-at-dusk": lambda: dunescape(604, "dusk", sun=(900, 440, 36), top=0.62, amp=(40, 190), n=7,
                                           ripple=0.08,
                                           overlays=[(6, lambda img, L, rng: sound_rings(img, 900, 400, 8, spread=80))]),
    "scratch": lambda: linen_scene(605, knots=True, ink_rows=True, lamp=False, soft=1.1),
    # --- the film shelf (no text, no moons from this world)
    "screening-1": lambda: dunescape(801, "dusk", sun=(1250, 395, 60), top=0.68, amp=(40, 200), n=6,
                                     overlays=[figure_on(5, 420, 4.5, (20, 10, 10, 255))]),
    "screening-2": lambda: dunescape(802, "storm", top=0.74, amp=(30, 110), light=1,
                                     overlays=[(-1, lambda img, L, rng: dust_wall(img, rng)),
                                               caravan_on(4, 900, 1300, 6, 1.8, (60, 34, 24, 255))], layer_flat={4: 0.9}),
    "screening-3": lambda: dunescape(803, "night", stars=1600, moons=[moon_ilu(420, 170, 60, 31, (0.7, -0.2, 0.7))], top=0.74, amp=(30, 150), light=0,
                                     overlays=[figure_on(4, 1000, 2.6, (6, 6, 12, 255))]),
    "screening-4": lambda: dunescape(804, "red", sun=(800, 420, 140), top=0.72, amp=(30, 130), light=1),
    "screening-5": lambda: dunescape(805, "mono", sun=(260, 120, 20), top=0.5, amp=(60, 260), n=7, shear=0.9,
                                     sharp=2.2),
    "screening-6": lambda: strata_scene(806, "noon"),
    "screening-7": lambda: dunescape(807, "violet", sun=(400, 430, 30), top=0.7, amp=(30, 140),
                                     layer_flat={3: 0.9}, overlays=[caravan_on(3, 760, 1400, 14, 1.0, (50, 30, 50, 255))]),
    "screening-8": lambda: dunescape(808, "day", sun=(1500, 60, 26), top=0.18, amp=(80, 340), n=5, ripple=0.14,
                                     freq=(0.03, 0.006), shear=1.0),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", help="comma-separated cover names (or map, wav)")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None
    sizes = {}
    for name, fn in SCENES.items():
        if only and name not in only:
            continue
        sizes[f"covers/{name}.jpg"] = save_jpeg(fn(), COVERS / f"{name}.jpg")
        print(f"covers/{name}.jpg  {sizes[f'covers/{name}.jpg'] // 1024} KB", flush=True)
    if not only or "map" in only:
        s = make_map(ROOT / "map-of-the-salt-road.png")
        print(f"map-of-the-salt-road.png  {s // 1024} KB")
    if not only or "wav" in only:
        s = make_wav(ROOT / "the-dunes-at-dusk.wav")
        print(f"the-dunes-at-dusk.wav  {s // 1024} KB")


if __name__ == "__main__":
    main()
