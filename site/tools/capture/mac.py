"""The macOS twin of cap.Session: drives the installed Liber Linteum.app on the
main display with Quartz events and records with ffmpeg's avfoundation.

The frame is the top-left 1152x720 points of the main (2x) display, so the
system menu bar is on camera (menus are clicked there) and the window sits just
under it. Coordinates are those points (2304x1440 device pixels). The app's
data dirs are wiped and rewritten for every session, so the user's own ones
must have been moved aside first (`<dir>.bak`); start() refuses otherwise.
"""

import json
import math
import os
import shutil
import subprocess
import time

import Quartz as Q
from AppKit import NSPasteboard, NSPasteboardTypeString, NSRunningApplication, NSScreen
from ApplicationServices import (
    AXUIElementCopyAttributeValue,
    AXUIElementCreateApplication,
    AXUIElementSetAttributeValue,
    AXValueCreate,
    kAXPositionAttribute,
    kAXSizeAttribute,
    kAXValueCGPointType,
    kAXValueCGSizeType,
    kAXWindowsAttribute,
)
from PIL import Image

from cap import WORK

W, H, SCALE = 2304, 1440, 2
APP = os.environ.get("LIBER_APP", "/Applications/Liber Linteum.app")
LIB = os.path.expanduser("~/Library")
DATA = [f"{LIB}/Application Support/app.liberlinteum.desktop", f"{LIB}/WebKit/app.liberlinteum.desktop"]
# avfoundation's index of the main display ("Capture screen N"); see `ffmpeg -f avfoundation -list_devices true -i ""`.
# Wheel lines per click, so a click moves about as far as on Linux.
LINES = 3
SCREEN = os.environ.get("CAPTURE_SCREEN", "3")

KEYS = {
    "Return": 36, "Tab": 48, "space": 49, "BackSpace": 51, "Escape": 53, "Delete": 117,
    "Home": 115, "End": 119, "Page_Up": 116, "Page_Down": 121,
    "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
    "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
    "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35,
    "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ",": 43, ".": 47, "/": 44,
}
# Linux's Ctrl shortcuts are Cmd here; macOS's Control is "mac_ctrl".
MODS = {"ctrl": Q.kCGEventFlagMaskCommand, "cmd": Q.kCGEventFlagMaskCommand,
        "shift": Q.kCGEventFlagMaskShift, "alt": Q.kCGEventFlagMaskAlternate,
        "mac_ctrl": Q.kCGEventFlagMaskControl}


def menubar_height():
    s = NSScreen.screens()[0]
    f, v = s.frame(), s.visibleFrame()
    return int(f.size.height - (v.origin.y + v.size.height))


class Session:
    def __init__(self, binary=None, settings=None, home=None, files=None, env=None):
        self.settings = settings
        self.rec = None
        self.pid = None
        self.down = False

    # -- lifecycle ------------------------------------------------------
    def start(self):
        for d in DATA:
            if os.path.exists(d) and not os.path.exists(d + ".bak"):
                raise RuntimeError(f"move {d} aside to {d}.bak first: it is the user's")
            shutil.rmtree(d, ignore_errors=True)
        os.makedirs(DATA[0])
        with open(os.path.join(DATA[0], "settings.json"), "w") as f:
            json.dump(self.settings, f)
        before = set(self._pids())
        subprocess.run(["open", "-n", "-a", APP], check=True)
        end = time.time() + 40
        while time.time() < end and not self.pid:
            new = [p for p in self._pids() if p not in before]
            self.pid = new[0] if new else None
            time.sleep(0.3)
        if not self.pid:
            raise RuntimeError("the app never started")
        self._wait_window()
        self.fit()

    def _pids(self):
        out = subprocess.run(["pgrep", "-f", f"{APP}/Contents/MacOS/"], capture_output=True, text=True).stdout
        return [int(p) for p in out.split()]

    def stop(self):
        self.stop_recording()
        if self.pid:
            subprocess.run(["kill", str(self.pid)])
            for _ in range(50):
                if self.pid not in self._pids():
                    break
                time.sleep(0.2)
            self.pid = None
        time.sleep(1.0)

    def _windows(self):
        app = AXUIElementCreateApplication(self.pid)
        err, wins = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, None)
        return list(wins or [])

    def _wait_window(self, timeout=40):
        end = time.time() + timeout
        while time.time() < end:
            if self._windows():
                time.sleep(1.0)
                return
            time.sleep(0.3)
        raise RuntimeError("the app window never appeared")

    def fit(self):
        mb = menubar_height()
        win = self._windows()[0]
        AXUIElementSetAttributeValue(win, kAXPositionAttribute, AXValueCreate(kAXValueCGPointType, (0, mb)))
        AXUIElementSetAttributeValue(win, kAXSizeAttribute, AXValueCreate(kAXValueCGSizeType, (1152, 720 - mb)))
        # Frontmost, or the first click only activates the window.
        NSRunningApplication.runningApplicationWithProcessIdentifier_(self.pid).activateWithOptions_(0)
        time.sleep(1.0)

    def dialogs(self):
        return self._windows()[1:]

    # -- input (points of the frame) ------------------------------------
    def _pos(self):
        p = Q.CGEventGetLocation(Q.CGEventCreate(None))
        return p.x, p.y

    def _mouse(self, kind, x, y, button=Q.kCGMouseButtonLeft, clicks=1):
        e = Q.CGEventCreateMouseEvent(None, kind, (x, y), button)
        Q.CGEventSetIntegerValueField(e, Q.kCGMouseEventClickState, clicks)
        Q.CGEventPost(Q.kCGHIDEventTap, e)

    def move(self, x, y, duration=0.0):
        kind = Q.kCGEventLeftMouseDragged if self.down else Q.kCGEventMouseMoved
        if duration <= 0:
            self._mouse(kind, x, y)
            return
        sx, sy = self._pos()
        steps = max(2, int(duration * 60))
        for i in range(1, steps + 1):
            e = 0.5 - 0.5 * math.cos(math.pi * i / steps)  # ease in-out
            self._mouse(kind, sx + (x - sx) * e, sy + (y - sy) * e)
            time.sleep(duration / steps)

    def click(self, x=None, y=None, button=1, duration=0.35, double=False):
        if x is not None:
            self.move(x, y, duration)
            time.sleep(0.12)  # WebKit drops a press that arrives with the move
        px, py = self._pos()
        down, up, b = (
            (Q.kCGEventLeftMouseDown, Q.kCGEventLeftMouseUp, Q.kCGMouseButtonLeft) if button == 1
            else (Q.kCGEventRightMouseDown, Q.kCGEventRightMouseUp, Q.kCGMouseButtonRight)
        )
        for n in range(1, 3 if double else 2):
            self._mouse(down, px, py, b, n)
            time.sleep(0.05)
            self._mouse(up, px, py, b, n)
            time.sleep(0.08)

    def drag(self, x1, y1, x2, y2, duration=1.0):
        self.move(x1, y1, 0.3)
        self._mouse(Q.kCGEventLeftMouseDown, x1, y1)
        self.down = True
        time.sleep(0.3)  # a quicker start selects text instead of picking the block up
        self.move(x1 + 2, y1 + 8, 0.25)
        self.move(x2, y2, duration)
        time.sleep(0.25)
        self._mouse(Q.kCGEventLeftMouseUp, x2, y2)
        self.down = False

    def scroll(self, clicks, x=None, y=None):
        """Positive scrolls down (Linux's wheel button 5), in wheel lines."""
        if x is not None:
            self.move(x, y, 0.2)
        for _ in range(abs(clicks)):
            e = Q.CGEventCreateScrollWheelEvent(None, Q.kCGScrollEventUnitLine, 1, -LINES if clicks > 0 else LINES)
            Q.CGEventPost(Q.kCGHIDEventTap, e)
            time.sleep(0.04)

    def _key(self, code, flags=0):
        for down in (True, False):
            e = Q.CGEventCreateKeyboardEvent(None, code, down)
            Q.CGEventSetFlags(e, flags)
            Q.CGEventPost(Q.kCGHIDEventTap, e)
            time.sleep(0.02)

    def key(self, combo):
        """`ctrl+shift+f` (Ctrl is Cmd here), `Escape`, `Return`…"""
        *mods, name = combo.split("+")
        flags = 0
        for m in mods:
            flags |= MODS[m]
        self._key(KEYS[name if name in KEYS else name.lower()], flags)
        time.sleep(0.06)

    def type(self, text, cps=14):
        for ch in text:
            if ch == "\n":
                self._key(KEYS["Return"])
            else:
                for down in (True, False):
                    e = Q.CGEventCreateKeyboardEvent(None, 0, down)
                    Q.CGEventKeyboardSetUnicodeString(e, len(ch), ch)
                    Q.CGEventSetFlags(e, 0)
                    Q.CGEventPost(Q.kCGHIDEventTap, e)
                    time.sleep(0.01)
            time.sleep(1 / cps)

    def clipboard(self, timeout=3.0):
        return NSPasteboard.generalPasteboard().stringForType_(NSPasteboardTypeString)

    def pixel(self, x, y):
        p = f"{WORK}/pixel.png"
        subprocess.run(["screencapture", "-x", f"-R{x},{y},1,1", p], check=True)
        return Image.open(p).convert("RGB").getpixel((0, 0))

    # -- capture ---------------------------------------------------------
    def shot(self, path):
        subprocess.run(["screencapture", "-x", "-R0,0,1152,720", path], check=True)
        return path

    def record(self, path, fps=30):
        self.stop_recording()
        self.rec = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "avfoundation", "-capture_cursor", "1",
             "-pixel_format", "bgr0", "-framerate", str(fps), "-i", f"{SCREEN}:none",
             "-vf", f"crop={W}:{H}:0:0", "-fps_mode", "cfr", "-r", str(fps),
             "-c:v", "libx264rgb", "-crf", "0", "-preset", "ultrafast", path],
            stdin=subprocess.PIPE,
        )
        time.sleep(1.2)

    def stop_recording(self):
        if self.rec:
            try:
                self.rec.communicate(b"q", timeout=60)
            except Exception:
                self.rec.kill()
            self.rec = None
