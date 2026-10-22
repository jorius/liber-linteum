"""Drive Liber Linteum in a hidden Xvfb display and capture stills and clips.

The app runs with its own config/cache/data dirs and its own D-Bus session, so
it never touches the user's settings or their running copy. Coordinates are in
logical pixels of a 1152x720 window rendered at 2x (2304x1440 device pixels).
"""

import json
import math
import os
import shutil
import signal
import subprocess
import time

from Xlib import X, XK, display as xdisplay
from Xlib.ext import xtest

DISPLAY = ":99"
W, H, SCALE = 2304, 1440, 2
# Outside the repo: lossless clips are large.
WORK = os.environ.get("CAPTURE_WORK", "/tmp/liber-capture")


class Session:
    def __init__(self, binary, settings, home=None):
        self.binary = binary
        self.home = home or os.path.join(WORK, "home")
        self.settings = settings
        self.procs = []
        self.rec = None

    # -- lifecycle ------------------------------------------------------
    def start(self):
        if os.path.isdir(self.home):
            shutil.rmtree(self.home)
        cfg = os.path.join(self.home, ".config", "app.liberlinteum.desktop")
        os.makedirs(cfg)
        with open(os.path.join(cfg, "settings.json"), "w") as f:
            json.dump(self.settings, f)
        xv = subprocess.Popen(
            ["Xvfb", DISPLAY, "-screen", "0", f"{W}x{H}x24", "-nolisten", "tcp", "-dpi", "192"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.procs.append(xv)
        time.sleep(1.5)
        env = {
            "PATH": os.environ["PATH"],
            "HOME": self.home,
            "XDG_CONFIG_HOME": os.path.join(self.home, ".config"),
            "XDG_CACHE_HOME": os.path.join(self.home, ".cache"),
            "XDG_DATA_HOME": os.path.join(self.home, ".local", "share"),
            "DISPLAY": DISPLAY,
            "GDK_BACKEND": "x11",
            "GDK_SCALE": str(SCALE),
            "WEBKIT_DISABLE_DMABUF_RENDERER": "1",
            "LANG": "en_US.UTF-8",
            "NO_AT_BRIDGE": "1",
        }
        app = subprocess.Popen(
            ["dbus-run-session", "--", self.binary],
            env=env, stdout=open(os.path.join(WORK, "app.log"), "w"), stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.procs.append(app)
        self.d = xdisplay.Display(DISPLAY)
        self.win = self._wait_window()
        self.fit()

    def stop(self):
        self.stop_recording()
        for p in reversed(self.procs):
            try:
                os.killpg(p.pid, signal.SIGTERM) if p is self.procs[-1] else p.terminate()
            except Exception:
                pass
        for p in self.procs:
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()

    def _wait_window(self, timeout=40):
        end = time.time() + timeout
        while time.time() < end:
            root = self.d.screen().root
            for w in root.query_tree().children:
                try:
                    cls = w.get_wm_class()
                    attrs = w.get_attributes()
                except Exception:
                    continue
                if cls and "liber" in " ".join(cls).lower() and attrs.map_state == X.IsViewable:
                    return w
            time.sleep(0.5)
        raise RuntimeError("the app window never appeared (see work/app.log)")

    def dialogs(self):
        """Other mapped top-level windows of the app (GTK dialogs), with geometry."""
        out = []
        for w in self.d.screen().root.query_tree().children:
            if w.id == self.win.id:
                continue
            try:
                if w.get_attributes().map_state != X.IsViewable:
                    continue
                g = w.get_geometry()
            except Exception:
                continue
            if g.width > 50 and g.height > 50:
                out.append((w, g))
        return out

    def place_dialog(self, x, y):
        """Moves the first dialog to (x, y) device px; answers its size."""
        found = self.dialogs()
        if not found:
            return None
        w, g = found[-1]
        w.configure(x=x, y=y, width=min(g.width, W - x - 40), height=min(g.height, H - y - 40))
        self.d.sync()
        time.sleep(0.5)
        return g.width, g.height

    def fit(self):
        self.win.configure(x=0, y=0, width=W, height=H)
        self.d.sync()
        time.sleep(1.0)

    # -- input (logical px) --------------------------------------------
    def _xy(self, x, y):
        return int(x * SCALE), int(y * SCALE)

    def move(self, x, y, duration=0.0):
        tx, ty = self._xy(x, y)
        if duration <= 0:
            xtest.fake_input(self.d, X.MotionNotify, x=tx, y=ty)
            self.d.sync()
            return
        p = self.d.screen().root.query_pointer()
        sx, sy = p.root_x, p.root_y
        steps = max(2, int(duration * 60))
        for i in range(1, steps + 1):
            t = i / steps
            e = 0.5 - 0.5 * math.cos(math.pi * t)  # ease in-out
            xtest.fake_input(self.d, X.MotionNotify, x=int(sx + (tx - sx) * e), y=int(sy + (ty - sy) * e))
            self.d.sync()
            time.sleep(duration / steps)

    def click(self, x=None, y=None, button=1, duration=0.35, double=False):
        if x is not None:
            self.move(x, y, duration)
        for _ in range(2 if double else 1):
            xtest.fake_input(self.d, X.ButtonPress, button)
            self.d.sync()
            time.sleep(0.05)
            xtest.fake_input(self.d, X.ButtonRelease, button)
            self.d.sync()
            time.sleep(0.08)

    def drag(self, x1, y1, x2, y2, duration=1.0):
        self.move(x1, y1, 0.3)
        xtest.fake_input(self.d, X.ButtonPress, 1)
        self.d.sync()
        time.sleep(0.15)
        self.move(x1 + 6, y1 + 3, 0.1)
        self.move(x2, y2, duration)
        time.sleep(0.25)
        xtest.fake_input(self.d, X.ButtonRelease, 1)
        self.d.sync()

    def scroll(self, clicks, x=None, y=None):
        if x is not None:
            self.move(x, y, 0.2)
        button = 5 if clicks > 0 else 4
        for _ in range(abs(clicks)):
            self.click(button=button, duration=0)
            time.sleep(0.04)

    def _keycode(self, ch):
        names = {
            " ": "space", "\n": "Return", "\t": "Tab", "-": "minus", "/": "slash", ".": "period",
            ",": "comma", ":": "colon", "[": "bracketleft", "]": "bracketright", "#": "numbersign",
            "!": "exclam", "?": "question", "'": "apostrophe", '"': "quotedbl", "(": "parenleft",
            ")": "parenright", "=": "equal", "*": "asterisk", "_": "underscore", ">": "greater",
            "~": "asciitilde", "`": "grave",
        }
        sym = XK.string_to_keysym(names.get(ch, ch))
        code = self.d.keysym_to_keycode(sym)
        shift = self.d.keycode_to_keysym(code, 0) != sym
        return code, shift

    def key(self, combo):
        """`ctrl+shift+f`, `Escape`, `Return`…"""
        parts = combo.split("+")
        mods = {"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L"}
        codes = [self.d.keysym_to_keycode(XK.string_to_keysym(mods.get(p, p))) for p in parts]
        for c in codes:
            xtest.fake_input(self.d, X.KeyPress, c)
        self.d.sync()
        time.sleep(0.04)
        for c in reversed(codes):
            xtest.fake_input(self.d, X.KeyRelease, c)
        self.d.sync()
        time.sleep(0.06)

    def type(self, text, cps=14):
        shift_code = self.d.keysym_to_keycode(XK.string_to_keysym("Shift_L"))
        for ch in text:
            code, shift = self._keycode(ch)
            if shift:
                xtest.fake_input(self.d, X.KeyPress, shift_code)
            xtest.fake_input(self.d, X.KeyPress, code)
            xtest.fake_input(self.d, X.KeyRelease, code)
            if shift:
                xtest.fake_input(self.d, X.KeyRelease, shift_code)
            self.d.sync()
            time.sleep(1 / cps)

    def clipboard(self, timeout=3.0):
        """The CLIPBOARD selection as text (what the app's Copy put there)."""
        d = self.d
        w = d.screen().root.create_window(0, 0, 1, 1, 0, X.CopyFromParent)
        clip, utf8, prop = (d.intern_atom(n) for n in ("CLIPBOARD", "UTF8_STRING", "LIBER_CLIP"))
        w.convert_selection(clip, utf8, prop, X.CurrentTime)
        d.flush()
        end = time.time() + timeout
        while time.time() < end:
            while d.pending_events():
                e = d.next_event()
                if e.type == X.SelectionNotify:
                    if e.property == X.NONE:
                        return None
                    value = w.get_full_property(prop, X.AnyPropertyType).value
                    return value.decode() if isinstance(value, bytes) else str(value)
            time.sleep(0.05)
        return None

    def pixel(self, x, y):
        """The (r, g, b) at logical (x, y) on screen now."""
        tx, ty = self._xy(x, y)
        raw = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-f", "x11grab", "-video_size", "1x1",
             "-i", f"{DISPLAY}+{tx},{ty}", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            capture_output=True, check=True,
        ).stdout
        return tuple(raw[:3])

    # -- capture ---------------------------------------------------------
    def shot(self, path):
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", f"{W}x{H}",
             "-i", DISPLAY, "-frames:v", "1", path],
            check=True,
        )
        return path

    def record(self, path, fps=30):
        self.stop_recording()
        self.rec = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1",
             "-framerate", str(fps), "-video_size", f"{W}x{H}", "-i", DISPLAY,
             "-c:v", "libx264rgb", "-crf", "0", "-preset", "ultrafast", path],
            stdin=subprocess.PIPE,
        )
        time.sleep(0.6)

    def stop_recording(self):
        if self.rec:
            try:
                self.rec.communicate(b"q", timeout=30)
            except Exception:
                self.rec.kill()
            self.rec = None


def encode(src, slug, out_dir, start=0.0, length=None):
    """The site's three files for a slot, from a lossless capture."""
    trim = ["-ss", str(start)] + (["-t", str(length)] if length else [])
    base = os.path.join(out_dir, slug)
    run = lambda *a: subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *a], check=True)
    run(*trim, "-i", src, "-an", "-vf", "scale=2304:-2", "-c:v", "libvpx-vp9", "-b:v", "0",
        "-crf", "50", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", base + ".webm")
    run(*trim, "-i", src, "-an", "-vf", "scale=2304:-2,format=yuv420p", "-c:v", "libx264",
        "-crf", "26", "-preset", "slow", "-movflags", "+faststart", base + ".mp4")
    run("-ss", str(start), "-i", src, "-frames:v", "1", "-vf", "scale=2304:-2", "-c:v", "libwebp",
        "-quality", "78", base + ".poster.webp")
