"""Release notes for a draft release: downloads, checksums, VirusTotal links.

Usage: release_notes.py <tag> <SHA256SUMS> <virustotal.json>
Standard library only. The changes themselves are written by hand in the draft.
"""

import json
import sys

LABELS = {
    "Liber-Linteum_amd64.deb": "Linux — Debian, Ubuntu (.deb)",
    "Liber-Linteum_amd64.AppImage": "Linux — any distribution (.AppImage)",
    "Liber-Linteum_x64-setup.exe": "Windows — installer (.exe)",
    "Liber-Linteum_x64.msi": "Windows — package (.msi)",
    "Liber-Linteum_universal.dmg": "macOS 12 or later — Apple silicon and Intel (.dmg)",
    "The-Moons-of-Kessari.zip": "Sample vault — *The Moons of Kessari*",
    "Notion-Sample-Export.zip": "Sample Notion export (try File → Import from Notion)",
}


def main():
    tag, sums_path, vt_path = sys.argv[1:4]
    with open(sums_path) as f:
        sums = {n.strip().lstrip("*"): d for d, n in (l.split(None, 1) for l in f if l.strip())}
    with open(vt_path) as f:
        vt = json.load(f)
    lines = [
        f"## Liber Linteum {tag.lstrip('v')}",
        "",
        "_Write what changed here before publishing._",
        "",
        "### Downloads",
        "",
        "| File | What | SHA-256 | VirusTotal |",
        "|---|---|---|---|",
    ]
    for name, digest in sums.items():
        if name == "virustotal.json":
            continue
        link = vt.get(name)
        lines.append(
            f"| `{name}` | {LABELS.get(name, '')} | `{digest[:12]}…` | "
            + (f"[report]({link})" if link else "—")
            + " |"
        )
    lines += [
        "",
        "Full checksums are in `SHA256SUMS` (`sha256sum -c SHA256SUMS`).",
        "",
        "### The installers aren't code-signed yet",
        "",
        "- **Windows** may say \"Windows protected your PC\": choose **More info**, then **Run anyway**.",
        "- **macOS** may say the app can't be opened: open **System Settings → Privacy & Security** and choose **Open Anyway** (or right-click the app and choose **Open** on older macOS).",
        "- **Linux**: `sudo apt install ./Liber-Linteum_amd64.deb`, or make the AppImage executable and run it.",
        "",
        "Liber Linteum makes no network requests. An idea by José Meza, built by Jose Ríos.",
    ]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
