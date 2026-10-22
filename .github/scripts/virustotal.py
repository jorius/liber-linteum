"""Submit the release's installers to VirusTotal; print {file name: report URL}.

Reads the names and SHA-256 sums from a SHA256SUMS file (sha256sum format) in
the current directory. A file VirusTotal already knows isn't uploaded again.
Without VT_API_KEY every link is null (the release still works). The public
API allows 4 requests a minute, so requests are spaced out.
Standard library only.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

API = "https://www.virustotal.com/api/v3"
SCANNED = (".deb", ".AppImage", ".exe", ".msi", ".dmg")
DIRECT_LIMIT = 32 * 1024 * 1024  # larger files need an upload URL
SPACING = 16  # seconds between requests (4 a minute)

_last = 0.0


def request(method, url, key, body=None, headers=None):
    global _last
    wait = _last + SPACING - time.monotonic()
    if _last and wait > 0:
        time.sleep(wait)
    _last = time.monotonic()
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("x-apikey", key)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, None


def upload(path, key):
    url = f"{API}/files"
    if os.path.getsize(path) > DIRECT_LIMIT:
        status, data = request("GET", f"{API}/files/upload_url", key)
        if status != 200:
            raise RuntimeError(f"upload_url: HTTP {status}")
        url = data["data"]
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        content = f.read()
    name = os.path.basename(path)
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    status, _ = request(
        "POST", url, key, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    if status != 200:
        raise RuntimeError(f"upload {name}: HTTP {status}")


def main():
    sums = sys.argv[1]
    key = os.environ.get("VT_API_KEY", "").strip()
    out = {}
    with open(sums) as f:
        entries = [line.split(None, 1) for line in f if line.strip()]
    for digest, name in entries:
        name = name.strip().lstrip("*")
        if not name.endswith(SCANNED):
            continue
        if not key:
            out[name] = None
            continue
        report = f"https://www.virustotal.com/gui/file/{digest}"
        try:
            status, _ = request("GET", f"{API}/files/{digest}", key)
            if status == 404:
                upload(name, key)
            elif status != 200:
                raise RuntimeError(f"lookup {name}: HTTP {status}")
            out[name] = report
        except Exception as err:  # a scan never blocks a release
            print(f"::warning::VirusTotal: {err}", file=sys.stderr)
            out[name] = None
    if not key:
        print("::warning::VT_API_KEY is not set: no VirusTotal reports", file=sys.stderr)
    json.dump(out, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
