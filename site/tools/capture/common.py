"""Shared setup for the capture scenes: a fresh copy of the sample vault and
settings for a clean, light, English app."""

import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cap import WORK, Session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
BINARY = os.environ.get("LIBER_BINARY", f"{REPO}/target/release/liber-desktop")
VAULTS = "/tmp/Vaults"
KESSARI = os.path.join(VAULTS, "The Moons of Kessari")
SHOTS = os.path.join(WORK, "shots")
CLIPS = os.path.join(WORK, "clips")


def fresh_vault():
    os.makedirs(VAULTS, exist_ok=True)
    if os.path.isdir(KESSARI):
        shutil.rmtree(KESSARI)
    shutil.copytree(f"{REPO}/examples/the-moons-of-kessari", KESSARI)
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(CLIPS, exist_ok=True)


def settings(**over):
    with open(os.path.join(HERE, "settings.json")) as f:
        s = json.load(f)  # light, English, saffron, spell check off
    s["recentVaults"] = [
        {"path": KESSARI, "name": "The Moons of Kessari", "openedAt": "2026-10-21T22:00:00Z"}
    ]
    s.update(over)
    return s


def session(**over):
    fresh_vault()
    return Session(BINARY, settings(**over))
