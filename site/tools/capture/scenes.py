"""Record one scene: `python scenes.py <name>`; frames for review land in
work/shots/<name>-*.png, the lossless clip in work/clips/<name>.mkv."""

import sys
import time

import common
from PIL import Image


def snap(s, name):
    p = s.shot(f"{common.SHOTS}/{name}.png")
    Image.open(p).resize((1152, 720)).save(f"{common.SHOTS}/{name}-s.png")


def open_vault(s):
    s.start()
    time.sleep(2.5)
    s.click(740, 147, duration=0)  # The Moons of Kessari in Recent
    time.sleep(4)


def hero(s):
    open_vault(s)
    s.key("ctrl+2")
    time.sleep(3)
    s.move(1060, 420, 0)  # rest the pointer on empty canvas
    time.sleep(0.5)
    s.record(f"{common.CLIPS}/hero.mkv")
    time.sleep(1.2)
    s.click(905, 300, duration=1.1)  # The Story: drill in
    time.sleep(3.2)
    snap(s, "hero-in")
    s.move(700, 450, 1.2)
    time.sleep(1.4)
    s.click(296, 67, duration=1.0)  # breadcrumb: Vault
    time.sleep(2.2)
    s.move(1060, 420, 1.0)
    time.sleep(0.6)
    s.stop_recording()
    snap(s, "hero-end")


def sample_vault(s):
    """From Recent into the vault, its Global View, then into World."""
    s.start()
    time.sleep(2.5)
    s.move(900, 500, 0)
    s.record(f"{common.CLIPS}/sample-vault.mkv")
    time.sleep(0.8)
    s.click(740, 147, duration=1.0)  # open from Recent
    time.sleep(2.2)
    s.key("ctrl+2")
    time.sleep(2.4)
    s.click(490, 560, duration=1.0)  # World
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
    s.record(f"{common.CLIPS}/global-view.mkv")
    time.sleep(0.8)
    s.click(490, 560, duration=1.0)  # World
    time.sleep(2.2)
    s.click(562, 455, duration=1.0)  # Places
    time.sleep(2.4)
    snap(s, "gv-places")
    s.click(361, 67, duration=0.9)  # breadcrumb: World
    time.sleep(1.8)
    s.move(1060, 420, 0.8)
    s.stop_recording()


def editor(s):
    """A chapter in Live Preview: write a line with a highlight and a link."""
    open_vault(s)
    s.click(120, 231, duration=0)  # Favorites: chapter 01
    time.sleep(2.5)
    s.scroll(8, 600, 520)
    time.sleep(1.0)
    s.move(900, 480, 0)
    s.record(f"{common.CLIPS}/editor.mkv")
    time.sleep(0.6)
    s.click(766, 540, duration=0.9)  # end of "mending its selvedge."
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


def search(s):
    """Search the vault, then narrow it with a tag."""
    open_vault(s)
    s.move(700, 400, 0)
    s.record(f"{common.CLIPS}/search.mkv")
    time.sleep(0.6)
    s.key("ctrl+shift+f")
    time.sleep(0.9)
    s.type("linen", cps=7)
    time.sleep(1.6)
    s.click(672, 181, duration=0.9)  # #linen-keepers
    time.sleep(2.2)
    snap(s, "search-tag")
    s.stop_recording()




def pick(s, path, folder):
    """Drive a GTK file dialog: browse mode (Home), type the path, accept."""
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




def make_obsidian_vault():
    import os, shutil, json
    v = "/tmp/Vaults/My Obsidian Vault"
    shutil.rmtree(v, ignore_errors=True)
    shutil.copytree(common.KESSARI, v, ignore=shutil.ignore_patterns(".liber"))
    os.makedirs(f"{v}/.obsidian")
    with open(f"{v}/.obsidian/app.json", "w") as f:
        json.dump({"attachmentFolderPath": "attachments"}, f)
    return v


def obsidian(s):
    """Open an Obsidian vault as it is (the system dialog is cut out)."""
    v = make_obsidian_vault()
    s.start()
    time.sleep(2.5)
    s.move(700, 420, 0)
    s.record(f"{common.CLIPS}/obsidian-a.mkv")
    time.sleep(0.7)
    s.move(120, 386, 1.0)  # Open an Obsidian vault
    time.sleep(0.3)
    s.stop_recording()
    s.click(duration=0)
    time.sleep(2.0)
    pick(s, v, folder=True)
    s.move(700, 420, 0)
    s.record(f"{common.CLIPS}/obsidian-b.mkv")
    time.sleep(2.2)
    snap(s, "obs-final-tree")
    s.click(24, 269, duration=0.9)  # expand The Story
    time.sleep(1.0)
    s.click(130, 304, duration=0.8)  # its first chapter
    time.sleep(1.6)
    s.move(700, 500, 0.6)
    s.scroll(7)
    time.sleep(1.8)
    snap(s, "obs-final-page")
    s.stop_recording()


def notion(s):
    """Import the sample Notion export; a database becomes a table."""
    import shutil
    shutil.copy(f"{common.REPO}/examples/notion-sample-export.zip", "/tmp/Vaults/Notion export.zip")
    shutil.rmtree("/tmp/Vaults/Dela's Caravan Notes", ignore_errors=True)
    s.start()
    time.sleep(2.5)
    s.click(115, 450, duration=0)  # Import from Notion…
    time.sleep(1.5)
    s.click(870, 288, duration=0)
    time.sleep(2.0)
    pick(s, "/tmp/Vaults/Notion export.zip", folder=False)
    s.click(865, 362, duration=0)
    time.sleep(2.0)
    pick(s, "/tmp/Vaults", folder=True)
    s.move(700, 600, 0)
    time.sleep(0.8)
    s.record(f"{common.CLIPS}/notion.mkv")
    time.sleep(0.6)
    s.click(575, 434, duration=0.8)  # Vault name
    s.key("ctrl+a")
    s.type("Dela's Caravan Notes", cps=16)
    time.sleep(0.4)
    s.click(902, 528, duration=0.7)  # Import
    time.sleep(3.5)
    s.click(24, 164, duration=0.8)  # expand the import's folder
    time.sleep(0.9)
    s.click(112, 234, duration=0.7)  # Salt Road Ledger
    time.sleep(1.4)
    s.move(700, 500, 0.6)
    s.scroll(1)
    time.sleep(2.0)
    snap(s, "notion-ledger")
    s.stop_recording()


PASS = "moons over the salt road"


def confirm_groups(s, key):
    """Types the two groups the dialog asked for: tries pairs until Done
    darkens (the numbers are only drawn, and there is no OCR here)."""
    groups = key.split("-")[1:]
    for a in range(len(groups)):
        for b in range(a + 1, len(groups)):
            s.click(575, 329, duration=0)
            s.key("ctrl+a")
            s.type(groups[a], cps=80)
            s.click(575, 401, duration=0)
            s.key("ctrl+a")
            s.type(groups[b], cps=80)
            time.sleep(0.15)
            if sum(s.pixel(758, 486)) < 400:
                print("groups", a + 1, b + 1)
                return
    raise RuntimeError("no pair of groups turned Done on")




def encrypt_off_camera(s):
    """Encrypts the open sample vault through the app's own dialog."""
    s.click(183, 18, duration=0)  # Vault menu
    time.sleep(0.8)
    s.click(300, 125, duration=0)  # Encrypt "…"
    time.sleep(1.5)
    s.click(744, 482, duration=0)  # Continue
    time.sleep(2.0)
    s.click(685, 350, duration=0)  # Don't keep a copy
    time.sleep(0.4)
    s.click(700, 445, duration=0)  # Choose a passphrase…
    time.sleep(1.5)
    s.type(PASS, cps=40)
    s.key("Tab")
    s.type(PASS, cps=40)
    time.sleep(0.4)
    s.click(744, 484, duration=0)  # Continue
    time.sleep(4.0)
    s.click(643, 455, duration=0)  # Copy
    time.sleep(0.6)
    key = s.clipboard()
    s.click(737, 455, duration=0)  # I've saved it
    time.sleep(1.5)
    confirm_groups(s, key)
    s.click(758, 486, duration=0)  # Done
    time.sleep(15.0)
    s.click(757, 420, duration=0)  # Open
    time.sleep(4.0)


def encryption(s):
    """Lock the vault, then unlock it with the passphrase."""
    open_vault(s)
    encrypt_off_camera(s)
    s.click(120, 231, duration=0)  # a chapter, so the vault shows a page
    time.sleep(2.0)
    s.scroll(7, 700, 500)
    time.sleep(1.0)
    s.move(700, 500, 0)
    s.record(f"{common.CLIPS}/encryption.mkv")
    time.sleep(0.8)
    s.click(183, 18, duration=0.9)  # Vault menu
    time.sleep(0.7)
    s.click(225, 183, duration=0.6)  # Lock vault
    time.sleep(2.0)
    snap(s, "enc-locked")
    s.type(PASS, cps=12)
    time.sleep(0.4)
    s.key("Return")
    time.sleep(2.6)
    s.click(120, 231, duration=0.8)  # the chapter again
    time.sleep(1.4)
    s.move(700, 500, 0.5)
    s.scroll(7)
    time.sleep(1.6)
    snap(s, "enc-unlocked")
    s.stop_recording()


SCENES = {
    "encryption": encryption,
    "obsidian": obsidian,
    "notion": notion,
    "hero": hero,
    "sample-vault": sample_vault,
    "global-view": global_view,
    "editor": editor,
    "search": search,
}

# Trims for the site (start, length in seconds) per clip.
TRIMS = {
    "hero": (0.4, 10.5), "sample-vault": (0.5, 11.0), "global-view": (0.5, 11.5),
    "editor": (0.4, 11.0), "search": (0.3, 7.4), "obsidian": (0.3, 12.0),
    "notion": (0.4, 13.5), "encryption": (0.5, 15.5),
}


# Posters: a representative moment (clip, seconds, WebP quality), under 150 KB.
POSTERS = {
    "sample-vault": ("sample-vault", 10.5, 72), "obsidian": ("obsidian-b", 10.5, 45),
    "notion": ("notion", 13.0, 72), "encryption": ("encryption", 3.4, 45),
    "search": ("search", 6.5, 72), "editor": ("editor", 9.0, 45),
}


def encode_all(out_dir):
    """The site's files (webm, mp4, poster) for every recorded clip."""
    import os
    import subprocess
    from cap import encode

    clips = common.CLIPS
    a, b = f"{clips}/obsidian-a.mkv", f"{clips}/obsidian-b.mkv"
    if os.path.exists(a) and os.path.exists(b):
        with open(f"{clips}/obsidian.txt", "w") as f:
            f.write(f"file '{a}'\nfile '{b}'\n")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                        "-i", f"{clips}/obsidian.txt", "-c", "copy", f"{clips}/obsidian.mkv"], check=True)
    for slug, (start, length) in TRIMS.items():
        if os.path.exists(f"{clips}/{slug}.mkv"):
            encode(f"{clips}/{slug}.mkv", slug, out_dir, start=start, length=length)
            if slug in POSTERS:
                src, at, quality = POSTERS[slug]
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(at), "-i",
                                f"{clips}/{src}.mkv", "-frames:v", "1", "-vf", "scale=2304:-2",
                                "-c:v", "libwebp", "-quality", str(quality),
                                f"{out_dir}/{slug}.poster.webp"], check=True)
            print("encoded", slug)


if __name__ == "__main__":
    name = sys.argv[1]
    if name == "encode":
        encode_all(sys.argv[2] if len(sys.argv) > 2 else f"{common.REPO}/site/media")
        sys.exit()
    for scene in SCENES if name == "all" else [name]:
        s = common.session()
        try:
            SCENES[scene](s)
        finally:
            s.stop()
