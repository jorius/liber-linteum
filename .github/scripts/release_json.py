"""Write the site's release.json from the latest published GitHub release.

Usage: release_json.py <out file>   (needs `gh` and GH_TOKEN)
Reads the release's assets, SHA256SUMS and virustotal.json (both written by
the release workflow). With no published release, writes nothing, and the site
says the first release is coming. Shape: site/release.example.json.
Standard library only.
"""

import json
import os
import subprocess
import sys
import tempfile

KINDS = {
    "Liber-Linteum_amd64.deb": ("linux", "deb"),
    "Liber-Linteum_amd64.AppImage": ("linux", "appimage"),
    "Liber-Linteum_x64-setup.exe": ("windows", "exe"),
    "Liber-Linteum_x64.msi": ("windows", "msi"),
    "Liber-Linteum_universal.dmg": ("macos", "dmg"),
    "The-Moons-of-Kessari.zip": ("any", "sample-vault"),
}


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def main():
    out = sys.argv[1]
    try:
        release = json.loads(gh("release", "view", "--json", "tagName,publishedAt,assets"))
    except subprocess.CalledProcessError:
        print("No published release yet: release.json not written.")
        return
    tag = release["tagName"]
    with tempfile.TemporaryDirectory() as tmp:
        gh("release", "download", tag, "-p", "SHA256SUMS", "-p", "virustotal.json", "-D", tmp)
        with open(os.path.join(tmp, "SHA256SUMS")) as f:
            sums = {n.strip().lstrip("*"): d for d, n in (l.split(None, 1) for l in f if l.strip())}
        vt_path = os.path.join(tmp, "virustotal.json")
        vt = json.load(open(vt_path)) if os.path.exists(vt_path) else {}
    files = []
    for asset in release["assets"]:
        name = asset["name"]
        if name not in KINDS or name not in sums:
            continue
        os_name, kind = KINDS[name]
        files.append(
            {
                "os": os_name,
                "kind": kind,
                "name": name,
                "size": asset["size"],
                "sha256": sums[name],
                "virustotal": vt.get(name),
            }
        )
    data = {"version": tag.lstrip("v"), "published": release["publishedAt"][:10], "files": files}
    with open(out, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"release.json for {tag}: {len(files)} files")


if __name__ == "__main__":
    main()
