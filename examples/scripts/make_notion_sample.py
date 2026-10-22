#!/usr/bin/env python3
"""Build examples/notion-sample-export.zip: a sample Notion "Markdown & CSV"
export for trying File -> Import from Notion in Liber Linteum.

It is the Notion workspace of Dela Fenn, quartermaster of a Salt Road caravan
on Kessari (the world of the sample vault). The export is laid out the way
Notion lays one out, in the shapes `crates/liber-import` understands:

- every page and database named `<Title> <32 hex id>`;
- a page's children (sub-pages, databases, images) in a folder of the same
  name beside its `.md` file;
- databases as `<Name> <id>.csv` (the view's columns) plus `<Name> <id>_all.csv`
  (every column), both UTF-8 with a BOM, and a folder of one page per row whose
  property lines (`Key: value`) sit under the title;
- relations in CSVs as `Title (relative%20path.md)`;
- links between pages as relative, percent-encoded Markdown links;
- callouts as `<aside>` and toggles as `<details><summary>`;
- the whole tree zipped as `Export-<uuid>-Part-1.zip`, inside an outer zip,
  as Notion's download does.

Standard library only; the output is byte-for-byte reproducible.

    python3 examples/scripts/make_notion_sample.py [--out PATH] [--workdir DIR]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import math
import posixpath
import shutil
import struct
import tempfile
import zipfile
import zlib
from pathlib import Path
from urllib.parse import quote

# A fixed timestamp for every zip entry, so the zip is reproducible.
STAMP = (2026, 10, 21, 9, 30, 0)


def nid(key: str) -> str:
    """A stable 32-hex Notion id for `key`."""
    return hashlib.md5(f"kessari-notion:{key}".encode()).hexdigest()


def named(title: str, key: str | None = None) -> str:
    return f"{title} {nid(key or title)}"


def href(source: str, target: str) -> str:
    """`target` relative to the folder of `source`, percent-encoded as Notion
    writes it (encodeURIComponent, `/` kept)."""
    rel = posixpath.relpath(target, posixpath.dirname(source) or ".")
    return quote(rel, safe="/-_.!~*'")


# --------------------------------------------------------------------------
# Paths

ROOT = "Dela's Caravan Notes"
ROOT_MD = f"{named(ROOT)}.md"
ROOT_DIR = named(ROOT)
STORM_MD = f"{ROOT_DIR}/{named('Storm Protocol')}.md"
STORM_DIR = f"{ROOT_DIR}/{named('Storm Protocol')}"
MOONS_MD = f"{STORM_DIR}/{named('Reading the Moons')}.md"
SUPPLIES_MD = f"{named('Supplies')}.md"
MAP_PNG = f"{ROOT_DIR}/salt-road-map.png"

LEDGER = named("Salt Road Ledger")
LEDGER_CSV = f"{ROOT_DIR}/{LEDGER}.csv"
LEDGER_ALL = f"{ROOT_DIR}/{LEDGER}_all.csv"
LEDGER_DIR = f"{ROOT_DIR}/{LEDGER}"

ROSTER = named("Caravan Roster")
ROSTER_CSV = f"{ROOT_DIR}/{ROSTER}.csv"
ROSTER_ALL = f"{ROOT_DIR}/{ROSTER}_all.csv"
ROSTER_DIR = f"{ROOT_DIR}/{ROSTER}"


def person_md(name: str) -> str:
    return f"{ROSTER_DIR}/{named(name, 'person:' + name)}.md"


def leg_md(title: str) -> str:
    return f"{LEDGER_DIR}/{named(title, 'leg:' + title)}.md"


def link(source: str, text: str, target: str) -> str:
    return f"[{text}]({href(source, target)})"


# --------------------------------------------------------------------------
# Databases

ROSTER_COLS = ["Name", "Role", "House", "Ration (drams/day)", "Skills", "Bonded", "Notes"]
ROSTER_VIEW = ["Name", "Role", "House", "Ration (drams/day)"]
PEOPLE = [
    {
        "Name": "Dela Fenn",
        "Role": "Quartermaster",
        "House": "House Varn",
        "Ration (drams/day)": "3",
        "Skills": "ledgers, water-reading, haggling",
        "Bonded": "Yes",
        "Notes": "Keeps this workspace. Writes everything down twice: once here, once on linen.",
        "body": lambda src: (
            "Contracted to House Varn for three crossings; this is the second.\n\n"
            "If you are reading this because something has gone wrong, start with the "
            f"{link(src, 'Storm Protocol', STORM_MD)} and then count the casks against "
            f"{link(src, 'Supplies', SUPPLIES_MD)}.\n"
        ),
    },
    {
        "Name": "Oren Vask",
        "Role": "Caravan master",
        "House": "House Varn",
        "Ration (drams/day)": "3.5",
        "Skills": "navigation, star-reading",
        "Bonded": "Yes",
        "Notes": "Twenty-two crossings of the Salt Road and still refuses to travel during the Closing.",
        "body": lambda src: (
            "Oren reads the road by the moons. He sets the pace, and he decides when we wait. "
            "Nobody argues with him twice.\n\n"
            "He keeps the House Varn seal on a cord around his neck; without it the Salt Courts "
            "will not let us draw from the Well of Osk.\n"
        ),
    },
    {
        "Name": "Tamsin Ure",
        "Role": "Outrider",
        "House": "House Sesk",
        "Ration (drams/day)": "3",
        "Skills": "scouting, sand-signals, knots",
        "Bonded": "No",
        "Notes": "On loan from House Sesk until the Courts settle their quarrel with Varn.",
        "body": lambda src: (
            "Rides a day ahead on the fast strider and mirrors back what she sees: one flash for "
            "clear, three for dust, a long glare for turn back.\n"
        ),
    },
    {
        "Name": "Ysra Kel",
        "Role": "Linen-Keeper",
        "House": "Unsworn",
        "Ration (drams/day)": "3",
        "Skills": "archiving, water law",
        "Bonded": "No",
        "Notes": "Records every water debt we take on. Her linen is the only ledger the Salt Courts accept.",
        "body": lambda src: (
            "The Linen-Keepers write on linen because paper cracks in the dry. Ysra carries the "
            "caravan's debt-cloth in a waxed case and will not let anyone else touch it.\n\n"
            "Every dram we buy on credit at the Well of Osk is stitched onto her cloth before we "
            f"leave the Courts. See {link(src, 'Leg 5', leg_md(LEGS[4]['Leg']))} for this crossing's entries.\n"
        ),
    },
    {
        "Name": "Brannoc Hale",
        "Role": "Beastmaster",
        "House": "House Varn",
        "Ration (drams/day)": "4",
        "Skills": "dune-oxen, harness repair",
        "Bonded": "Yes",
        "Notes": "Drinks the most and earns it: twelve dune-oxen and two striders are his to keep alive.",
    },
    {
        "Name": "Pell Marrow",
        "Role": "Cook and still-keeper",
        "House": "Unsworn",
        "Ration (drams/day)": "2.5",
        "Skills": "cooking, condensers",
        "Bonded": "No",
        "Notes": "Runs the night condensers. Pulls back two or three drams a night when the air is kind.",
    },
    {
        "Name": "Ash Orrin",
        "Role": "Apprentice glasswright",
        "House": "Unsworn",
        "Ration (drams/day)": "2",
        "Skills": "glasswork",
        "Bonded": "No",
        "Notes": "Glassreach-born. Mends cracked lenses and cask seals with a hand-torch and a lot of patience.",
        "body": lambda src: (
            "Ash fused the new seal on cask nineteen at Thane's Gate. It has not wept a drop since.\n"
        ),
    },
]

LEDGER_COLS = ["Leg", "Date", "From", "To", "Water (drams)", "Status", "Lead", "Notes"]
LEDGER_VIEW = ["Leg", "Date", "From", "To", "Water (drams)", "Status"]
LEGS = [
    {
        "Leg": "Leg 1 — Glassreach to the Mirror Flats",
        "Date": "October 2, 2026",
        "From": "Glassreach",
        "To": "Mirror Flats",
        "Water (drams)": "180",
        "Status": "Done",
        "Lead": "Oren Vask",
        "Notes": "Left at dusk to spare the beasts the worst of the heat on the glass.",
        "body": lambda src: (
            "Forty-two casks loaded at the Glass Gate, forty drams each, every seal checked by Ash "
            "before the wardens let us through.\n\n"
            "The Mirror Flats are an old glass plain, fused smooth by something nobody in "
            "Glassreach will name. By day they throw the sun back up at you; by night they are "
            "the easiest road on Kessari.\n"
        ),
    },
    {
        "Leg": "Leg 2 — Mirror Flats to Cinder Wells",
        "Date": "October 5, 2026",
        "From": "Mirror Flats",
        "To": "Cinder Wells",
        "Water (drams)": "240",
        "Status": "Done",
        "Lead": "Tamsin Ure",
        "Notes": "Cinder Wells were shallow this year; we drew only what the toll allowed.",
    },
    {
        "Leg": "Leg 3 — Cinder Wells to Thane's Gate",
        "Date": "October 9, 2026",
        "From": "Cinder Wells",
        "To": "Thane's Gate",
        "Water (drams)": "300",
        "Status": "Done",
        "Lead": "Oren Vask",
        "Notes": "The climb through the pass took a day longer than the old chart says it should.",
        "body": lambda src: (
            "Cask nineteen started weeping on the second night of the climb. "
            f"{link(src, 'Ash Orrin', person_md('Ash Orrin'))} re-fused the seal at the Gate; "
            "we lost about six drams.\n"
        ),
    },
    {
        "Leg": "Leg 4 — Thane's Gate to Dunmark",
        "Date": "October 13, 2026",
        "From": "Thane's Gate",
        "To": "Dunmark",
        "Water (drams)": "260",
        "Status": "Done",
        "Lead": "Tamsin Ure",
        "Notes": "Bought salt for the dune-oxen at Dunmark market; paid in glass lenses, not water.",
    },
    {
        "Leg": "Leg 5 — Dunmark to the Salt Courts",
        "Date": "October 16, 2026",
        "From": "Dunmark",
        "To": "Salt Courts",
        "Water (drams)": "220",
        "Status": "Done",
        "Lead": "Oren Vask",
        "Notes": "Sold the glass, bought four casks at the Well of Osk on House Varn's credit.",
        "body": lambda src: (
            "The Salt Courts were in session when we arrived, all seven houses at the long table. "
            "House Varn's factor bought the whole glass consignment and let us draw four casks "
            "from the Well of Osk against next season's crossing.\n\n"
            f"{link(src, 'Ysra Kel', person_md('Ysra Kel'))} stitched the debt onto the linen "
            "before the factor's ink was dry: 160 drams, owed to House Varn, due at the next Closing.\n"
        ),
    },
    {
        "Leg": "Leg 6 — Salt Courts to Dunmark",
        "Date": "October 19, 2026",
        "From": "Salt Courts",
        "To": "Dunmark",
        "Water (drams)": "420",
        "Status": "Delayed",
        "Lead": "Oren Vask",
        "Notes": "Held at the Courts by a dust wall rolling in from the south; leaving when it clears.",
        "body": lambda src: (
            "Tamsin saw the dust wall from the Court roofs on the morning we meant to leave. "
            f"Oren called it under the {link(src, 'Storm Protocol', STORM_MD)} and we stayed.\n\n"
            "The extra drams on this leg are the days spent waiting; the Courts charge for every "
            "one of them.\n"
        ),
    },
    {
        "Leg": "Leg 7 — Dunmark to Thane's Gate",
        "Date": "October 23, 2026",
        "From": "Dunmark",
        "To": "Thane's Gate",
        "Water (drams)": "280",
        "Status": "Planned",
        "Lead": "Tamsin Ure",
        "Notes": "Climb loaded, so budget an extra day and an extra cask for the beasts.",
    },
    {
        "Leg": "Leg 8 — Thane's Gate to Cinder Wells",
        "Date": "October 27, 2026",
        "From": "Thane's Gate",
        "To": "Cinder Wells",
        "Water (drams)": "300",
        "Status": "Planned",
        "Lead": "Oren Vask",
        "Notes": "Both moons rise together on the 28th. Be out of the pass before the Closing begins.",
        "body": lambda src: (
            "Ilu and Thane rise together on the night of the 28th. Oren will not be in the pass "
            "for it, and neither will I. If the dust delay at the Courts pushes us later, we wait "
            "at the Gate instead.\n\n"
            f"See {link(src, 'Reading the Moons', MOONS_MD)} for why.\n"
        ),
    },
    {
        "Leg": "Leg 9 — Cinder Wells to the Mirror Flats",
        "Date": "October 31, 2026",
        "From": "Cinder Wells",
        "To": "Mirror Flats",
        "Water (drams)": "240",
        "Status": "Planned",
        "Lead": "Tamsin Ure",
        "Notes": "Refill at Cinder Wells only if the toll-keeper honours the House Varn seal.",
    },
    {
        "Leg": "Leg 10 — Mirror Flats to Glassreach",
        "Date": "November 3, 2026",
        "From": "Mirror Flats",
        "To": "Glassreach",
        "Water (drams)": "180",
        "Status": "Planned",
        "Lead": "Oren Vask",
        "Notes": "Settle the linen debts with the Keepers' house in Glassreach before we unload.",
    },
]


def relation(csv_or_page: str, name: str) -> str:
    """A Notion relation cell or property: `Title (relative%20path.md)`."""
    return f"{name} ({href(csv_or_page, person_md(name))})"


def csv_text(cols: list[str], rows: list[dict], source: str) -> str:
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(cols)
    for row in rows:
        values = []
        for c in cols:
            v = row[c]
            if c == "Lead":
                v = relation(source, v)
            values.append(v)
        w.writerow(values)
    # Notion's CSVs are UTF-8 with a byte order mark.
    return "﻿" + out.getvalue()


def row_page(title: str, cols: list[str], row: dict, path: str) -> str:
    lines = [f"# {title}", ""]
    for c in cols[1:]:
        v = row[c]
        if c == "Lead":
            v = relation(path, v)
        lines.append(f"{c}: {v}")
    text = "\n".join(lines) + "\n"
    body = row.get("body")
    if body:
        text += "\n" + body(path)
    return text


# --------------------------------------------------------------------------
# Pages


def root_page() -> str:
    s = ROOT_MD
    return f"""# Dela's Caravan Notes

<aside>
💧 **Water first.** Every dram this caravan carries is owed to someone. If it isn't in the {link(s, 'Salt Road Ledger', LEDGER_CSV)}, it didn't happen, and if it isn't on Ysra's linen, the Salt Courts won't believe it did.

</aside>

These are my working notes for the autumn crossing of the Salt Road: Glassreach out to the Salt Courts with a load of glass, and home again with water bought at the Well of Osk. Oren runs the caravan; I run what it eats, drinks and owes.

![salt-road-map.png]({href(s, MAP_PNG)})

## Pages

- {link(s, 'Salt Road Ledger', LEDGER_CSV)}: every leg, the drams we budget for it, and how it went.
- {link(s, 'Caravan Roster', ROSTER_CSV)}: who is on the road with us, their house, and their ration.
- {link(s, 'Supplies', SUPPLIES_MD)}: the casks, the stores, and the checklist before each waystation.
- {link(s, 'Storm Protocol', STORM_MD)}: what we do when the horizon goes brown.

<details>
<summary>How water debts work at the Salt Courts</summary>

The Well of Osk is the only deep well between Glassreach and the southern salt pans, and the seven merchant houses of the Salt Courts govern it together. Nobody buys water outright. You draw it against a house's credit, and the house writes the debt in drams.

The debt isn't real until a Linen-Keeper has stitched it onto linen, because paper cracks in the dry and ink fades in the glare. A debt-cloth is read aloud at the Courts at every Closing, when both moons rise together, and what is owed falls due then.

This crossing we owe House Varn 160 drams. It's on Ysra's cloth, and it's on {link(s, 'Leg 5', leg_md(LEGS[4]['Leg']))}.

</details>
"""


def storm_page() -> str:
    s = STORM_MD
    return f"""# Storm Protocol

A dust wall on the Salt Road can bury a wagon in an afternoon and take a caravan's water with it. These are the steps we follow the moment Tamsin flashes three from the ridge, or anyone sees the horizon go brown. Oren calls it; everyone else follows it without asking why.

1. Circle the wagons nose-to-tail, downwind side closed, the casks in the middle.
2. Hobble the dune-oxen and hood them. Brannoc does this, nobody else.
3. Close every cask vent and lash the condenser cloths flat.
4. Veils on. Count heads, then count casks, and say both numbers out loud.
5. Ysra seals the linen case and keeps it on her body until the wind drops.

<aside>
⚠️ Never open a cask while the wind is up. Sand in the seal costs more water than thirst does.

</aside>

## After it passes

Dig out the wagon wheels before the beasts, and the beasts before the casks. Then sound every cask and write the count in {link(s, 'Supplies', SUPPLIES_MD)}. If we lost water, it goes in the {link(s, 'Salt Road Ledger', LEDGER_CSV)} as its own line in that leg's notes.

Storms come more often near the Closing. {link(s, 'Reading the Moons', MOONS_MD)} explains how Oren sees them coming.
"""


def moons_page() -> str:
    s = MOONS_MD
    return f"""# Reading the Moons

Kessari has two moons. Ilu is large, pale and slow; she takes most of a season to cross the sky and lights the glass of the Mirror Flats like day. Thane is small, red and fast, up and down twice in a night, and he is the one the striders watch.

When both rise together it is called the Closing. The air goes still for a night, and then the wind turns hard from the south for three or four days. Most of the worst dust walls on the Salt Road come in the days after a Closing.

Oren's rule: be out of the mountain passes, and within a day of a waystation, before the Closing. The next one falls on the night of October 28. Back to the {link(s, 'Storm Protocol', STORM_MD)}.
"""


def supplies_page() -> str:
    s = SUPPLIES_MD
    return f"""# Supplies

What the caravan carries out of Glassreach, and what has to come home. I recount the casks at every waystation; the numbers below are from the last count at the Salt Courts, before the dust delay on {link(s, 'Leg 6', leg_md(LEGS[5]['Leg']))}.

## Before we leave a waystation

- [x] Count the casks and sound each one for leaks
- [x] Check the condenser cloths on every wagon
- [x] Reseal cask nineteen (Ash)
- [ ] Re-wax the linen ledger case
- [ ] Buy salt for the dune-oxen at Dunmark
- [ ] Trade two glass lenses for lamp oil

## Stores

| Item | On hand | Needed for the return | Notes |
| --- | --- | --- | --- |
| Water casks (40 drams each) | 38 | 42 | Four bought at the Well of Osk on House Varn's credit |
| Dried dates (sacks) | 11 | 12 |  |
| Salt blocks | 6 | 4 | Surplus to sell in Glassreach |
| Condenser cloths | 14 | 14 |  |
| Sand veils | 9 | 7 |  |
| Lamp oil (flasks) | 3 | 8 | Short; see the checklist |

The return legs in the {link(s, 'Salt Road Ledger', LEDGER_CSV)} need about 1,420 drams. The {link(s, 'Storm Protocol', STORM_MD)} says to keep six casks in reserve on top of that, which is why we are four short and why I'm not sleeping well.

Back to {link(s, "Dela's Caravan Notes", ROOT_MD)}.
"""


# --------------------------------------------------------------------------
# The route map (a PNG, drawn pixel by pixel)

W, H = 720, 420

FONT = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
    "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
    " ": ["00000"] * 7,
}


class Canvas:
    def __init__(self, w: int, h: int):
        self.w, self.h = w, h
        self.px = bytearray(w * h * 3)

    def set(self, x: int, y: int, c: tuple[int, int, int]) -> None:
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 3
            self.px[i : i + 3] = bytes(c)

    def disc(self, cx: float, cy: float, r: float, c) -> None:
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    self.set(x, y, c)

    def ellipse(self, cx, cy, rx, ry, c) -> None:
        for y in range(int(cy - ry), int(cy + ry) + 1):
            for x in range(int(cx - rx), int(cx + rx) + 1):
                if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1:
                    self.set(x, y, c)

    def rect(self, x0, y0, x1, y1, c) -> None:
        for y in range(y0, y1):
            for x in range(x0, x1):
                self.set(x, y, c)

    def line(self, a, b, width, c, dash: float = 0) -> None:
        (x0, y0), (x1, y1) = a, b
        n = int(math.hypot(x1 - x0, y1 - y0))
        for i in range(n + 1):
            if dash and (i // dash) % 2:
                continue
            t = i / max(n, 1)
            self.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, c)

    def text(self, x: int, y: int, s: str, scale: int, c) -> None:
        for ch in s.upper():
            glyph = FONT[ch]
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == "1":
                        self.rect(x + gx * scale, y + gy * scale,
                                  x + (gx + 1) * scale, y + (gy + 1) * scale, c)
            x += 6 * scale

    def png(self) -> bytes:
        raw = b"".join(
            b"\x00" + bytes(self.px[y * self.w * 3 : (y + 1) * self.w * 3])
            for y in range(self.h)
        )

        def chunk(kind: bytes, data: bytes) -> bytes:
            return (struct.pack(">I", len(data)) + kind + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

        head = struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head)
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def route_map() -> bytes:
    cv = Canvas(W, H)
    sands = [(236, 206, 150), (228, 192, 132), (219, 178, 116), (208, 162, 100)]
    for y in range(H):
        for x in range(W):
            # Posterised dune ripples: smooth bands compress well and read as sand.
            v = math.sin(x * 0.035 + math.sin(y * 0.045) * 2.2 + y * 0.018)
            v += 0.6 * math.sin(x * 0.011 - y * 0.027)
            band = min(3, max(0, int((v + 1.6) / 0.85)))
            i = (y * W + x) * 3
            cv.px[i : i + 3] = bytes(sands[band])

    ink = (74, 42, 20)
    road = (122, 52, 28)
    # Frame.
    for t in range(4):
        cv.rect(t, t, W - t, t + 1, ink)
        cv.rect(t, H - t - 1, W - t, H - t, ink)
        cv.rect(t, t, t + 1, H - t, ink)
        cv.rect(W - t - 1, t, W - t, H - t, ink)

    # The Mirror Flats: a pale glass plain.
    cv.ellipse(205, 250, 70, 34, (244, 232, 206))
    cv.ellipse(205, 250, 50, 22, (250, 243, 226))
    # Mountains around Thane's Gate.
    for mx, my, s in [(370, 160, 34), (410, 150, 40), (452, 168, 30), (340, 178, 24)]:
        for y in range(my - s, my + 1):
            half = (y - (my - s)) * 0.9
            cv.rect(int(mx - half), y, int(mx + half), y + 1, (150, 104, 66))
        cv.rect(mx - 3, my - s, mx + 3, my - s + 4, (240, 230, 214))

    stops = [
        (80, 300, "GLASSREACH"),
        (205, 250, "MIRROR FLATS"),
        (300, 220, "CINDER WELLS"),
        (400, 190, "THANE'S GATE"),
        (510, 235, "DUNMARK"),
        (630, 270, "SALT COURTS"),
    ]
    for (a, b) in zip(stops, stops[1:]):
        cv.line(a[:2], b[:2], 5, road, dash=14)

    # Glassreach: a glass city.
    cv.disc(80, 300, 22, (60, 120, 124))
    cv.disc(80, 300, 17, (126, 200, 196))
    cv.disc(74, 294, 6, (225, 246, 244))
    # Waystations.
    for x, y, _ in stops[1:5]:
        cv.disc(x, y, 9, ink)
        cv.disc(x, y, 5, (240, 222, 186))
    # The Salt Courts: seven houses around the Well of Osk.
    for k in range(7):
        a = k * 2 * math.pi / 7 - math.pi / 2
        hx, hy = 630 + 24 * math.cos(a), 270 + 24 * math.sin(a)
        cv.rect(int(hx - 6), int(hy - 6), int(hx + 6), int(hy + 6), ink)
        cv.rect(int(hx - 4), int(hy - 4), int(hx + 4), int(hy + 4), (246, 244, 236))
    cv.disc(630, 270, 9, (30, 70, 120))
    cv.disc(628, 268, 3, (120, 170, 220))

    # Labels.
    cv.text(28, 330, "GLASSREACH", 2, ink)
    cv.text(150, 280, "MIRROR FLATS", 2, ink)
    cv.text(250, 236, "CINDER WELLS", 2, ink)
    cv.text(350, 206, "THANE'S GATE", 2, ink)
    cv.text(470, 252, "DUNMARK", 2, ink)
    cv.text(562, 310, "SALT COURTS", 2, ink)
    cv.text(574, 332, "WELL OF OSK", 2, (30, 70, 120))
    cv.text(24, 22, "THE SALT ROAD", 4, ink)

    # The moons: Ilu, large and pale; Thane, small and red.
    cv.disc(620, 70, 38, (205, 196, 176))
    cv.disc(620, 70, 34, (246, 240, 224))
    cv.disc(608, 60, 6, (232, 224, 204))
    cv.disc(636, 84, 4, (232, 224, 204))
    cv.disc(676, 112, 12, (150, 44, 30))
    cv.disc(676, 112, 9, (196, 70, 48))
    cv.text(606, 118, "ILU", 2, ink)
    cv.text(650, 132, "THANE", 2, ink)
    return cv.png()


# --------------------------------------------------------------------------
# Build


def files() -> dict[str, bytes]:
    out: dict[str, str | bytes] = {
        ROOT_MD: root_page(),
        STORM_MD: storm_page(),
        MOONS_MD: moons_page(),
        SUPPLIES_MD: supplies_page(),
        MAP_PNG: route_map(),
        LEDGER_CSV: csv_text(LEDGER_VIEW, LEGS, LEDGER_CSV),
        LEDGER_ALL: csv_text(LEDGER_COLS, LEGS, LEDGER_ALL),
        ROSTER_CSV: csv_text(ROSTER_VIEW, PEOPLE, ROSTER_CSV),
        ROSTER_ALL: csv_text(ROSTER_COLS, PEOPLE, ROSTER_ALL),
    }
    for leg in LEGS:
        p = leg_md(leg["Leg"])
        out[p] = row_page(leg["Leg"], LEDGER_COLS, leg, p)
    for person in PEOPLE:
        p = person_md(person["Name"])
        out[p] = row_page(person["Name"], ROSTER_COLS, person, p)
    return {k: v.encode("utf-8") if isinstance(v, str) else v for k, v in out.items()}


def write_zip(path: Path, entries: dict[str, bytes], compress: int) -> None:
    with zipfile.ZipFile(path, "w") as z:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.compress_type = compress
            info.external_attr = 0o644 << 16
            z.writestr(info, entries[name])


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=here.parent / "notion-sample-export.zip")
    ap.add_argument("--workdir", type=Path,
                    help="where to build the export folder (kept); default: a temp folder")
    args = ap.parse_args()

    export_id = nid("export")
    uuid = f"{export_id[:8]}-{export_id[8:12]}-{export_id[12:16]}-{export_id[16:20]}-{export_id[20:]}"
    part_name = f"Export-{uuid}-Part-1.zip"

    tmp = None
    work = args.workdir
    if work is None:
        tmp = tempfile.TemporaryDirectory()
        work = Path(tmp.name)
    tree = work / f"Export-{uuid}"
    if tree.exists():
        shutil.rmtree(tree)
    entries = files()
    for name, data in entries.items():
        p = tree / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    # Read the tree back, so the zip is exactly the folder that was built.
    built = {p.relative_to(tree).as_posix(): p.read_bytes() for p in tree.rglob("*") if p.is_file()}
    part = work / part_name
    write_zip(part, built, zipfile.ZIP_DEFLATED)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_zip(args.out, {part_name: part.read_bytes()}, zipfile.ZIP_DEFLATED)
    if tmp:
        tmp.cleanup()
    print(f"wrote {args.out} ({args.out.stat().st_size:,} bytes, {len(built)} files in {part_name})")


if __name__ == "__main__":
    main()
