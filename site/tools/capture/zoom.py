"""Camera moves on a recorded clip: `zoom(src, dst, keys)` eases between keyframes
`(seconds, cx, cy, scale)`, with the centre in logical pixels of the 1152x720
window and scale 1 for the whole frame. Holds the first key before it and the
last after it. The output is lossless, like the input.

Sub-pixel crops (Pillow's `resize(box=...)`), so slow moves don't jitter.
"""

import subprocess

from PIL import Image

W, H, SCALE = 2304, 1440, 2


def _ease(t):
    return t * t * (3 - 2 * t)


def camera(keys, t):
    if t <= keys[0][0]:
        return keys[0][1:]
    for (t0, *a), (t1, *b) in zip(keys, keys[1:]):
        if t <= t1:
            e = _ease((t - t0) / (t1 - t0)) if t1 > t0 else 1.0
            return tuple(x + (y - x) * e for x, y in zip(a, b))
    return keys[-1][1:]


def _box(cx, cy, scale):
    w, h = W / scale, H / scale
    x = min(max(cx * SCALE - w / 2, 0), W - w)
    y = min(max(cy * SCALE - h / 2, 0), H - h)
    return (x, y, x + w, y + h)


def zoom(src, dst, keys, fps=30):
    dec = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    enc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-framerate", str(fps), "-i", "-",
         "-c:v", "libx264rgb", "-crf", "0", "-preset", "ultrafast", dst],
        stdin=subprocess.PIPE,
    )
    size = W * H * 3
    n = 0
    while True:
        raw = dec.stdout.read(size)
        if len(raw) < size:
            break
        cx, cy, scale = camera(keys, n / fps)
        if scale > 1.001:
            im = Image.frombytes("RGB", (W, H), raw)
            raw = im.resize((W, H), Image.Resampling.BICUBIC, box=_box(cx, cy, scale)).tobytes()
        enc.stdin.write(raw)
        n += 1
    enc.stdin.close()
    enc.wait()
    dec.wait()
    return dst
