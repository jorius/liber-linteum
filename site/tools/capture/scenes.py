"""Record one scene: `python scenes.py <name>`; frames for review land in
work/shots/<name>-*.png, the lossless clips in work/clips/<name>[-a|-b…].mkv.
`python scenes.py encode [slug…]` cuts, zooms and joins them into site/media/.

A scene that has to leave something out (a system file dialog, a long wait, a
key being guessed) records several parts, `<slug>-a`, `<slug>-b`…; `EDITS`
says which seconds of each part to keep and where the camera zooms."""

import json
import os
import shutil
import subprocess
import sys
import time

import common
from PIL import Image


def snap(s, name):
    p = s.shot(f"{common.SHOTS}/{name}.png")
    Image.open(p).resize((1152, 720)).save(f"{common.SHOTS}/{name}-s.png")


def rec(s, name):
    s.record(f"{common.CLIPS}/{name}.mkv")


def open_vault(s):
    s.start()
    time.sleep(2.5)
    s.click(740, 172, duration=0)  # The Moons of Kessari in Recent
    time.sleep(4)


def wheel(s, clicks, x, y, gap=0.12):
    """Zooms the canvas around (x, y): negative clicks zoom in."""
    s.move(x, y, 0.4)
    for _ in range(abs(clicks)):
        s.scroll(-1 if clicks < 0 else 1)
        time.sleep(gap)


# --------------------------------------------------------------------------
# Hero: the Global View, expand in place, drill down, atoms, a quick edit.


def hero(s):
    open_vault(s)
    s.key("ctrl+2")
    time.sleep(3)
    s.move(1060, 420, 0)
    time.sleep(0.5)
    rec(s, "hero")
    time.sleep(1.5)
    s.click(1068, 93, duration=0.9)  # Expand in place
    time.sleep(1.6)
    wheel(s, -1, 745, 480, gap=0.2)
    time.sleep(0.6)
    s.click(*HERO_STORY, duration=0.7)  # The Story: See all, in place
    time.sleep(2.4)
    snap(s, "hero-expanded")
    wheel(s, 1, 745, 480, gap=0.2)  # back out, so Drill-down fits the cards again
    s.click(956, 93, duration=1.0)  # Drill-down
    time.sleep(2.0)
    s.click(500, 550, duration=0.9)  # World: drill in
    time.sleep(2.4)
    snap(s, "hero-world")
    s.click(707, 524, duration=0.9)  # Kessari: See atoms
    time.sleep(2.2)
    wheel(s, -8, 680, 300, gap=0.1)
    time.sleep(1.4)
    snap(s, "hero-atoms")
    s.click(*HERO_FORMULA, duration=0.8)  # the formula's atom: opens the page there
    time.sleep(2.4)
    snap(s, "hero-page")
    s.click(1000, 460, duration=0.6)  # off the formula, so it renders again
    time.sleep(0.6)
    s.click(*HERO_CLOSING, duration=0.6)  # end of "That is a Closing."
    s.key("End")
    time.sleep(0.3)
    s.type(" The Keepers call it ==the breath of the Well==.", cps=15)
    time.sleep(0.4)
    s.key("Down")
    s.key("Down")
    s.move(1000, 620, 0.6)
    time.sleep(1.8)
    snap(s, "hero-end")
    s.stop_recording()


# Coordinates from here on are points of the macOS frame (mac.py): the menu bar
# on top, the window under it. The Linux layout (cap.py) put everything ~25 px higher.
HERO_STORY = (713, 508)
HERO_FORMULA = (680, 350)
HERO_CLOSING = (785, 658)


# --------------------------------------------------------------------------


def sample_vault(s):
    """From Recent into the vault, its Global View, then into World."""
    s.start()
    time.sleep(2.5)
    s.move(900, 500, 0)
    rec(s, "sample-vault")
    time.sleep(0.8)
    s.click(740, 172, duration=1.0)  # open from Recent
    time.sleep(2.2)
    s.key("ctrl+2")
    time.sleep(2.4)
    s.click(500, 550, duration=1.0)  # World
    time.sleep(2.6)
    s.move(1060, 420, 0.8)
    time.sleep(0.5)
    s.stop_recording()


def global_view(s):
    """Drill into World, then into Places, then back up."""
    open_vault(s)
    s.key("ctrl+2")
    time.sleep(2.5)
    s.move(1060, 420, 0)
    rec(s, "global-view")
    time.sleep(0.8)
    s.click(500, 550, duration=1.0)  # World
    time.sleep(2.2)
    s.click(572, 450, duration=1.0)  # Places
    time.sleep(2.4)
    snap(s, "gv-places")
    s.click(357, 92, duration=0.9)  # breadcrumb: World
    time.sleep(1.8)
    s.move(1060, 420, 0.8)
    s.stop_recording()


def atoms(s):
    """A page's atoms: the tree of its sections and blocks; one opens the page."""
    open_vault(s)
    s.key("ctrl+2")
    time.sleep(2.5)
    s.click(500, 550, duration=0)  # World
    time.sleep(2.5)
    s.move(1060, 420, 0)
    rec(s, "atoms")
    time.sleep(1.0)
    s.click(707, 524, duration=1.0)  # Kessari: See atoms
    time.sleep(2.4)
    wheel(s, -8, 680, 300, gap=0.15)
    time.sleep(0.6)
    wheel(s, -3, *HERO_FORMULA, gap=0.15)
    time.sleep(1.2)
    snap(s, "atoms-tree")
    s.move(*HERO_FORMULA, 0.8)  # the formula's atom
    time.sleep(1.0)
    s.click(duration=0)
    time.sleep(2.6)
    snap(s, "atoms-page")
    s.stop_recording()


def editor(s):
    """A chapter in Live Preview: write a line with a highlight and a link."""
    open_vault(s)
    s.click(120, 256, duration=0)  # Favorites: chapter 01
    time.sleep(2.5)
    s.scroll(6, 600, 520)
    time.sleep(1.0)
    s.move(900, 480, 0)
    rec(s, "editor")
    time.sleep(0.6)
    s.click(766, 502, duration=0.9)  # end of "mending its selvedge."
    s.key("End")
    time.sleep(0.3)
    s.type(" She tied one more knot for ==the water owed==, as ", cps=16)
    s.type("[[Moth", cps=10)
    time.sleep(1.0)
    s.key("Return")
    time.sleep(0.4)
    s.type(" had taught her.", cps=16)
    time.sleep(0.4)
    s.key("Down")
    s.key("Down")
    time.sleep(1.6)
    snap(s, "editor-typed")
    s.stop_recording()


def maths(s):
    """Split view on Kessari: LaTeX and Mermaid, rendered as they're typed."""
    open_vault(s)
    s.click(24, 432, duration=0)  # World
    time.sleep(1.0)
    s.click(84, 607, duration=0)  # Kessari
    time.sleep(2.5)
    s.click(225, 94, duration=0)  # hide the sidebar
    time.sleep(1.2)
    s.click(1093, 238, duration=0)  # Split
    time.sleep(2.0)
    s.click(1127, 323, duration=0)  # close the one-time split hint
    time.sleep(1.0)
    s.scroll(8, 400, 600)
    time.sleep(1.5)
    s.move(400, 650, 0)
    rec(s, "maths")
    time.sleep(1.2)
    snap(s, "maths-split")
    s.click(190, 605, duration=0.8)  # "…That is a **Closing**."
    s.key("End")
    time.sleep(0.3)
    s.type(" A year holds $Y / S = 26$ of them.", cps=13)
    time.sleep(1.4)
    s.move(400, 520, 0.4)
    s.scroll(3)
    time.sleep(1.2)
    snap(s, "maths-mermaid")
    s.click(*MATHS_EDGE, duration=0.8)  # the diagram's last edge
    s.key("End")
    s.key("Return")
    s.key("shift+Home")
    s.type('    Dusk -.-> Year(["26 Closings in a year"])', cps=13)
    time.sleep(2.2)
    snap(s, "maths-end")
    s.stop_recording()


MATHS_EDGE = (330, 568)


def drag_drop(s):
    """A block dragged in Split view, a page into a folder, card to card."""
    open_vault(s)
    s.click(80, 191, duration=0)  # fold Favorites
    time.sleep(0.6)
    s.click(24, 259, duration=0)  # Field Notes
    time.sleep(0.8)
    s.click(124, 294, duration=0)  # Expedition Checklist
    time.sleep(2.5)
    s.click(225, 94, duration=0)  # hide the sidebar
    time.sleep(1.0)
    s.click(1093, 238, duration=0)  # Split
    time.sleep(2.0)
    s.click(1127, 323, duration=0)  # close the one-time split hint
    time.sleep(1.0)
    s.scroll(2, 900, 500)
    time.sleep(1.5)
    s.move(900, 560, 0)
    rec(s, "drag-drop")
    time.sleep(0.8)
    s.move(720, 442, 0.8)  # "Tell anyone else": its handle shows
    time.sleep(0.5)
    s.drag(607.5, 442.5, 612, 637, duration=1.4)  # into "On the road"
    time.sleep(1.6)
    snap(s, "dd-block")
    s.click(30, 94, duration=0.8)  # show the sidebar
    time.sleep(1.2)
    snap(s, "dd-sidebar")
    s.drag(130, 431, 110, 536, duration=1.3)  # Scratch → The Story
    time.sleep(2.2)
    snap(s, "dd-moved")
    s.key("ctrl+2")
    time.sleep(2.4)
    snap(s, "dd-gv")
    s.drag(765, 260, 700, 580, duration=1.4)  # Screening Room's link handle → Welcome
    time.sleep(2.2)
    snap(s, "dd-related")
    s.stop_recording()


def voice(s, mic):
    """Record into a page from the microphone; the clip lands in the page."""
    open_vault(s)
    s.click(24, 327, duration=0)  # Field Notes
    time.sleep(0.8)
    s.click(130, 432, duration=0)  # Scratch - Loose Threads
    time.sleep(2.5)
    s.click(700, 560, duration=0)
    s.key("ctrl+Down")  # Cmd+Down: the end of the page
    time.sleep(1.0)
    s.move(800, 560, 0)
    mic.speak()
    rec(s, "voice")
    time.sleep(0.8)
    s.key("Return")
    s.key("Return")
    s.type("Voice note, the night before the Closing:", cps=16)
    s.key("Return")
    s.key("Return")
    time.sleep(0.4)
    s.click(787, 259, duration=0.9)  # Record clip
    time.sleep(1.2)
    s.click(652, 316, duration=0.7)  # Start recording
    time.sleep(5.5)
    snap(s, "voice-recording")
    s.click(580, 316, duration=0.6)  # Stop & insert
    time.sleep(1.4)
    s.click(700, 470, duration=0.7)  # elsewhere: the clip shows as a player
    time.sleep(1.0)
    s.scroll(5, 700, 500)
    s.move(380, 568, 0.8)  # its play button (find it again after the scroll)
    time.sleep(0.6)
    s.click(duration=0)  # play
    time.sleep(4.0)
    snap(s, "voice-end")
    s.stop_recording()


def search(s):
    """Search the vault, narrow it with a tag, open a result at the match."""
    open_vault(s)
    s.move(700, 400, 0)
    rec(s, "search")
    time.sleep(0.6)
    s.key("ctrl+shift+f")
    time.sleep(0.9)
    s.type("camels", cps=7)
    time.sleep(1.6)
    s.click(665, 243, duration=0.9)  # #place
    time.sleep(1.8)
    snap(s, "search-tag")
    s.click(450, 590, duration=0.8)  # Cairn of Teeth
    time.sleep(2.6)
    snap(s, "search-open")
    s.stop_recording()


def pick(s, path, folder):
    """Drive the system file dialog: type the path, accept."""
    if sys.platform == "darwin":
        s.key("cmd+shift+g")  # Go to folder
        time.sleep(0.8)
        s.type(path, cps=40)
        time.sleep(0.8)
        s.key("Return")
        time.sleep(1.2)
        s.key("Return")  # Open
        time.sleep(1.5)
        print("dialog still open:", bool(s.dialogs()))
        return
    s.place_dialog(200, 200)
    s.click(155, 160, duration=0)  # Home in the dialog's sidebar
    time.sleep(0.8)
    s.key("ctrl+l")
    time.sleep(0.4)
    for part in path.strip("/").split("/"):
        s.type("/" + part, cps=6)
        time.sleep(0.7)
    s.key("Return")
    time.sleep(1.2)
    if folder and s.dialogs():
        s.click(1083, 677, duration=0)  # Open
        time.sleep(1.2)
    print("dialog still open:", bool(s.dialogs()))


OBSIDIAN = "/tmp/Vaults/My Obsidian Vault"


def make_obsidian_vault():
    shutil.rmtree(OBSIDIAN, ignore_errors=True)
    shutil.copytree(common.KESSARI, OBSIDIAN, ignore=shutil.ignore_patterns(".liber"))
    os.makedirs(f"{OBSIDIAN}/.obsidian")
    with open(f"{OBSIDIAN}/.obsidian/app.json", "w") as f:
        json.dump(
            {"attachmentFolderPath": "attachments", "newLinkFormat": "shortest",
             "useMarkdownLinks": False}, f,
        )


def obsidian(s):
    """Open an Obsidian vault as it is: its syntax, and its own settings
    followed (the system dialog is cut out: it shows the user's own folders)."""
    make_obsidian_vault()
    s.start()
    time.sleep(2.5)
    s.move(700, 420, 0)
    rec(s, "obsidian-a")
    time.sleep(1.2)
    s.move(120, 413, 1.4)  # Open an Obsidian vault
    time.sleep(1.2)
    s.stop_recording()
    s.click(duration=0)
    time.sleep(2.0)
    pick(s, OBSIDIAN, folder=True)
    s.move(700, 420, 0)
    rec(s, "obsidian-b")  # the vault, opened as it is
    time.sleep(2.0)
    s.click(24, 329, duration=0.7)  # World
    time.sleep(0.7)
    s.click(40, 469, duration=0.6)  # Places
    time.sleep(1.0)
    snap(s, "obs-tree")
    s.stop_recording()
    s.scroll(1, 120, 450)
    time.sleep(0.8)
    s.click(120, 594, duration=0)  # The Salt Road
    time.sleep(2.5)
    s.click(225, 94, duration=0)  # hide the sidebar
    time.sleep(1.0)
    s.scroll(3, 700, 500)
    time.sleep(1.2)
    s.move(1000, 600, 0)
    rec(s, "obsidian-c")  # wikilinks and an embed, rendered
    time.sleep(3.5)
    s.scroll(5, 1000, 600)
    time.sleep(3.0)
    snap(s, "obs-page")
    s.click(97, 14, duration=0.8)  # Liber Linteum menu
    time.sleep(0.6)
    s.click(73, 83, duration=0.5)  # Settings…
    time.sleep(1.2)
    s.click(175, 529, duration=0.7)  # This vault
    time.sleep(4.0)
    snap(s, "obs-settings")
    s.stop_recording()


def notion(s):
    """Import the sample Notion export; a database becomes a table."""
    shutil.copy(f"{common.REPO}/examples/notion-sample-export.zip", "/tmp/Vaults/Notion export.zip")
    for q in "'’":  # macOS turns the typed ' into a curly one
        shutil.rmtree(f"/tmp/Vaults/Dela{q}s Caravan Notes", ignore_errors=True)
    s.start()
    time.sleep(2.5)
    s.click(112, 477, duration=0)  # Import from Notion…
    time.sleep(1.5)
    s.click(870, 320, duration=0)  # Choose export…
    time.sleep(2.0)
    pick(s, "/tmp/Vaults/Notion export.zip", folder=False)
    s.click(866, 394, duration=0)  # Choose location…
    time.sleep(2.0)
    pick(s, "/tmp/Vaults", folder=True)
    s.move(700, 640, 0)
    time.sleep(0.8)
    rec(s, "notion")
    time.sleep(0.6)
    s.click(575, 466, duration=0.8)  # Vault name
    s.key("ctrl+a")
    s.type("Dela's Caravan Notes", cps=16)
    time.sleep(0.4)
    s.click(903, 560, duration=0.7)  # Import
    time.sleep(3.5)
    s.click(24, 258, duration=0.8)  # expand the import's folder
    time.sleep(0.9)
    s.click(112, 328, duration=0.7)  # Salt Road Ledger
    time.sleep(1.4)
    s.move(700, 500, 0.6)
    time.sleep(2.0)
    snap(s, "notion-ledger")
    s.stop_recording()


PASS = "moons over the salt road"
GROUP_A, GROUP_B, DONE = (575, 360), (575, 432), (758, 518)
TRASHED = os.path.expanduser("~/.Trash/The Moons of Kessari (unencrypted originals)")


def asked_groups(s):
    """The two group numbers the dialog asks for, read off the screen (Vision OCR)."""
    import re

    import Vision
    from Foundation import NSURL

    path = s.shot(f"{common.SHOTS}/enc-groups.png")
    req = Vision.VNRecognizeTextRequest.alloc().init()
    Vision.VNImageRequestHandler.alloc().initWithURL_options_(
        NSURL.fileURLWithPath_(path), None
    ).performRequests_error_([req], None)
    text = " ".join(r.topCandidates_(1)[0].string() for r in req.results())
    m = re.search(r"group (\d+) and group (\d+)", text)
    if not m:
        raise RuntimeError("no group numbers on screen: " + text)
    return int(m[1]), int(m[2])


def encryption(s):
    """Encrypt the open vault from start to end, then lock and unlock it.
    macOS: one take (the groups are read by OCR, encrypting takes seconds)."""
    from AppKit import NSPasteboard, NSPasteboardTypeString

    board = NSPasteboard.generalPasteboard()
    saved = board.stringForType_(NSPasteboardTypeString)  # Copy below overwrites it
    open_vault(s)
    s.click(120, 256, duration=0)  # a chapter, so the vault shows a page
    time.sleep(2.0)
    s.scroll(3, 700, 500)
    time.sleep(1.0)
    s.move(700, 500, 0)
    try:
        rec(s, "encryption-a")
        time.sleep(1.0)
        s.click(218, 14, duration=0.9)  # Vault menu
        time.sleep(0.8)
        s.click(300, 131, duration=0.7)  # Encrypt "…"
        time.sleep(2.6)
        snap(s, "enc-intro")
        s.click(745, 514, duration=0.8)  # Continue
        time.sleep(2.4)
        snap(s, "enc-copy")
        s.click(685, 390, duration=0.8)  # Don't keep a copy
        time.sleep(0.5)
        s.click(700, 488, duration=0.7)  # Choose a passphrase…
        time.sleep(1.5)
        s.type(PASS, cps=14)
        s.key("Tab")
        s.type(PASS, cps=22)
        time.sleep(0.6)
        snap(s, "enc-pass")
        s.click(745, 516, duration=0.7)  # Continue
        time.sleep(6.0)
        snap(s, "enc-key")
        s.click(643, 488, duration=0.7)  # Copy
        time.sleep(1.2)
        key = s.clipboard()
        s.click(737, 488, duration=0.7)  # I've saved it
        time.sleep(2.0)
        snap(s, "enc-confirm")
        groups = key.split("-")[1:]
        ga, gb = asked_groups(s)
        print("groups", ga, gb)
        s.click(*GROUP_A, duration=0.6)
        s.type(groups[ga - 1], cps=9)
        s.click(*GROUP_B, duration=0.5)
        s.type(groups[gb - 1], cps=9)
        time.sleep(0.6)
        s.click(*DONE, duration=0.6)  # Done: encrypting starts
        time.sleep(4.0)
        snap(s, "enc-done")
        s.click(757, 452, duration=0.8)  # Open
        time.sleep(3.0)
        s.click(110, 222, duration=0.8)  # the chapter, from the encrypted vault
        time.sleep(2.0)
        s.click(218, 14, duration=0.9)  # Vault menu
        time.sleep(0.7)
        s.click(235, 179, duration=0.6)  # Lock Vault
        time.sleep(2.0)
        snap(s, "enc-locked")
        s.type(PASS, cps=12)
        time.sleep(0.4)
        s.key("Return")
        time.sleep(2.6)
        s.click(110, 222, duration=0.8)  # the chapter again
        time.sleep(1.4)
        s.move(700, 500, 0.5)
        s.scroll(3)
        time.sleep(1.6)
        snap(s, "enc-unlocked")
        s.stop_recording()
    finally:
        board.clearContents()
        if saved is not None:
            board.setString_forType_(saved, NSPasteboardTypeString)
        shutil.rmtree(TRASHED, ignore_errors=True)  # the throwaway copy's originals


SCENES = {
    "hero": hero,
    "obsidian": obsidian,
    "notion": notion,
    "global-view": global_view,
    "atoms": atoms,
    "editor": editor,
    "maths": maths,
    "drag-drop": drag_drop,
    "voice": voice,
    "search": search,
    "encryption": encryption,
    "sample-vault": sample_vault,
}

# What to keep of each recorded part, in order: (part, start, length or None
# for the rest, zoom keys or None). Zoom keys are (seconds into the kept
# piece, centre x, centre y, scale) in logical pixels; see zoom.py.
EDITS = {
    "hero": [("hero", 0.4, None, None)],
    "sample-vault": [("sample-vault", 0.5, None, None)],
    "global-view": [("global-view", 0.5, None, None)],
    "atoms": [("atoms", 0.4, None, None)],
    "editor": [("editor", 0.4, None, None)],
    "maths": [("maths", 0.4, None, None)],
    "drag-drop": [("drag-drop", 0.4, None, None)],
    "voice": [("voice", 0.4, None, None)],
    "search": [("search", 0.3, None, None)],
    "notion": [("notion", 0.4, None, None)],
    "obsidian": [
        # The welcome screen, closing in on "Open an Obsidian vault".
        ("obsidian-a", 0.3, None, [(0.8, 576, 360, 1.0), (2.2, 165, 420, 2.4)]),
        ("obsidian-b", 0.2, None, None),
        # Wikilinks and an embed as Obsidian wrote them; then its own settings, followed.
        ("obsidian-c", 0.2, None, [(0.3, 576, 360, 1.0), (1.0, 595, 540, 1.6), (3.0, 595, 540, 1.6),
                                   (3.6, 576, 360, 1.0), (12.6, 576, 360, 1.0),
                                   (13.4, 690, 440, 1.6)]),
    ],
    "encryption": [
        # One take on macOS, less most of "Setting up encryption…" and an empty
        # page after Open; the recovery key close up.
        ("encryption-a", 0.5, 21.5, None),
        ("encryption-a", 25.3, 17.0, [(1.5, 576, 360, 1.0), (2.1, 576, 414, 1.9),
                                      (3.6, 576, 414, 1.9), (4.2, 576, 360, 1.0)]),
        ("encryption-a", 46.0, None, None),
    ],
}

# Posters: (seconds into the finished clip, WebP quality), under 150 KB.
POSTERS = {
    "hero": (0.2, 50), "sample-vault": (10.5, 72), "global-view": (0.2, 72),
    "obsidian": (8.0, 45), "notion": (13.0, 72), "encryption": (24.0, 45),
    "search": (6.5, 72), "editor": (9.0, 45), "atoms": (6.0, 60), "maths": (6.0, 45),
    "drag-drop": (4.0, 45), "voice": (6.0, 45),
}


def _ff(*args):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


def build(slug):
    """Cuts, zooms and joins a slug's parts into <clips>/<slug>.final.mkv."""
    from zoom import zoom

    clips = common.CLIPS
    pieces = []
    for i, (part, start, length, keys) in enumerate(EDITS[slug]):
        src = f"{clips}/{part}.mkv"
        cut = f"{clips}/.{slug}-{i}.mkv"
        trim = ["-ss", str(start)] + (["-t", str(length)] if length else [])
        _ff(*trim, "-i", src, "-an", "-c:v", "libx264rgb", "-crf", "0", "-preset", "ultrafast",
            "-r", "30", cut)
        if keys:
            zoomed = f"{clips}/.{slug}-{i}z.mkv"
            zoom(cut, zoomed, keys)
            cut = zoomed
        pieces.append(cut)
    final = f"{clips}/{slug}.final.mkv"
    if len(pieces) == 1:
        shutil.copy(pieces[0], final)
    else:
        listing = f"{clips}/.{slug}.txt"
        with open(listing, "w") as f:
            f.writelines(f"file '{p}'\n" for p in pieces)
        _ff("-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", final)
    return final


def encode_all(out_dir, slugs):
    from cap import encode, poster

    for slug in slugs:
        if not all(os.path.exists(f"{common.CLIPS}/{p[0]}.mkv") for p in EDITS[slug]):
            print("not recorded:", slug)
            continue
        final = build(slug)
        encode(final, slug, out_dir)
        at, quality = POSTERS[slug]
        poster(final, at, quality, f"{out_dir}/{slug}.poster.webp")
        print("encoded", slug)


if __name__ == "__main__":
    name, rest = sys.argv[1], sys.argv[2:]
    if name == "encode":
        encode_all(f"{common.REPO}/site/media", rest or list(EDITS))
        sys.exit()
    for scene in SCENES if name == "all" else [name, *rest]:
        if scene == "voice" and sys.platform == "darwin":
            # No stand-in mic on macOS: the app hears the real one (nothing of it is kept).
            s = common.session()
            try:
                voice(s, type("NoMic", (), {"speak": lambda self: None})())
            finally:
                s.stop()
            continue
        if scene == "voice":
            import fakemic

            with fakemic.FakeMic() as mic:
                s = common.session(files=mic.files, env=mic.env)
                try:
                    voice(s, mic)
                finally:
                    s.stop()
            continue
        s = common.session()
        try:
            SCENES[scene](s)
        finally:
            s.stop()
